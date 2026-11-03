import { Router } from 'express';
import { agentController } from '../controllers/agent.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// POST /api/agent/run (session owner only: starts a money-moving mission)
router.post('/run', requireAuth, (req, res, next) => agentController.run(req, res, next));

// POST /api/agent/workflow/:id/cancel (session owner only)
router.post('/workflow/:id/cancel', requireAuth, (req, res, next) =>
  agentController.cancelWorkflow(req, res, next)
);

// POST /api/agent/workflow/:id/restore (session owner only)
// Re-registers a mission from its durable record after a backend restart.
router.post('/workflow/:id/restore', requireAuth, (req, res, next) =>
  agentController.restoreWorkflow(req, res, next)
);

export const agentRoutes = router;

