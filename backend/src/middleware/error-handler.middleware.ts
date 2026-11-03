import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // eslint-disable-next-line no-console
  console.error('[Error Handler]', err);

  // 1. JSON parsing syntax error
  if (err instanceof SyntaxError && 'status' in err && (err as any).status === 400) {
    res.status(400).json({
      error: {
        code: 'MALFORMED_JSON',
        message: 'Invalid JSON payload received in request body.',
      },
    });
    return;
  }

  // 2. Application domain errors (AppError / ProcurementError)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // 3. Execution / Simulator domain errors
  if (
    err instanceof Error &&
    (err.name === 'ExecutionError' || err.name === 'DeliverySimulatorError')
  ) {
    const code = (err as any).code || 'EXECUTION_ERROR';
    const statusCode =
      code.includes('NOT_FOUND') ? 404 : code === 'TERMINAL_STATE_LOCKED' ? 409 : 400;
    res.status(statusCode).json({
      error: {
        code,
        message: err.message,
        details: (err as any).details,
      },
    });
    return;
  }

  // 4. Zod schema validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload.',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
    });
    return;
  }

  // 5. Prisma / Database errors - mask database internals and table names
  const isPrismaError =
    (err instanceof Error && err.name.startsWith('PrismaClient')) ||
    (typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      typeof (err as any).code === 'string' &&
      (err as any).code.startsWith('P'));

  if (isPrismaError) {
    res.status(400).json({
      error: {
        code: 'DATABASE_VALIDATION_ERROR',
        message: 'A database constraint or validation requirement was not met.',
      },
    });
    return;
  }

  // 6. Generic internal server error - NEVER expose stack traces to client
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred.',
    },
  });
}

