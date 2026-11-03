import { z } from 'zod';
import { ToolDefinition } from '../model/types';

export interface ToolExecutionContext {
  residentId: string;
  societyId: string;
  runId?: string;
  requestId?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

export interface RelayTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  getDefinition(): ToolDefinition;
  execute(args: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
}
