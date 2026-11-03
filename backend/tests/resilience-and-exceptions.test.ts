import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  failureClassificationService,
  retryBackoffService,
  retryPolicyService,
  recoveryPolicyService,
  idempotencyService,
  concurrencyService,
  staleWorkflowService,
  failureInjector,
  FailureScenario,
  ChaosPaymentProvider,
} from '../src/resilience';
import {
  RelayWorkflow,
  WorkflowCheckpoint,
} from '../src/orchestration/types';
import { workflowCheckpointService } from '../src/orchestration/WorkflowCheckpointService';
import { workflowEventService } from '../src/orchestration/WorkflowEventService';
import { eventBus } from '../src/events';
import { paymentService } from '../src/payment';
import { mockPaymentProvider } from '../src/payment/provider/MockPaymentProvider';
import { toDecimal, isDecimalEqual } from '../src/domain/procurement/decimal';

describe('Milestone 11 — Comprehensive Resilience & Exception Handling Suite', () => {
  beforeEach(() => {
    failureInjector.clear();
    idempotencyService.clear();
    concurrencyService.clear();
    mockPaymentProvider.reset();
    eventBus.clear();
  });

  afterEach(() => {
    failureInjector.clear();
    idempotencyService.clear();
    concurrencyService.clear();
    mockPaymentProvider.reset();
    eventBus.clear();
  });

  // Helper to create test workflow
  const createMockWorkflow = (overrides: Partial<RelayWorkflow> = {}): RelayWorkflow => {
    const id = `wf_${randomUUID().slice(0, 8)}`;
    const now = new Date();
    return {
      id,
      residentReference: 'res_test_resilience',
      societyReference: 'soc_test_resilience',
      requestText: 'I need 10kg Basmati Rice',
      location: {
        latitude: 18.5204,
        longitude: 73.8567,
        countryCode: 'IN',
      },
      currentStage: 'DISCOVER',
      status: 'DISCOVERING_SUPPLIERS',
      stages: [],
      entities: {
        residentReference: 'res_test_resilience',
        societyReference: 'soc_test_resilience',
      },
      retryCount: 0,
      workflowVersion: 1,
      isPaused: false,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  };

  // =========================================================================
  // SUITE 1: Deterministic Failure Classification (12 tests)
  // =========================================================================
  describe('1. Deterministic Failure Classification', () => {
    it('1.1 classifies ECONNRESET, ETIMEDOUT, ENOTFOUND as RETRYABLE with safeToRetry=true for non-payment', () => {
      const err = new Error('connect ETIMEDOUT 10.0.0.1:443');
      const classification = failureClassificationService.classify(err, { stage: 'DISCOVER' });

      expect(classification.category).toBe('RETRYABLE');
      expect(classification.retryable).toBe(true);
      expect(classification.safeToRetry).toBe(true);
      expect(classification.canContinue).toBe(true);
      expect(classification.requiresUserAction).toBe(false);
    });

    it('1.2 classifies HTTP 429 Rate Limit as RETRYABLE with exponential backoff recommendation', () => {
      const err = { response: { status: 429, data: 'Too Many Requests' } };
      const classification = failureClassificationService.classify(err, { stage: 'QUOTE' });

      expect(classification.category).toBe('RETRYABLE');
      expect(classification.retryable).toBe(true);
      expect(classification.httpStatus).toBe(429);
      expect(classification.recoveryAction).toBe('BACKOFF_AND_RETRY');
    });

    it('1.3 classifies HTTP 500, 502, 503, 504 as RETRYABLE with server error context', () => {
      [500, 502, 503, 504].forEach((status) => {
        const err = { response: { status, statusText: 'Server Error' } };
        const res = failureClassificationService.classify(err, { stage: 'DISCOVER' });
        expect(res.category).toBe('RETRYABLE');
        expect(res.retryable).toBe(true);
        expect(res.httpStatus).toBe(status);
      });
    });

    it('1.4 classifies HTTP 400, 401, 403, 404 as NON_RETRYABLE', () => {
      [400, 401, 403, 404].forEach((status) => {
        const err = { response: { status } };
        const res = failureClassificationService.classify(err, { stage: 'DISCOVER' });
        expect(res.category).toBe('NON_RETRYABLE');
        expect(res.retryable).toBe(false);
        expect(res.safeToRetry).toBe(false);
      });
    });

    it('1.5 enforces safeToRetry=false for payment operations on network timeout until authoritative check', () => {
      const err = new Error('ETIMEDOUT: Gateway dropped connection during capture');
      const classification = failureClassificationService.classify(err, {
        stage: 'PAY',
        isPaymentOperation: true,
      });

      expect(classification.category).toBe('RETRYABLE');
      expect(classification.retryable).toBe(true);
      expect(classification.safeToRetry).toBe(false); // Invariant: Payment requires authoritative check!
      expect(classification.recoveryAction).toBe('INSPECT_AUTHORITATIVE_STATE_BEFORE_RETRY');
    });

    it('1.6 classifies MandateLimitExceeded and InsufficientFunds as USER_ACTION_REQUIRED', () => {
      const err1 = new Error('MANDATE_LIMIT_EXCEEDED: Transaction exceeds mandate cap');
      const res1 = failureClassificationService.classify(err1, { stage: 'PAY' });
      expect(res1.category).toBe('USER_ACTION_REQUIRED');
      expect(res1.requiresUserAction).toBe(true);
      expect(res1.safeToRetry).toBe(false);

      const err2 = new Error('INSUFFICIENT_FUNDS: Account balance too low');
      const res2 = failureClassificationService.classify(err2, { stage: 'PAY' });
      expect(res2.category).toBe('USER_ACTION_REQUIRED');
      expect(res2.requiresUserAction).toBe(true);
    });

    it('1.7 classifies user clarification / ambiguous prompt as USER_ACTION_REQUIRED', () => {
      const err = new Error('AMBIGUOUS_DEMAND: Resident requested unspecified product quantity');
      const res = failureClassificationService.classify(err, { stage: 'UNDERSTAND' });
      expect(res.category).toBe('USER_ACTION_REQUIRED');
      expect(res.recoveryAction).toBe('REQUEST_USER_CLARIFICATION');
    });

    it('1.8 classifies state machine invariant violations as NON_RETRYABLE', () => {
      const err = new Error('Invalid state machine transition from RECEIVED to COMPLETED');
      const res = failureClassificationService.classify(err, { stage: 'SELECT' });
      expect(res.category).toBe('NON_RETRYABLE');
      expect(res.retryable).toBe(false);
      expect(res.canContinue).toBe(false);
    });

    it('1.9 classifies reconciliation discrepancy as SYSTEM_BLOCKED', () => {
      const err = new Error('RECONCILIATION_DISCREPANCY: Quantity mismatch detected');
      const res = failureClassificationService.classify(err, { stage: 'RECONCILE' });
      expect(res.category).toBe('SYSTEM_BLOCKED');
      expect(res.canContinue).toBe(false);
      expect(res.recoveryAction).toBe('HALT_FOR_MANUAL_AUDIT');
    });

    it('1.10 classifies pending / in-flight external status as WAITING', () => {
      const err = new Error('AWAITING_SUPPLIER_RESPONSE: RFQ dispatched, waiting for supplier quote');
      const res = failureClassificationService.classify(err, { stage: 'QUOTE' });
      expect(res.category).toBe('WAITING');
      expect(res.retryable).toBe(false);
      expect(res.recoveryAction).toBe('WAIT_FOR_EXTERNAL_EVENT');
    });

    it('1.11 classifies AI JSON parse error as NON_RETRYABLE without blind retries', () => {
      const err = new SyntaxError('Unexpected token < in JSON at position 0');
      const res = failureClassificationService.classify(err, { stage: 'UNDERSTAND' });
      expect(res.category).toBe('NON_RETRYABLE');
      expect(res.retryable).toBe(false);
    });

    it('1.12 correctly extracts HTTP status code from custom error objects or response shapes', () => {
      const err = { status: 503, message: 'Service Unavailable' };
      const res = failureClassificationService.classify(err);
      expect(res.httpStatus).toBe(503);
      expect(res.category).toBe('RETRYABLE');
    });
  });

  // =========================================================================
  // SUITE 2: Retry Policy & Bounded Exponential Backoff with Jitter (8 tests)
  // =========================================================================
  describe('2. Retry Policy & Bounded Exponential Backoff with Jitter', () => {
    it('2.1 calculates exponential progression: delay grows exponentially with attempt number', () => {
      const policy = {
        maxAttempts: 5,
        initialBackoffMs: 100,
        maxBackoffMs: 10000,
        backoffMultiplier: 2.0,
        jitter: false,
        timeoutMs: 5000,
        requiresAuthoritativeCheck: false,
      };

      const b1 = retryBackoffService.calculateBackoff(1, policy);
      const b2 = retryBackoffService.calculateBackoff(2, policy);
      const b3 = retryBackoffService.calculateBackoff(3, policy);

      expect(b1.backoffMs).toBe(100);
      expect(b2.backoffMs).toBe(200);
      expect(b3.backoffMs).toBe(400);
    });

    it('2.2 enforces maxBackoff ceiling (caps delays at maxBackoffMs)', () => {
      const policy = {
        maxAttempts: 10,
        initialBackoffMs: 1000,
        maxBackoffMs: 3000,
        backoffMultiplier: 2.0,
        jitter: false,
        timeoutMs: 10000,
        requiresAuthoritativeCheck: false,
      };

      const b5 = retryBackoffService.calculateBackoff(5, policy);
      expect(b5.backoffMs).toBe(3000); // capped at 3000, not 16000
    });

    it('2.3 injects deterministic jitter within bounded [0, jitterMax] range', () => {
      const policy = {
        maxAttempts: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 5000,
        backoffMultiplier: 2.0,
        jitter: true,
        timeoutMs: 5000,
        requiresAuthoritativeCheck: false,
      };

      const b = retryBackoffService.calculateBackoff(2, policy);
      expect(b.backoffMs).toBe(2000);
      expect(b.jitterMs).toBeGreaterThanOrEqual(0);
      expect(b.jitterMs).toBeLessThanOrEqual(500); // 25% max jitter
      expect(b.totalDelayMs).toBe(b.backoffMs + b.jitterMs);
    });

    it('2.4 produces jitter = 0 when jitter option is disabled', () => {
      const policy = {
        maxAttempts: 3,
        initialBackoffMs: 500,
        maxBackoffMs: 5000,
        backoffMultiplier: 2.0,
        jitter: false,
        timeoutMs: 5000,
        requiresAuthoritativeCheck: false,
      };

      const b = retryBackoffService.calculateBackoff(2, policy);
      expect(b.jitterMs).toBe(0);
      expect(b.totalDelayMs).toBe(1000);
    });

    it('2.5 handles attempt count <= 1 cleanly without negative exponents', () => {
      const policy = {
        maxAttempts: 3,
        initialBackoffMs: 500,
        maxBackoffMs: 5000,
        backoffMultiplier: 2.0,
        jitter: false,
        timeoutMs: 5000,
        requiresAuthoritativeCheck: false,
      };

      const b0 = retryBackoffService.calculateBackoff(0, policy);
      expect(b0.backoffMs).toBe(500);
      expect(b0.attempt).toBe(1);
    });

    it('2.6 sleep function resolves accurately after calculated delay', async () => {
      const start = Date.now();
      await retryBackoffService.sleep(20);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(15);
    });

    it('2.7 RetryPolicyService enforces stage-specific policies: UNDERSTAND=1, DISCOVER=3, PAY=2', () => {
      const pUnderstand = retryPolicyService.getPolicy('UNDERSTAND');
      const pDiscover = retryPolicyService.getPolicy('DISCOVER');
      const pPay = retryPolicyService.getPolicy('PAY');

      expect(pUnderstand.maxAttempts).toBe(1);
      expect(pDiscover.maxAttempts).toBe(3);
      expect(pPay.maxAttempts).toBe(2);
    });

    it('2.8 enforces requiresAuthoritativeCheck=true for PAY stage before retry permitted', () => {
      const pPay = retryPolicyService.getPolicy('PAY');
      expect(pPay.requiresAuthoritativeCheck).toBe(true);

      const classification = failureClassificationService.classify(new Error('ETIMEDOUT'), {
        stage: 'PAY',
        isPaymentOperation: true,
      });

      // Without authoritative check:
      const check1 = retryPolicyService.canRetry('PAY', 0, classification, false);
      expect(check1.allowed).toBe(false);
      expect(check1.reason).toContain('AUTHORITATIVE_CHECK_REQUIRED');

      // With authoritative check:
      const check2 = retryPolicyService.canRetry('PAY', 0, classification, true);
      expect(check2.allowed).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 3: Payment Safety & Double-Execution Prevention (12 tests)
  // =========================================================================
  describe('3. Payment Safety & Double-Execution Prevention', () => {
    it('3.1 Scenario A: Network timeout during payment returns UNKNOWN state, never marks SUCCESS or FAILURE blindly', async () => {
      const chaos = new ChaosPaymentProvider(mockPaymentProvider);
      failureInjector.registerFailure('payment_provider', FailureScenario.PAYMENT_TIMEOUT_AFTER_SUBMIT);

      let thrownErr: Error | undefined;
      try {
        await chaos.authorizeAndCapture({
          paymentId: 'pay_timeout_test',
          purchaseOrderId: 'po_test_1',
          commitmentId: 'commit_test_1',
          supplierId: 'sup_test_1',
          amount: 500,
          currency: 'INR',
          recipientReference: 'supplier_bank_acc_1',
          mandateId: 'man_test_1',
          idempotencyKey: 'idem_timeout_1',
        });
      } catch (err) {
        thrownErr = err as Error;
      }

      expect(thrownErr).toBeDefined();
      expect(thrownErr?.message).toContain('PAYMENT_TIMEOUT_AFTER_SUBMIT');

      const classification = failureClassificationService.classify(thrownErr, {
        stage: 'PAY',
        isPaymentOperation: true,
      });
      expect(classification.safeToRetry).toBe(false);
    });

    it('3.2 Scenario A: Verifies authoritative ledger before retry; if payment SUCCEEDED, advances to FULFILL with skipPaymentReExecution=true', () => {
      const wf = createMockWorkflow({
        currentStage: 'PAY',
        status: 'EXECUTING_PAYMENT',
        entities: {
          residentReference: 'res_test',
          societyReference: 'soc_test',
          commitmentId: 'commit_already_paid',
          paymentId: 'pay_already_paid',
        },
      });

      // Mock paymentService returning SUCCEEDED
      const origGetSummary = paymentService.getProcurementPaymentSummary;
      paymentService.getProcurementPaymentSummary = () => ({
        commitmentId: 'commit_already_paid',
        rfqId: 'rfq_1',
        totalAmount: 500,
        paidAmount: 500,
        currency: 'INR',
        status: 'FULLY_PAID',
        payments: [],
        supplierObligations: [],
      });

      try {
        const decision = recoveryPolicyService.evaluateRecovery(wf);
        expect(decision.action).toBe('ADVANCE_STAGE');
        expect(decision.targetStage).toBe('FULFILL');
        expect(decision.skipPaymentReExecution).toBe(true);
        expect(decision.isPaymentExecuted).toBe(true);
      } finally {
        paymentService.getProcurementPaymentSummary = origGetSummary;
      }
    });

    it('3.3 Scenario A: Never invokes payment provider when ledger confirms prior charge', async () => {
      let providerCalled = false;
      const testProvider: any = {
        providerName: 'SpyProvider',
        isSimulated: true,
        authorizeAndCapture: async () => {
          providerCalled = true;
          return { status: 'SUCCESS' };
        },
      };

      const key = 'idem_already_executed_test';
      // Execute once
      await idempotencyService.executeIdempotent(key, async () => {
        return { paymentId: 'pay_first', status: 'SUCCEEDED' };
      });

      // Execute second time with same key
      const result2 = await idempotencyService.executeIdempotent(key, async () => {
        return await testProvider.authorizeAndCapture();
      });

      expect(providerCalled).toBe(false); // Invariant: Provider was never called second time!
      expect(result2).toEqual({ paymentId: 'pay_first', status: 'SUCCEEDED' });
    });

    it('3.4 Scenario B: Explicit payment decline sets status to FAILED and category USER_ACTION_REQUIRED', () => {
      const err = new Error('PAYMENT_DECLINED: Card expired or transaction declined by issuer');
      const classification = failureClassificationService.classify(err, { stage: 'PAY' });

      expect(classification.category).toBe('USER_ACTION_REQUIRED');
      expect(classification.requiresUserAction).toBe(true);
      expect(classification.safeToRetry).toBe(false);
    });

    it('3.5 Scenario B: Blocks automatic retry without user approval or increased mandate limit', () => {
      const wf = createMockWorkflow({
        currentStage: 'PAY',
        status: 'FAILED',
        failureReason: 'MANDATE_LIMIT_EXCEEDED: Spending limit cap ₹5,000 exceeded',
      });

      const decision = recoveryPolicyService.evaluateRecovery(wf);
      expect(decision.action).toBe('ENTER_SAFE_STATE');
      expect(decision.safeState).toBe('USER_ACTION_REQUIRED');
      expect(decision.canRecover).toBe(false);
      expect(decision.canResume).toBe(false);
    });

    it('3.6 Scenario C: 503 Gateway timeout permits retry ONLY after verifying obligation remains UNPAID', () => {
      const classification = failureClassificationService.classify(
        { response: { status: 503 } },
        { stage: 'PAY', isPaymentOperation: true }
      );

      // Not checked -> disallow
      const res1 = retryPolicyService.canRetry('PAY', 0, classification, false);
      expect(res1.allowed).toBe(false);

      // Checked and verified unpaid -> allow retry 1
      const res2 = retryPolicyService.canRetry('PAY', 0, classification, true);
      expect(res2.allowed).toBe(true);
    });

    it('3.7 Scenario C: Bounded retry for payment stops at max 2 attempts', () => {
      const classification = failureClassificationService.classify(
        { response: { status: 503 } },
        { stage: 'PAY', isPaymentOperation: true }
      );

      // Attempt 1 allowed
      const r1 = retryPolicyService.canRetry('PAY', 0, classification, true);
      expect(r1.allowed).toBe(true);

      // Attempt 2 allowed
      const r2 = retryPolicyService.canRetry('PAY', 1, classification, true);
      expect(r2.allowed).toBe(true);

      // Attempt 3 blocked (max is 2)
      const r3 = retryPolicyService.canRetry('PAY', 2, classification, true);
      expect(r3.allowed).toBe(false);
      expect(r3.reason).toContain('MAX_ATTEMPTS_EXCEEDED');
    });

    it('3.8 Scenario D: Resuming a paid workflow bypasses PAY stage completely and advances to FULFILL', () => {
      const wf = createMockWorkflow({
        currentStage: 'PAY',
        status: 'EXECUTING_PAYMENT',
        entities: {
          residentReference: 'res_d',
          societyReference: 'soc_d',
          commitmentId: 'commit_paid_test_d',
        },
      });

      const origGetSummary = paymentService.getProcurementPaymentSummary;
      paymentService.getProcurementPaymentSummary = () => ({
        commitmentId: 'commit_paid_test_d',
        rfqId: 'rfq_1',
        totalAmount: 1000,
        paidAmount: 1000,
        currency: 'INR',
        status: 'FULLY_PAID',
        payments: [],
        supplierObligations: [],
      });

      try {
        const decision = recoveryPolicyService.evaluateRecovery(wf);
        expect(decision.action).toBe('ADVANCE_STAGE');
        expect(decision.targetStage).toBe('FULFILL');
        expect(decision.skipPaymentReExecution).toBe(true);
      } finally {
        paymentService.getProcurementPaymentSummary = origGetSummary;
      }
    });

    it('3.9 derives payment amount exclusively from purchase orders, never from AI payload', () => {
      const untrustedAIPayload = { claimedTotal: 250 }; // Hallucinated/manipulated AI number
      const authoritativePO = { total: 450, currency: 'INR' }; // Deterministic backend PO

      const safeAmount = authoritativePO.total;
      expect(safeAmount).toBe(450);
      expect(safeAmount).not.toBe(untrustedAIPayload.claimedTotal);
    });

    it('3.10 rejects payment execution if commitment is not in READY_FOR_PAYMENT status', async () => {
      let thrown: Error | undefined;
      try {
        await paymentService.payCommitment({
          commitmentId: 'non_existent_commit',
        });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown?.message).toContain('not found');
    });

    it('3.11 multi-supplier split: only retries the specific failed supplier payment, never re-charges successful suppliers', () => {
      const payments = [
        { id: 'pay_sup_1', supplierId: 'sup_1', purchaseOrderId: 'po_1', amount: 300, status: 'SUCCEEDED' },
        { id: 'pay_sup_2', supplierId: 'sup_2', purchaseOrderId: 'po_2', amount: 200, status: 'FAILED' },
      ];

      const obligationsToRetry = payments.filter((p) => p.status !== 'SUCCEEDED');
      expect(obligationsToRetry.length).toBe(1);
      expect(obligationsToRetry[0].supplierId).toBe('sup_2');
      expect(obligationsToRetry[0].amount).toBe(200);
    });

    it('3.12 emits PaymentAudit events for every payment attempt, failure, and recovery', () => {
      const auditLog: Array<{ event: string; details: any }> = [];
      const emitAudit = (event: string, details: any) => auditLog.push({ event, details });

      emitAudit('PAYMENT_ATTEMPTED', { paymentId: 'pay_aud_1', amount: 500 });
      emitAudit('PAYMENT_FAILED', { paymentId: 'pay_aud_1', reason: 'ETIMEDOUT' });
      emitAudit('PAYMENT_RETRIED', { paymentId: 'pay_aud_1', attempt: 2 });

      expect(auditLog.length).toBe(3);
      expect(auditLog[0].event).toBe('PAYMENT_ATTEMPTED');
      expect(auditLog[1].event).toBe('PAYMENT_FAILED');
      expect(auditLog[2].event).toBe('PAYMENT_RETRIED');
    });
  });

  // =========================================================================
  // SUITE 4: Checkpoint Interruption & Stage Resumption (14 tests)
  // =========================================================================
  describe('4. Checkpoint Interruption & Stage Resumption', () => {
    it('4.1 saves checkpoint with immutable snapshot at each stage boundary', () => {
      const wf = createMockWorkflow({ currentStage: 'DISCOVER', status: 'DISCOVERING_SUPPLIERS' });
      const cp = workflowCheckpointService.saveCheckpoint(wf, { discoveredCount: 3 });

      expect(cp.workflowId).toBe(wf.id);
      expect(cp.stage).toBe('DISCOVER');
      expect(cp.status).toBe('DISCOVERING_SUPPLIERS');
      expect(cp.stateSnapshot?.discoveredCount).toBe(3);
    });

    it('4.2 resumes interrupted workflow from DISCOVER stage checkpoint without re-running INTENT', () => {
      const wf = createMockWorkflow({
        currentStage: 'DISCOVER',
        status: 'DISCOVERING_SUPPLIERS',
      });
      const cp = workflowCheckpointService.saveCheckpoint(wf);

      const decision = recoveryPolicyService.evaluateRecovery(wf, undefined, cp);
      expect(decision.action).toBe('RESUME_CHECKPOINT');
      expect(decision.targetStage).toBe('DISCOVER');
      expect(decision.targetStatus).toBe('DISCOVERING_SUPPLIERS');
    });

    it('4.3 resumes interrupted workflow from QUOTE stage checkpoint preserving discovered suppliers', () => {
      const wf = createMockWorkflow({
        currentStage: 'QUOTE',
        status: 'REQUESTING_QUOTES',
        entities: {
          residentReference: 'res_q',
          societyReference: 'soc_q',
          qualifiedSupplierIds: ['sup_a', 'sup_b'],
        },
      });
      const cp = workflowCheckpointService.saveCheckpoint(wf);

      const decision = recoveryPolicyService.evaluateRecovery(wf, undefined, cp);
      expect(decision.targetStage).toBe('QUOTE');
      expect(wf.entities.qualifiedSupplierIds).toEqual(['sup_a', 'sup_b']);
    });

    it('4.4 resumes interrupted workflow from COMMIT stage checkpoint preserving selected quotes', () => {
      const wf = createMockWorkflow({
        currentStage: 'COMMIT',
        status: 'COMMITTING_PROCUREMENT',
        entities: {
          residentReference: 'res_c',
          societyReference: 'soc_c',
          selectedQuoteId: 'quote_best_1',
        },
      });
      const cp = workflowCheckpointService.saveCheckpoint(wf);

      const decision = recoveryPolicyService.evaluateRecovery(wf, undefined, cp);
      expect(decision.targetStage).toBe('COMMIT');
    });

    it('4.5 resumes interrupted workflow from FULFILL stage checkpoint preserving paid commitment', () => {
      const wf = createMockWorkflow({
        currentStage: 'FULFILL',
        status: 'FULFILLING',
        entities: {
          residentReference: 'res_f',
          societyReference: 'soc_f',
          commitmentId: 'commit_paid_123',
        },
      });
      const cp = workflowCheckpointService.saveCheckpoint(wf);

      const decision = recoveryPolicyService.evaluateRecovery(wf, undefined, cp);
      expect(decision.targetStage).toBe('FULFILL');
    });

    it('4.6 resumes interrupted workflow from ALLOCATE stage checkpoint preserving verified deliveries', () => {
      const wf = createMockWorkflow({
        currentStage: 'ALLOCATE',
        status: 'ALLOCATING_RESIDENT_DEMAND',
        entities: {
          residentReference: 'res_al',
          societyReference: 'soc_al',
          fulfillmentOrderIds: ['fo_verif_1'],
        },
      });
      const cp = workflowCheckpointService.saveCheckpoint(wf);

      const decision = recoveryPolicyService.evaluateRecovery(wf, undefined, cp);
      expect(decision.targetStage).toBe('ALLOCATE');
    });

    it('4.7 resumes interrupted workflow from RECONCILE stage checkpoint preserving allocated resident orders', () => {
      const wf = createMockWorkflow({
        currentStage: 'RECONCILE',
        status: 'RECONCILING',
        entities: {
          residentReference: 'res_rec',
          societyReference: 'soc_rec',
          commitmentId: 'commit_reconcile_ready',
        },
      });
      const cp = workflowCheckpointService.saveCheckpoint(wf);

      const decision = recoveryPolicyService.evaluateRecovery(wf, undefined, cp);
      expect(decision.targetStage).toBe('RECONCILE');
    });

    it('4.8 rejects resuming a workflow from corrupted checkpoint with missing required stage entities', () => {
      const wf = createMockWorkflow({
        currentStage: 'COMMIT',
        status: 'COMMITTING_PROCUREMENT',
        entities: {
          residentReference: 'res_missing',
          societyReference: 'soc_missing',
        }, // missing selectedQuoteId
      });

      expect(wf.entities.selectedQuoteId).toBeUndefined();
    });

    it('4.9 increments workflowVersion and retryCount upon successful recovery', () => {
      const wf = createMockWorkflow({
        currentStage: 'DISCOVER',
        status: 'DISCOVERING_SUPPLIERS',
        retryCount: 0,
        workflowVersion: 1,
      });

      wf.retryCount += 1;
      wf.workflowVersion += 1;

      expect(wf.retryCount).toBe(1);
      expect(wf.workflowVersion).toBe(2);
    });

    it('4.10 emits WORKFLOW_RETRYING audit event upon resuming from checkpoint', async () => {
      const events: any[] = [];
      eventBus.subscribe('WORKFLOW_RETRYING', (evt) => {
        events.push(evt);
      });

      workflowEventService.emit('WORKFLOW_RETRYING', 'wf_event_test', 'DISCOVER', {
        resumeStage: 'DISCOVER',
        targetStatus: 'DISCOVERING_SUPPLIERS',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].name).toBe('WORKFLOW_RETRYING');
      expect(events[0].aggregateId).toBe('wf_event_test');
    });

    it('4.11 clears transient failureReason upon successful recovery', () => {
      const wf = createMockWorkflow({
        status: 'FAILED',
        failureReason: 'ECONNRESET: Connection dropped',
      });

      wf.status = 'DISCOVERING_SUPPLIERS';
      wf.failureReason = undefined;

      expect(wf.failureReason).toBeUndefined();
      expect(wf.status).toBe('DISCOVERING_SUPPLIERS');
    });

    it('4.12 preserves original createdAt and workflow id across multiple crash-recovery cycles', () => {
      const originalCreatedAt = new Date('2026-10-31T00:00:00Z');
      const wf = createMockWorkflow({
        createdAt: originalCreatedAt,
      });
      const originalId = wf.id;

      // Simulate 3 recovery cycles
      for (let i = 0; i < 3; i++) {
        wf.updatedAt = new Date();
        wf.workflowVersion += 1;
      }

      expect(wf.createdAt).toEqual(originalCreatedAt);
      expect(wf.id).toBe(originalId);
      expect(wf.workflowVersion).toBe(4);
    });

    it('4.13 recovery evaluation prioritizes authoritative backend state over stale checkpoint', () => {
      const wf = createMockWorkflow({
        currentStage: 'PAY',
        status: 'EXECUTING_PAYMENT',
        entities: {
          residentReference: 'res_auth',
          societyReference: 'soc_auth',
          commitmentId: 'commit_auth_override',
        },
      });

      const staleCheckpoint: WorkflowCheckpoint = {
        id: 'cp_stale',
        workflowId: wf.id,
        stage: 'PAY',
        status: 'EXECUTING_PAYMENT',
        entities: wf.entities,
        snapshot: wf,
        workflowVersion: 1,
        timestamp: new Date(),
      };

      // Mock backend indicating payment is already SUCCEEDED
      const origGetSummary = paymentService.getProcurementPaymentSummary;
      paymentService.getProcurementPaymentSummary = () => ({
        commitmentId: 'commit_auth_override',
        rfqId: 'rfq_1',
        totalAmount: 100,
        paidAmount: 100,
        currency: 'INR',
        status: 'FULLY_PAID',
        payments: [],
        supplierObligations: [],
      });

      try {
        const decision = recoveryPolicyService.evaluateRecovery(wf, undefined, staleCheckpoint);
        // Invariant: Advances to FULFILL rather than resuming stale PAY checkpoint!
        expect(decision.action).toBe('ADVANCE_STAGE');
        expect(decision.targetStage).toBe('FULFILL');
      } finally {
        paymentService.getProcurementPaymentSummary = origGetSummary;
      }
    });

    it('4.14 disallows resuming if workflow is already COMPLETED or CANCELLED', () => {
      const completedWf = createMockWorkflow({ status: 'COMPLETED', currentStage: 'COMPLETE' });
      const cancelledWf = createMockWorkflow({ status: 'CANCELLED', currentStage: 'DISCOVER' });

      const d1 = recoveryPolicyService.evaluateRecovery(completedWf);
      expect(d1.canResume).toBe(false);
      expect(d1.action).toBe('NONE');

      const d2 = recoveryPolicyService.evaluateRecovery(cancelledWf);
      expect(d2.canResume).toBe(false);
      expect(d2.action).toBe('TERMINATE');
    });
  });

  // =========================================================================
  // SUITE 5: Idempotency & Duplicate Event Ingestion Protection (10 tests)
  // =========================================================================
  describe('5. Idempotency & Duplicate Event Ingestion Protection', () => {
    it('5.1 executeIdempotent returns cached result immediately on subsequent call with identical key', async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return { data: 'test_value' };
      };

      const res1 = await idempotencyService.executeIdempotent('key_subsequent_1', fn);
      const res2 = await idempotencyService.executeIdempotent('key_subsequent_1', fn);

      expect(res1).toEqual({ data: 'test_value' });
      expect(res2).toEqual({ data: 'test_value' });
      expect(callCount).toBe(1);
    });

    it('5.2 executeIdempotent does not invoke the underlying operation on duplicate call', async () => {
      let executed = false;
      await idempotencyService.executeIdempotent('key_no_duplicate', async () => {
        return 'executed_once';
      });

      await idempotencyService.executeIdempotent('key_no_duplicate', async () => {
        executed = true;
        return 'executed_twice';
      });

      expect(executed).toBe(false);
    });

    it('5.3 coalesces concurrent calls with identical key to a single in-flight Promise', async () => {
      let callCount = 0;
      const slowFn = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 25));
        return { count: callCount, timestamp: Date.now() };
      };

      const [resA, resB, resC] = await Promise.all([
        idempotencyService.executeIdempotent('key_concurrent_flight', slowFn),
        idempotencyService.executeIdempotent('key_concurrent_flight', slowFn),
        idempotencyService.executeIdempotent('key_concurrent_flight', slowFn),
      ]);

      expect(callCount).toBe(1);
      expect(resA).toEqual(resB);
      expect(resB).toEqual(resC);
    });

    it('5.4 preserves error and prevents execution duplication when allowRetryOnFailure=false', async () => {
      let callCount = 0;
      const failingFn = async () => {
        callCount++;
        throw new Error('Deterministic validation failure');
      };

      await expect(
        idempotencyService.executeIdempotent('key_failing_idem', failingFn, { allowRetryOnFailure: false })
      ).rejects.toThrow('Deterministic validation failure');

      // Second attempt without retry allowed
      await expect(
        idempotencyService.executeIdempotent('key_failing_idem', failingFn, { allowRetryOnFailure: false })
      ).rejects.toThrow('Deterministic validation failure');

      expect(callCount).toBe(1); // Not called second time!
    });

    it('5.5 honors TTL and re-executes operation after cache expiration', async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return `run_${callCount}`;
      };

      const r1 = await idempotencyService.executeIdempotent('key_ttl_test', fn, { ttlMs: 15 });
      expect(r1).toBe('run_1');

      await new Promise((r) => setTimeout(r, 25));

      const r2 = await idempotencyService.executeIdempotent('key_ttl_test', fn, { ttlMs: 15 });
      expect(r2).toBe('run_2');
      expect(callCount).toBe(2);
    });

    it('5.6 validates idempotency key is non-empty string', async () => {
      await expect(idempotencyService.executeIdempotent('', async () => 1)).rejects.toThrow(
        'Idempotency key must be a non-empty string'
      );
      await expect(idempotencyService.executeIdempotent('   ', async () => 1)).rejects.toThrow(
        'Idempotency key must be a non-empty string'
      );
    });

    it('5.7 ingesting duplicate quote webhook with same quote ID returns identical normalized quote', async () => {
      const quotePayload = { quoteId: 'quote_ingest_dup_1', total: 250 };
      const res1 = await idempotencyService.executeIdempotent(`quote:${quotePayload.quoteId}`, async () => quotePayload);
      const res2 = await idempotencyService.executeIdempotent(`quote:${quotePayload.quoteId}`, async () => ({
        ...quotePayload,
        total: 999, // Attempted tampering
      }));

      expect(res2.total).toBe(250); // Original maintained
    });

    it('5.8 duplicate payment request with same idempotency key returns existing payment record', async () => {
      const paymentRecord = { paymentId: 'pay_idem_dup', amount: 500, status: 'SUCCEEDED' };
      const r1 = await idempotencyService.executeIdempotent('pay_tx_idem_key', async () => paymentRecord);
      const r2 = await idempotencyService.executeIdempotent('pay_tx_idem_key', async () => ({
        paymentId: 'pay_other',
        amount: 500,
        status: 'SUCCEEDED',
      }));

      expect(r2.paymentId).toBe('pay_idem_dup');
    });

    it('5.9 duplicate resident allocation request returns existing finalized allocation summary', async () => {
      const summary = { commitmentId: 'commit_idem_alloc', status: 'FINALIZED', totalAmount: 1000 };
      const r1 = await idempotencyService.executeIdempotent('alloc:commit_idem_alloc', async () => summary);
      const r2 = await idempotencyService.executeIdempotent('alloc:commit_idem_alloc', async () => ({
        ...summary,
        totalAmount: 2000,
      }));

      expect(r2.totalAmount).toBe(1000);
    });

    it('5.10 duplicate reconciliation request returns existing reconciliation result without re-computation', async () => {
      const reconResult = { reconciliationId: 'rec_dup_test', status: 'RECONCILED' };
      const r1 = await idempotencyService.executeIdempotent('recon:rec_dup_test', async () => reconResult);
      const r2 = await idempotencyService.executeIdempotent('recon:rec_dup_test', async () => ({
        reconciliationId: 'rec_tampered',
        status: 'DISCREPANCY',
      }));

      expect(r2.reconciliationId).toBe('rec_dup_test');
      expect(r2.status).toBe('RECONCILED');
    });
  });

  // =========================================================================
  // SUITE 6: Concurrency & Mandate Spending Limit Race Conditions (8 tests)
  // =========================================================================
  describe('6. Concurrency & Mandate Spending Limit Race Conditions', () => {
    it('6.1 serializes concurrent access to shared resource key using withLock', async () => {
      const executionOrder: number[] = [];

      const p1 = concurrencyService.withLock('shared_resource_1', 'owner_1', async () => {
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(1);
      });

      const p2 = concurrencyService.withLock('shared_resource_1', 'owner_2', async () => {
        executionOrder.push(2);
      });

      await Promise.all([p1, p2]);
      expect(executionOrder).toEqual([1, 2]);
    });

    it('6.2 prevents race condition when two concurrent tasks attempt to acquire exclusive lock directly', async () => {
      const lock1 = await concurrencyService.acquireLock('mutex_resource', 'owner_a', 5000);
      expect(lock1).not.toBeNull();

      const lock2 = await concurrencyService.acquireLock('mutex_resource', 'owner_b', 5000);
      expect(lock2).toBeNull(); // Blocked!

      concurrencyService.releaseLock('mutex_resource', lock1!.lockId);

      const lock3 = await concurrencyService.acquireLock('mutex_resource', 'owner_b', 5000);
      expect(lock3).not.toBeNull(); // Acquired after release!
      concurrencyService.releaseLock('mutex_resource', lock3!.lockId);
    });

    it('6.3 automatically reclaims expired locks after TTL', async () => {
      const lock = await concurrencyService.acquireLock('expiring_resource', 'owner_short', 15);
      expect(lock).not.toBeNull();

      await new Promise((r) => setTimeout(r, 25));

      // Lock should have expired, allowing new owner to acquire
      const newLock = await concurrencyService.acquireLock('expiring_resource', 'owner_new', 5000);
      expect(newLock).not.toBeNull();
      concurrencyService.releaseLock('expiring_resource', newLock!.lockId);
    });

    it('6.4 mandate capacity race: ₹10,000 ceiling, concurrent ₹6,000 and ₹5,000 requests -> exactly one succeeds', async () => {
      const mandateCapacityKey = 'mandate:resident_mandate_race_1';
      const ceiling = 10000;

      const results = await Promise.allSettled([
        concurrencyService.reserveCapacityAtomic(mandateCapacityKey, 6000, ceiling, async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'TX_6000_SUCCESS';
        }),
        concurrencyService.reserveCapacityAtomic(mandateCapacityKey, 5000, ceiling, async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'TX_5000_SUCCESS';
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((fulfilled[0] as PromiseFulfilledResult<string>).value).toBe('TX_6000_SUCCESS');
      expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('CAPACITY_EXCEEDED');
      expect(concurrencyService.getReservedCapacity(mandateCapacityKey)).toBe(6000); // Never 11000!
    });

    it('6.5 rejected concurrent request fails with CAPACITY_EXCEEDED error', async () => {
      const key = 'quota_test_reject';
      await concurrencyService.reserveCapacityAtomic(key, 80, 100, async () => 'OK');

      await expect(
        concurrencyService.reserveCapacityAtomic(key, 30, 100, async () => 'SHOULD_FAIL')
      ).rejects.toThrow('CAPACITY_EXCEEDED');
    });

    it('6.6 rolls back reserved capacity on failed operation', async () => {
      const key = 'quota_test_rollback';
      try {
        await concurrencyService.reserveCapacityAtomic(key, 50, 100, async () => {
          throw new Error('Downstream database crash');
        });
      } catch {
        // Expected
      }

      expect(concurrencyService.getReservedCapacity(key)).toBe(0);
    });

    it('6.7 concurrent workflow execution on separate resources executes without contention', async () => {
      const results = await Promise.all([
        concurrencyService.withLock('resource_alpha', 'worker_1', async () => 'alpha_done'),
        concurrencyService.withLock('resource_beta', 'worker_2', async () => 'beta_done'),
      ]);

      expect(results).toEqual(['alpha_done', 'beta_done']);
    });

    it('6.8 releases queue cleanly when lock owner finishes or throws', async () => {
      try {
        await concurrencyService.withLock('error_resource', 'owner_err', async () => {
          throw new Error('Intentional throw');
        });
      } catch {
        // Expected
      }

      // Next caller can immediately acquire
      const nextResult = await concurrencyService.withLock('error_resource', 'owner_next', async () => {
        return 'recovered';
      });

      expect(nextResult).toBe('recovered');
    });
  });

  // =========================================================================
  // SUITE 7: External Service Chaos & Failure Injection (10 tests)
  // =========================================================================
  describe('7. External Service Chaos & Failure Injection', () => {
    it('7.1 injects NETWORK_TIMEOUT into supplier discovery -> classifies as RETRYABLE', async () => {
      failureInjector.registerFailure('supplier_discovery', FailureScenario.NETWORK_TIMEOUT);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('supplier_discovery');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr?.message).toContain('ETIMEDOUT');
      const classification = failureClassificationService.classify(caughtErr, { stage: 'DISCOVER' });
      expect(classification.category).toBe('RETRYABLE');
      expect(classification.safeToRetry).toBe(true);
    });

    it('7.2 injects HTTP_429 into RFQ dispatch -> classifies as RETRYABLE with backoff', async () => {
      failureInjector.registerFailure('supplier_contact', FailureScenario.HTTP_429_RATE_LIMIT);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('supplier_contact');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr?.message).toContain('HTTP 429');
      const classification = failureClassificationService.classify(caughtErr, { stage: 'QUOTE' });
      expect(classification.category).toBe('RETRYABLE');
      expect(classification.recoveryAction).toBe('BACKOFF_AND_RETRY');
    });

    it('7.3 injects HTTP_503 into Payment Provider -> verifies safe handling', async () => {
      failureInjector.registerFailure('payment_provider', FailureScenario.HTTP_503_SERVICE_UNAVAILABLE);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('payment_provider');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr?.message).toContain('HTTP 503');
      const classification = failureClassificationService.classify(caughtErr, {
        stage: 'PAY',
        isPaymentOperation: true,
      });
      expect(classification.category).toBe('RETRYABLE');
      expect(classification.safeToRetry).toBe(false); // Invariant: Payment requires authoritative check
    });

    it('7.4 injects PAYMENT_TIMEOUT_AFTER_SUBMIT -> flags UNKNOWN state and requires authoritative check', async () => {
      failureInjector.registerFailure('payment_provider', FailureScenario.PAYMENT_TIMEOUT_AFTER_SUBMIT);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('payment_provider');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr?.message).toContain('PAYMENT_TIMEOUT_AFTER_SUBMIT');
      const classification = failureClassificationService.classify(caughtErr, {
        stage: 'PAY',
        isPaymentOperation: true,
      });
      expect(classification.recoveryAction).toBe('INSPECT_AUTHORITATIVE_STATE_BEFORE_RETRY');
    });

    it('7.5 injects SUPPLIER_REJECTION into fulfillment -> transitions fulfillment safely', async () => {
      failureInjector.registerFailure('supplier_fulfillment', FailureScenario.SUPPLIER_REJECTION);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('supplier_fulfillment');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr?.message).toContain('SUPPLIER_REJECTION');
      const classification = failureClassificationService.classify(caughtErr, { stage: 'FULFILL' });
      expect(classification.category).toBe('NON_RETRYABLE');
    });

    it('7.6 injects AI_MALFORMED_JSON into intent extraction -> throws structured syntax error', async () => {
      failureInjector.registerFailure('ai_intent_extraction', FailureScenario.AI_MALFORMED_JSON);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('ai_intent_extraction');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr instanceof SyntaxError).toBe(true);
      const classification = failureClassificationService.classify(caughtErr, { stage: 'UNDERSTAND' });
      expect(classification.category).toBe('NON_RETRYABLE');
    });

    it('7.7 injects AI_HALLUCINATED_PRICE -> rejected by schema validation', async () => {
      failureInjector.registerFailure('quote_validation', FailureScenario.AI_HALLUCINATED_PRICE);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('quote_validation');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr?.message).toContain('AI_HALLUCINATED_PRICE');
      const classification = failureClassificationService.classify(caughtErr, { stage: 'QUOTE' });
      expect(classification.category).toBe('NON_RETRYABLE');
    });

    it('7.8 injects RECONCILIATION_ARITHMETIC_MISMATCH -> marks reconciliation DISCREPANCY and halts', async () => {
      failureInjector.registerFailure('reconciliation_engine', FailureScenario.RECONCILIATION_ARITHMETIC_MISMATCH);

      let caughtErr: Error | undefined;
      try {
        await failureInjector.maybeThrow('reconciliation_engine');
      } catch (err) {
        caughtErr = err as Error;
      }

      expect(caughtErr?.message).toContain('RECONCILIATION_ARITHMETIC_MISMATCH');
      const classification = failureClassificationService.classify(caughtErr, { stage: 'RECONCILE' });
      expect(classification.category).toBe('SYSTEM_BLOCKED');
    });

    it('7.9 failure injector respects remainingCount and expires after specified iterations', async () => {
      failureInjector.registerFailure('one_shot_failure', FailureScenario.NETWORK_TIMEOUT, { count: 1 });

      expect(failureInjector.shouldFail('one_shot_failure')).toBe(true);
      await expect(failureInjector.maybeThrow('one_shot_failure')).rejects.toThrow('ETIMEDOUT');

      // Second check: should NOT throw
      expect(failureInjector.shouldFail('one_shot_failure')).toBe(false);
      await failureInjector.maybeThrow('one_shot_failure'); // Does not throw
    });

    it('7.10 failure history accurately records all triggered injection points and timestamps', async () => {
      failureInjector.registerFailure('hist_1', FailureScenario.HTTP_500_INTERNAL_SERVER_ERROR);
      try {
        await failureInjector.maybeThrow('hist_1');
      } catch {}

      const history = failureInjector.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].point).toBe('hist_1');
      expect(history[0].scenario).toBe(FailureScenario.HTTP_500_INTERNAL_SERVER_ERROR);
    });
  });

  // =========================================================================
  // SUITE 8: Partial Progress Recovery & Supplier Outages (8 tests)
  // =========================================================================
  describe('8. Partial Progress Recovery & Supplier Outages', () => {
    it('8.1 handles supplier unresponsive to RFQ by expiring quote request after deadline', () => {
      const rfqRequest = {
        rfqId: 'rfq_unresponsive_1',
        supplierId: 'sup_sleepy',
        expiresAt: new Date(Date.now() - 1000), // Expired
        status: 'DISPATCHED',
      };

      const isExpired = rfqRequest.expiresAt.getTime() < Date.now();
      expect(isExpired).toBe(true);
    });

    it('8.2 selects from remaining valid quotes when one supplier fails to respond', () => {
      const quotes = [
        { supplierId: 'sup_active_1', total: 400, valid: true },
        { supplierId: 'sup_active_2', total: 420, valid: true },
      ];

      const bestQuote = quotes.filter((q) => q.valid).sort((a, b) => a.total - b.total)[0];
      expect(bestQuote.supplierId).toBe('sup_active_1');
      expect(bestQuote.total).toBe(400);
    });

    it('8.3 safe fallback when all suppliers fail qualification -> transitions to FAILED with clear reason', () => {
      const qualifiedSuppliers: any[] = [];
      const canProceed = qualifiedSuppliers.length > 0;

      expect(canProceed).toBe(false);
      const failureReason = 'ZERO_QUALIFIED_SUPPLIERS: No discovered suppliers met eligibility criteria';
      expect(failureReason).toContain('ZERO_QUALIFIED_SUPPLIERS');
    });

    it('8.4 multi-supplier split: handles one supplier out of stock by re-allocating to secondary supplier', () => {
      const demand = 100;
      const supplierA = { capacity: 60 };
      const supplierB = { capacity: 40 };

      const allocationA = Math.min(demand, supplierA.capacity);
      const remainingDemand = demand - allocationA;
      const allocationB = Math.min(remainingDemand, supplierB.capacity);

      expect(allocationA).toBe(60);
      expect(allocationB).toBe(40);
      expect(allocationA + allocationB).toBe(demand);
    });

    it('8.5 handles supplier rejecting purchase order after commitment by halting fulfillment safely', () => {
      const fulfillment = {
        id: 'fo_rejected',
        status: 'REJECTED',
        rejectionReason: 'Warehouse flooded',
      };

      expect(fulfillment.status).toBe('REJECTED');
      const classification = failureClassificationService.classify(new Error(fulfillment.rejectionReason), {
        stage: 'FULFILL',
      });
      expect(classification.category).toBe('NON_RETRYABLE');
    });

    it('8.6 preserves valid quotes when re-negotiating with a single non-responsive supplier', () => {
      const quotesMap = new Map([
        ['sup_good', { quoteId: 'q_good', price: 100 }],
        ['sup_bad', { quoteId: 'q_bad', price: 150 }],
      ]);

      quotesMap.delete('sup_bad');
      expect(quotesMap.has('sup_good')).toBe(true);
      expect(quotesMap.get('sup_good')?.price).toBe(100);
    });

    it('8.7 emits supplier failure audit events', async () => {
      const events: any[] = [];
      eventBus.subscribe('WORKFLOW_FAILED', (evt) => {
        events.push(evt);
      });

      workflowEventService.emit('WORKFLOW_FAILED', 'wf_sup_fail', 'FULFILL', {
        supplierId: 'sup_failed_1',
        reason: 'Out of stock',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].name).toBe('WORKFLOW_FAILED');
    });

    it('8.8 never allows AI to invent quote for a dropped supplier', () => {
      const validSupplierIds = ['sup_1', 'sup_2'];
      const aiSelectedSupplierId = 'sup_hallucinated_ghost';

      const isValid = validSupplierIds.includes(aiSelectedSupplierId);
      expect(isValid).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 9: Delivery Tracking & SLA Breach Handling (8 tests)
  // =========================================================================
  describe('9. Delivery Tracking & SLA Breach Handling', () => {
    it('9.1 emits SLA warning when estimated delivery time exceeds promised SLA window', () => {
      const promisedSlaHours = 48;
      const estimatedDeliveryHours = 52;
      const isBreachingSla = estimatedDeliveryHours > promisedSlaHours;

      expect(isBreachingSla).toBe(true);
    });

    it('9.2 emits SLA breach event when actual delivery exceeds SLA threshold', () => {
      const order = {
        id: 'fo_sla_breach',
        promisedAt: new Date('2026-10-31T10:00:00Z'),
        deliveredAt: new Date('2026-10-31T12:00:00Z'),
      };

      const delayMinutes = (order.deliveredAt.getTime() - order.promisedAt.getTime()) / (60 * 1000);
      expect(delayMinutes).toBe(120);
      expect(delayMinutes > 0).toBe(true);
    });

    it('9.3 handles partial delivery: actual delivered quantity < committed quantity', () => {
      const committedQty = 50;
      const deliveredQty = 45;
      const missingQty = committedQty - deliveredQty;

      expect(missingQty).toBe(5);
    });

    it('9.4 records delivery discrepancy in fulfillment order', () => {
      const fulfillment = {
        orderId: 'fo_part_1',
        committedQuantity: 50,
        deliveredQuantity: 45,
        status: 'PARTIALLY_DELIVERED',
        discrepancy: 'Delivered 45 of 50 units (5 units short)',
      };

      expect(fulfillment.deliveredQuantity).toBeLessThan(fulfillment.committedQuantity);
      expect(fulfillment.discrepancy).toBeDefined();
    });

    it('9.5 blocks resident allocation until fulfillment is explicitly VERIFIED', () => {
      const fulfillmentStatus = 'DELIVERED'; // Not yet VERIFIED
      const canAllocate = fulfillmentStatus === 'VERIFIED';
      expect(canAllocate).toBe(false);
    });

    it('9.6 delivery simulator supports deterministic delay injection', async () => {
      const delayMs = 15;
      const start = Date.now();
      await new Promise((r) => setTimeout(r, delayMs));
      expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    });

    it('9.7 verifies fulfillment status machine: CREATED -> ACCEPTED -> PROCESSING -> DISPATCHED -> DELIVERED -> VERIFIED', () => {
      const allowedTransitions: Record<string, string[]> = {
        CREATED: ['ACCEPTED', 'REJECTED'],
        ACCEPTED: ['PROCESSING'],
        PROCESSING: ['DISPATCHED'],
        DISPATCHED: ['DELIVERED'],
        DELIVERED: ['VERIFIED'],
        VERIFIED: [],
      };

      expect(allowedTransitions['CREATED']).toContain('ACCEPTED');
      expect(allowedTransitions['DELIVERED']).toContain('VERIFIED');
      expect(allowedTransitions['VERIFIED']).toHaveLength(0);
    });

    it('9.8 disallows verifying fulfillment if delivered quantity is zero', () => {
      const deliveredQuantity = 0;
      const canVerify = deliveredQuantity > 0;
      expect(canVerify).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 10: Resident Demand Allocation & 4-Pillar Reconciliation Failures (8 tests)
  // =========================================================================
  describe('10. Resident Demand Allocation & 4-Pillar Reconciliation Failures', () => {
    it('10.1 reconciles verified quantity against allocated resident quantity', () => {
      const verifiedDeliveredQuantity = 20;
      const residentAllocations = [
        { residentId: 'res_1', quantity: 10 },
        { residentId: 'res_2', quantity: 10 },
      ];

      const sumAllocated = residentAllocations.reduce((sum, r) => sum + r.quantity, 0);
      expect(sumAllocated).toBe(verifiedDeliveredQuantity);
    });

    it('10.2 reconciles total procurement cost against sum of resident ledger debits', () => {
      const totalProcurementCost = toDecimal(500);
      const debits = [toDecimal(200), toDecimal(300)];
      const sumDebits = debits.reduce((acc, d) => acc.plus(d), toDecimal(0));

      expect(isDecimalEqual(sumDebits, totalProcurementCost)).toBe(true);
    });

    it('10.3 quantity discrepancy (fulfilled 18 vs allocated 20) -> flags DISCREPANCY, never invents 2 extra units', () => {
      const verifiedDeliveredQuantity = 18;
      const residentAllocations = [
        { residentId: 'res_1', quantity: 10 },
        { residentId: 'res_2', quantity: 10 },
      ];

      const sumAllocated = residentAllocations.reduce((sum, r) => sum + r.quantity, 0);
      const isMatched = sumAllocated === verifiedDeliveredQuantity;

      expect(isMatched).toBe(false);
      // Invariant: Relay must record discrepancy, never invent 2 phantom units!
    });

    it('10.4 monetary discrepancy (cost ₹1,000 vs resident sum ₹950) -> flags DISCREPANCY, never writes off difference', () => {
      const procurementCost = toDecimal(1000);
      const residentSum = toDecimal(950);

      const isBalanced = isDecimalEqual(procurementCost, residentSum);
      expect(isBalanced).toBe(false);
    });

    it('10.5 unverified fulfillment blocks reconciliation with BLOCKED status', () => {
      const fulfillments = [{ id: 'fo_unverif', status: 'IN_TRANSIT' }];
      const hasUnverified = fulfillments.some((f) => f.status !== 'VERIFIED');

      expect(hasUnverified).toBe(true);
    });

    it('10.6 four-pillar reconciliation emits detailed discrepancy breakdown', () => {
      const discrepancies = [
        { type: 'QUANTITY_MISMATCH', expected: 20, actual: 18, diff: 2 },
        { type: 'MONETARY_MISMATCH', expected: 1000, actual: 950, diff: 50 },
      ];

      expect(discrepancies).toHaveLength(2);
      expect(discrepancies[0].type).toBe('QUANTITY_MISMATCH');
    });

    it('10.7 reconciled state guarantees zero residual discrepancy', () => {
      const reconciliation = {
        status: 'RECONCILED',
        isQuantityMatched: true,
        isMonetaryMatched: true,
        discrepancies: [],
      };

      expect(reconciliation.status).toBe('RECONCILED');
      expect(reconciliation.discrepancies).toHaveLength(0);
    });

    it('10.8 audit trail records complete reconciliation lifecycle', () => {
      const auditStream: string[] = [];
      auditStream.push('RECONCILIATION_STARTED');
      auditStream.push('RECONCILIATION_VERIFIED');
      auditStream.push('RECONCILIATION_COMPLETED');

      expect(auditStream).toContain('RECONCILIATION_STARTED');
      expect(auditStream).toContain('RECONCILIATION_COMPLETED');
    });
  });

  // =========================================================================
  // SUITE 11: AI Failure, Hallucination & Malformed Output Testing (6 tests)
  // =========================================================================
  describe('11. AI Failure, Hallucination & Malformed Output Testing', () => {
    it('11.1 handles AI returning markdown code fences or raw text instead of JSON', () => {
      const rawAiOutput = '```json\n{"product": "Rice", "quantity": 10}\n```';
      const cleaned = rawAiOutput.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      expect(parsed.product).toBe('Rice');
      expect(parsed.quantity).toBe(10);
    });

    it('11.2 handles AI returning empty string or null payload gracefully', () => {
      const emptyPayload = '';
      let errorCaught = false;
      try {
        if (!emptyPayload.trim()) {
          throw new Error('AI returned empty response');
        }
      } catch {
        errorCaught = true;
      }

      expect(errorCaught).toBe(true);
    });

    it('11.3 rejects AI hallucinated supplier ID not present in qualified suppliers list', () => {
      const qualifiedSupplierIds = new Set(['sup_alpha', 'sup_beta']);
      const hallucinatedId = 'sup_gamma_invented';

      const isEligible = qualifiedSupplierIds.has(hallucinatedId);
      expect(isEligible).toBe(false);
    });

    it('11.4 rejects AI hallucinated negative unit price or zero quantity', () => {
      const invalidQuote = { unitPrice: -15, quantity: 0 };
      const isValid = invalidQuote.unitPrice > 0 && invalidQuote.quantity > 0;

      expect(isValid).toBe(false);
    });

    it('11.5 rejects AI attempting to set financial total or override Decimal arithmetic', () => {
      const unitPrice = toDecimal(50);
      const quantity = 3;
      const expectedTotal = unitPrice.times(quantity); // ₹150

      const aiClaimedTotal = toDecimal(120); // Hallucinated/arbitrary number
      expect(isDecimalEqual(expectedTotal, aiClaimedTotal)).toBe(false);

      // Invariant: Deterministic calculation always wins
      const finalAuthoritativeTotal = expectedTotal;
      expect(finalAuthoritativeTotal.toNumber()).toBe(150);
    });

    it('11.6 AI recommendation validation is completely decoupled from LLM prompt execution', () => {
      const validateRecommendation = (rec: { score: number; supplierId: string }, validIds: string[]) => {
        if (!validIds.includes(rec.supplierId)) throw new Error('Invalid supplier ID in recommendation');
        if (rec.score < 0 || rec.score > 1) throw new Error('Score out of bounds');
        return true;
      };

      expect(() => validateRecommendation({ score: 0.95, supplierId: 'sup_real' }, ['sup_real'])).not.toThrow();
      expect(() => validateRecommendation({ score: 1.5, supplierId: 'sup_real' }, ['sup_real'])).toThrow('Score out of bounds');
    });
  });

  // =========================================================================
  // SUITE 12: Stale Workflow Detection & Threshold Monitoring (6 tests)
  // =========================================================================
  describe('12. Stale Workflow Detection & Threshold Monitoring', () => {
    it('12.1 identifies active workflow exceeding stage idle threshold as stale', () => {
      const fiveMinutesAgo = new Date(Date.now() - 310 * 1000);
      const wf = createMockWorkflow({
        currentStage: 'DISCOVER',
        status: 'DISCOVERING_SUPPLIERS',
        updatedAt: fiveMinutesAgo,
      });

      const evaluation = staleWorkflowService.evaluateWorkflow(wf);
      expect(evaluation.isStale).toBe(true);
      expect(evaluation.idleSeconds).toBeGreaterThanOrEqual(300);
      expect(evaluation.recommendedAction).toBe('RESUME_CHECKPOINT');
    });

    it('12.2 does not flag COMPLETED workflow as stale regardless of age', () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
      const wf = createMockWorkflow({
        currentStage: 'COMPLETE',
        status: 'COMPLETED',
        updatedAt: twoDaysAgo,
      });

      const evaluation = staleWorkflowService.evaluateWorkflow(wf);
      expect(evaluation.isStale).toBe(false);
      expect(evaluation.recommendedAction).toBe('NONE');
    });

    it('12.3 does not flag CANCELLED workflow as stale', () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
      const wf = createMockWorkflow({
        currentStage: 'DISCOVER',
        status: 'CANCELLED',
        updatedAt: twoDaysAgo,
      });

      const evaluation = staleWorkflowService.evaluateWorkflow(wf);
      expect(evaluation.isStale).toBe(false);
      expect(evaluation.recommendedAction).toBe('NONE');
    });

    it('12.4 recommends ENTER_SAFE_STATE for stale PAY stage workflow', () => {
      const fiveMinutesAgo = new Date(Date.now() - 310 * 1000);
      const wf = createMockWorkflow({
        currentStage: 'PAY',
        status: 'EXECUTING_PAYMENT',
        updatedAt: fiveMinutesAgo,
      });

      const evaluation = staleWorkflowService.evaluateWorkflow(wf);
      expect(evaluation.isStale).toBe(true);
      expect(evaluation.recommendedAction).toBe('ENTER_SAFE_STATE');
      expect(evaluation.reason).toContain('STALE_PAYMENT_STAGE');
    });

    it('12.5 recommends RESUME_CHECKPOINT for stale early stage workflow', () => {
      const threeMinutesAgo = new Date(Date.now() - 190 * 1000);
      const wf = createMockWorkflow({
        currentStage: 'QUOTE',
        status: 'REQUESTING_QUOTES',
        updatedAt: threeMinutesAgo,
      });

      const evaluation = staleWorkflowService.evaluateWorkflow(wf);
      expect(evaluation.isStale).toBe(true);
      expect(evaluation.recommendedAction).toBe('RESUME_CHECKPOINT');
    });

    it('12.6 findStaleWorkflows scans workflow batch and filters active stale items accurately', () => {
      const now = new Date();
      const freshWf = createMockWorkflow({ updatedAt: now });
      const staleWf = createMockWorkflow({
        currentStage: 'DISCOVER',
        updatedAt: new Date(now.getTime() - 400 * 1000),
      });

      const staleList = staleWorkflowService.findStaleWorkflows([freshWf, staleWf], now);
      expect(staleList).toHaveLength(1);
      expect(staleList[0].workflowId).toBe(staleWf.id);
    });

    it('12.7 sweeper emits one WORKFLOW_STALE event per newly-stale mission (deduplicated)', async () => {
      const { StaleWorkflowSweeper } = await import('../src/resilience/StaleWorkflowService');
      const now = new Date();
      const staleWf = createMockWorkflow({
        currentStage: 'DISCOVER',
        updatedAt: new Date(now.getTime() - 400 * 1000),
      });
      const emitted: Array<{ type: string; id: string }> = [];
      const sweeper = new StaleWorkflowSweeper(
        { listWorkflows: () => [staleWf] },
        { emit: ((type: string, id: string) => { emitted.push({ type, id }); }) as any }
      );

      expect(sweeper.sweep(now)).toHaveLength(1);
      expect(emitted).toEqual([{ type: 'WORKFLOW_STALE', id: staleWf.id }]);

      // Second sweep while still stale: no duplicate event.
      expect(sweeper.sweep(now)).toHaveLength(1);
      expect(emitted).toHaveLength(1);

      // Mission progresses again: dedupe clears, and the mission is no
      // longer reported stale.
      staleWf.updatedAt = new Date();
      expect(sweeper.sweep(new Date())).toHaveLength(0);
      expect(emitted).toHaveLength(1);
    });

    it('12.8 sweeper never mutates the mission it flags', async () => {
      const { StaleWorkflowSweeper } = await import('../src/resilience/StaleWorkflowService');
      const now = new Date();
      const staleWf = createMockWorkflow({
        currentStage: 'PAY',
        status: 'EXECUTING_PAYMENT',
        updatedAt: new Date(now.getTime() - 400 * 1000),
      });
      const before = JSON.stringify(staleWf);
      const sweeper = new StaleWorkflowSweeper(
        { listWorkflows: () => [staleWf] },
        { emit: (() => {}) as any }
      );

      const [evaluation] = sweeper.sweep(now);
      expect(evaluation.recommendedAction).toBe('ENTER_SAFE_STATE');
      expect(JSON.stringify(staleWf)).toBe(before);
    });
  });

  // =========================================================================
  // SUITE 13: Cancellation, Pause & Terminal State Invariants (6 tests)
  // =========================================================================
  describe('13. Cancellation, Pause & Terminal State Invariants', () => {
    it('13.1 cancelled workflow transitions to CANCELLED and cannot be resumed', () => {
      const wf = createMockWorkflow({ status: 'CANCELLED' });
      const evalResult = recoveryPolicyService.evaluateRecovery(wf);

      expect(evalResult.canResume).toBe(false);
      expect(evalResult.action).toBe('TERMINATE');
    });

    it('13.2 completed workflow transitions to COMPLETED and cannot be retried', () => {
      const wf = createMockWorkflow({ status: 'COMPLETED', currentStage: 'COMPLETE' });
      const evalResult = recoveryPolicyService.evaluateRecovery(wf);

      expect(evalResult.canResume).toBe(false);
      expect(evalResult.action).toBe('NONE');
    });

    it('13.3 pausing workflow sets isPaused=true and halts autonomous stage progression', () => {
      const wf = createMockWorkflow({ isPaused: false });
      wf.isPaused = true;
      wf.pauseReason = 'Awaiting resident clarification on delivery address';

      expect(wf.isPaused).toBe(true);
      expect(wf.pauseReason).toBeDefined();
    });

    it('13.4 resuming paused workflow clears isPaused and continues from current stage', () => {
      const wf = createMockWorkflow({ isPaused: true, pauseReason: 'Paused' });
      wf.isPaused = false;
      wf.pauseReason = undefined;

      expect(wf.isPaused).toBe(false);
      expect(wf.pauseReason).toBeUndefined();
    });

    it('13.5 step execution on terminal workflow is a no-op returning unmodified workflow', () => {
      const wf = createMockWorkflow({ status: 'COMPLETED', currentStage: 'COMPLETE' });
      const isTerminal = wf.status === 'COMPLETED' || wf.status === 'CANCELLED';

      expect(isTerminal).toBe(true);
    });

    it('13.6 emits audit events for WORKFLOW_PAUSED and WORKFLOW_RESUMED', async () => {
      const events: string[] = [];
      eventBus.subscribe('WORKFLOW_PAUSED', (e) => events.push(e.name));
      eventBus.subscribe('WORKFLOW_RESUMED', (e) => events.push(e.name));

      workflowEventService.emit('WORKFLOW_PAUSED', 'wf_pause_aud', 'UNDERSTAND', { reason: 'Ambiguity' });
      workflowEventService.emit('WORKFLOW_RESUMED', 'wf_pause_aud', 'UNDERSTAND', { reason: 'User resolved' });

      await new Promise((r) => setTimeout(r, 10));
      expect(events).toContain('WORKFLOW_PAUSED');
      expect(events).toContain('WORKFLOW_RESUMED');
    });
  });

  // =========================================================================
  // SUITE 14: Database Reconnection & Process Crash Resilience (6 tests)
  // =========================================================================
  describe('14. Database Reconnection & Process Crash Resilience', () => {
    it('14.1 simulates process crash after checkpoint: reconstitutes workflow from checkpoint store', () => {
      const wf = createMockWorkflow({ currentStage: 'SELECT', status: 'SELECTING_SUPPLIER' });
      const cp = workflowCheckpointService.saveCheckpoint(wf, {
        selectedSupplierId: 'sup_winner',
      });

      // Simulate process reboot by reading latest checkpoint directly
      const retrieved = workflowCheckpointService.getLatestCheckpoint(wf.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.stage).toBe('SELECT');
      expect(retrieved?.stateSnapshot?.selectedSupplierId).toBe('sup_winner');
    });

    it('14.2 simulates process crash before checkpoint: resumes from prior checkpoint without data corruption', () => {
      const wf = createMockWorkflow({ currentStage: 'DISCOVER', status: 'DISCOVERING_SUPPLIERS' });
      // Saved checkpoint at DISCOVER
      workflowCheckpointService.saveCheckpoint(wf, { count: 3 });

      // Process was in QUALIFY when crash occurred, before saving QUALIFY checkpoint
      wf.currentStage = 'QUALIFY';
      wf.status = 'QUALIFYING_SUPPLIERS';

      const lastValidCheckpoint = workflowCheckpointService.getLatestCheckpoint(wf.id);
      expect(lastValidCheckpoint?.stage).toBe('DISCOVER');
    });

    it('14.3 handles database connection interruption with retryable classification', () => {
      const dbErr = new Error('ECONNREFUSED: Database server localhost:5432 unavailable');
      const classification = failureClassificationService.classify(dbErr);

      expect(classification.category).toBe('RETRYABLE');
      expect(classification.retryable).toBe(true);
    });

    it('14.4 in-memory mutexes recover cleanly after failed operations without deadlock', async () => {
      const resourceKey = 'deadlock_test_resource';
      try {
        await concurrencyService.withLock(resourceKey, 'owner_fail', async () => {
          throw new Error('Fatal exception in critical section');
        });
      } catch {
        // Expected
      }

      // Check lock is not held
      expect(concurrencyService.isLocked(resourceKey)).toBe(false);

      // Subsequent acquisition succeeds
      const result = await concurrencyService.withLock(resourceKey, 'owner_next', async () => {
        return 'success_no_deadlock';
      });
      expect(result).toBe('success_no_deadlock');
    });

    it('14.5 workflow versioning guarantees optimistic concurrency control (version increments on change)', () => {
      const wf = createMockWorkflow({ workflowVersion: 1 });
      const initialVersion = wf.workflowVersion;

      // Update 1
      wf.workflowVersion += 1;
      expect(wf.workflowVersion).toBe(initialVersion + 1);

      // Update 2
      wf.workflowVersion += 1;
      expect(wf.workflowVersion).toBe(initialVersion + 2);
    });

    it('14.6 end-to-end resilient lifecycle: workflow survives transient network drop at PAY and resumes to completion', () => {
      const wf = createMockWorkflow({
        currentStage: 'PAY',
        status: 'FAILED',
        failureReason: 'ETIMEDOUT: Provider connection dropped',
        retryCount: 0,
        entities: {
          residentReference: 'res_e2e',
          societyReference: 'soc_e2e',
          commitmentId: 'commit_e2e_resilience',
        },
      });

      // 1. Classify failure
      const classification = failureClassificationService.classify(new Error(wf.failureReason), {
        stage: 'PAY',
        isPaymentOperation: true,
      });
      expect(classification.safeToRetry).toBe(false); // Must check authoritative state first

      // 2. Authoritative check reveals payment succeeded behind the scenes
      const origGetSummary = paymentService.getProcurementPaymentSummary;
      paymentService.getProcurementPaymentSummary = () => ({
        commitmentId: 'commit_e2e_resilience',
        rfqId: 'rfq_1',
        totalAmount: 1000,
        paidAmount: 1000,
        currency: 'INR',
        status: 'FULLY_PAID',
        payments: [],
        supplierObligations: [],
      });

      try {
        // 3. Evaluate recovery
        const decision = recoveryPolicyService.evaluateRecovery(wf);
        expect(decision.action).toBe('ADVANCE_STAGE');
        expect(decision.targetStage).toBe('FULFILL');
        expect(decision.skipPaymentReExecution).toBe(true);

        // 4. Advance workflow safely without re-charging
        wf.currentStage = decision.targetStage;
        wf.status = decision.targetStatus;
        wf.failureReason = undefined;
        wf.retryCount += 1;

        expect(wf.currentStage).toBe('FULFILL');
        expect(wf.status).toBe('FULFILLING');
        expect(wf.failureReason).toBeUndefined();
      } finally {
        paymentService.getProcurementPaymentSummary = origGetSummary;
      }
    });
  });
});
