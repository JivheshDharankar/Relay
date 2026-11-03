import { RelayTool, ToolExecutionContext } from './types';
import { ToolDefinition } from '../model/types';
import { ZodError } from 'zod';

export class ToolExecutionError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
    this.details = details;
  }
}

export class ToolRegistry {
  private tools = new Map<string, RelayTool>();

  public register(tool: RelayTool): void {
    this.tools.set(tool.name, tool);
  }

  public get(name: string): RelayTool | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public list(): RelayTool[] {
    return Array.from(this.tools.values());
  }

  public getDefinitions(): ToolDefinition[] {
    return this.list().map((t) => t.getDefinition());
  }

  /**
   * Executes a registered tool by name with strict schema validation
   * and execution context isolation.
   */
  public async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: ToolExecutionContext
  ): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolExecutionError(
        'UNKNOWN_TOOL',
        `Tool '${name}' is not registered in Relay ToolRegistry`
      );
    }

    // 1. Strict Schema Validation
    let validatedArgs: any;
    try {
      validatedArgs = tool.schema.parse(rawArgs);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ToolExecutionError(
          'INVALID_TOOL_ARGUMENT',
          `Malformed arguments for tool '${name}': ${err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
          err.errors
        );
      }
      throw err;
    }

    // 2. Controlled Execution
    return tool.execute(validatedArgs, ctx);
  }
}

export const toolRegistry = new ToolRegistry();

