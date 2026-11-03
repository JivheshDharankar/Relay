import { Router } from 'express';
import { healthController } from '../controllers/health.controller';

const router = Router();

router.get('/', (req, res, next) => {
  healthController.getHealth(req, res, next);
});

export const healthRoutes = router;

