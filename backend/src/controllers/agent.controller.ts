import { Request, Response, NextFunction } from 'express';
import { relayAgent } from '../agent';
import { membershipService, procurementIdentityService } from '../identity';
import { relayOrchestrator } from '../orchestration';
import { paymentService } from '../payment';

/**
 * Terminal run codes that mean "Relay understood enough to know it needs
 * clarification" rather than a server failure. Served as HTTP 200 with
 * success:false so blocked-run artifacts reach the client intact.
 */
const CLARIFICATION_ERROR_CODES = new Set([
  'UNMAPPABLE_PRODUCT',
  'AMBIGUOUS_REFERENCE',
  'MISSING_QUANTITY',
  'MISSING_UNIT',
  'NEGATIVE_QUANTITY',
  'UNSUPPORTED_UNIT',
  'SCHEMA_VIOLATION',
  'PROMPT_INJECTION_DETECTED',
  'NO_TOOL_CALL',
  'NO_TOOL_CALLS',
  'EMPTY_REQUEST',
  'INTENT_RESOLUTION_FAILED',
  'INTENT_RESOLUTION_MISMATCH',
]);

export class AgentController {
  /**
   * POST /api/agent/run
   * Triggers the autonomous agent loop to fulfill a procurement request.
   */
  public async run(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        message,
        requestId,
        metadata,
      } = req.body;

      // IDOR Defense: an authenticated caller cannot spoof another resident.
      if (req.residentId && req.body.residentId && req.body.residentId !== req.residentId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: You cannot initiate procurement for another resident',
          },
        });
        return;
      }

      // Pure input validation runs before identity resolution so malformed
      // requests fail as 400 regardless of onboarding state.
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: "Field 'message' is required and must not be empty.",
          },
        });
        return;
      }

      if (message.length > 5000) {
        res.status(400).json({
          success: false,
          error: {
            code: 'REQUEST_TOO_LARGE',
            message: "Field 'message' exceeds maximum allowed length of 5000 characters.",
          },
        });
        return;
      }

      // Identity is derived ONLY from the validated session. There is no
      // anonymous or seed fallback: an unauthenticated caller is rejected by
      // requireAuth before reaching this handler.
      const residentId = req.residentId;
      if (!residentId || !req.user) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
        });
        return;
      }

      let societyId = req.body.societyId;
      const mem = await membershipService.getMembershipByUserId(req.user.id);
      const membershipSocietyId = mem?.societyId;
      if (!societyId && membershipSocietyId) {
        societyId = membershipSocietyId;
      }
      // IDOR Defense: a member cannot procure for another society.
      if (societyId && membershipSocietyId && societyId !== membershipSocietyId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: You cannot initiate procurement for another society',
          },
        });
        return;
      }

      // P0 identity bridge: persist the authenticated session's canonical
      // society/resident/mandate rows (same soc_*/res_*/mandate_* ids) so the
      // Prisma-backed procurement engine resolves them. Throws a controlled
      // 422 ONBOARDING_INCOMPLETE when membership/society is unresolvable.
      await procurementIdentityService.ensureCanonicalIdentities(req.user.id);
      if (!societyId) {
        societyId = membershipSocietyId;
      }

      const result = await relayAgent.run({
        residentId,
        societyId,
        message,
        requestId,
        metadata,
      });

      // Blocked-clarification codes stay HTTP 200 with success:false: the
      // API call itself succeeded and the run artifacts (steps, honest
      // message) must reach the client intact. A 4xx/5xx here would make the
      // frontend API client throw the body away and lose the blocked-run
      // evidence. Mirrors the frontend CLARIFICATION_CODES set.
      const errCode = result.error?.code;
      const isClarification =
        errCode !== undefined && CLARIFICATION_ERROR_CODES.has(errCode);
      const statusCode =
        result.success || isClarification
          ? 200
          : errCode === 'AGENT_STEP_LIMIT_EXCEEDED'
            ? 429
            : 500;
      res.status(statusCode).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/agent/workflow/:id/cancel
   * Cancels an in-flight mission owned by the session resident. Cancellation
   * is refused once a payment has SUCCEEDED (money moved cannot be recalled
   * by abandoning the record) and for terminal missions.
   */
  public async cancelWorkflow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const workflow = relayOrchestrator.getWorkflow(req.params.id);
      if (!workflow) {
        res.status(404).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_FOUND', message: `Workflow '${req.params.id}' not found` },
        });
        return;
      }
      if (workflow.residentReference !== req.residentId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: workflow belongs to another resident',
          },
        });
        return;
      }
      if (workflow.entities.paymentId) {
        const payment = paymentService.getPayment(workflow.entities.paymentId);
        if (payment && payment.status === 'SUCCEEDED') {
          res.status(409).json({
            success: false,
            error: {
              code: 'CANCELLATION_REJECTED_AFTER_PAYMENT',
              message: 'Cannot cancel: payment already executed for this mission',
            },
          });
          return;
        }
      }
      try {
        const cancelled = relayOrchestrator.cancelWorkflow(
          workflow.id,
          typeof req.body?.reason === 'string' ? req.body.reason : 'Resident requested cancellation'
        );
        res.status(200).json({
          success: true,
          data: {
            workflowId: cancelled.id,
            status: cancelled.status,
            currentStage: cancelled.currentStage,
          },
        });
      } catch (err: any) {
        res.status(409).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_CANCELLABLE', message: err.message },
        });
        return;
      }
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/agent/workflow/:id/restore
   * Restores a mission owned by the session resident from its durable
   * record (e.g. after a backend restart evicted the in-memory registry).
   * Ownership is checked against the DURABLE record, so a restart never
   * widens access: a resident can only restore their own missions.
   */
  public async restoreWorkflow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const restored = await relayOrchestrator.restoreWorkflow(req.params.id);
      if (!restored) {
        res.status(404).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_FOUND', message: `Workflow '${req.params.id}' not found` },
        });
        return;
      }
      if (restored.residentReference !== req.residentId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: workflow belongs to another resident',
          },
        });
        return;
      }
      res.status(200).json({
        success: true,
        data: {
          workflowId: restored.id,
          status: restored.status,
          currentStage: restored.currentStage,
          workflowVersion: restored.workflowVersion,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

export const agentController = new AgentController();
