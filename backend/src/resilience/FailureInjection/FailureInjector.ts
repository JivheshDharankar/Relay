import { FailureScenario, InjectedFailureRule } from './FailureScenario';

export class FailureInjector {
  private activeRules = new Map<string, InjectedFailureRule>();
  private failureHistory: Array<{ point: string; scenario: FailureScenario; timestamp: Date }> = [];

  /**
   * Registers an injected failure rule for a specific target interception point.
   */
  public registerFailure(
    point: string,
    scenario: FailureScenario,
    options: { count?: number; error?: Error; delayMs?: number } = {}
  ): void {
    this.activeRules.set(point, {
      scenario,
      remainingCount: options.count ?? 1,
      customError: options.error,
      delayMs: options.delayMs,
    });
  }

  /**
   * Tests whether an interception point should trigger a failure, and throws the designated error if active.
   */
  public async maybeThrow(point: string): Promise<void> {
    const rule = this.activeRules.get(point);
    if (!rule) return;

    if (rule.remainingCount !== undefined) {
      if (rule.remainingCount <= 0) {
        this.activeRules.delete(point);
        return;
      }
      rule.remainingCount -= 1;
      if (rule.remainingCount === 0) {
        this.activeRules.delete(point);
      }
    }

    if (rule.delayMs && rule.delayMs > 0) {
      await new Promise((r) => setTimeout(r, rule.delayMs));
    }

    this.failureHistory.push({
      point,
      scenario: rule.scenario,
      timestamp: new Date(),
    });

    if (rule.customError) {
      throw rule.customError;
    }

    throw this.createStandardError(rule.scenario, point);
  }

  /**
   * Synchronous check & throw for non-async interception points.
   */
  public maybeThrowSync(point: string): void {
    const rule = this.activeRules.get(point);
    if (!rule) return;

    if (rule.remainingCount !== undefined) {
      if (rule.remainingCount <= 0) {
        this.activeRules.delete(point);
        return;
      }
      rule.remainingCount -= 1;
      if (rule.remainingCount === 0) {
        this.activeRules.delete(point);
      }
    }

    this.failureHistory.push({
      point,
      scenario: rule.scenario,
      timestamp: new Date(),
    });

    if (rule.customError) {
      throw rule.customError;
    }

    throw this.createStandardError(rule.scenario, point);
  }

  public shouldFail(point: string): boolean {
    const rule = this.activeRules.get(point);
    return Boolean(rule && (rule.remainingCount === undefined || rule.remainingCount > 0));
  }

  public clear(): void {
    this.activeRules.clear();
    this.failureHistory = [];
  }

  public getHistory(): Array<{ point: string; scenario: FailureScenario; timestamp: Date }> {
    return [...this.failureHistory];
  }

  private createStandardError(scenario: FailureScenario, point: string): Error {
    switch (scenario) {
      case FailureScenario.NETWORK_TIMEOUT:
        return new Error(`ETIMEDOUT: Connection timed out at '${point}'`);
      case FailureScenario.HTTP_429_RATE_LIMIT:
        return new Error(`HTTP 429 Too Many Requests: Rate limit exceeded at '${point}'`);
      case FailureScenario.HTTP_500_INTERNAL_SERVER_ERROR:
        return new Error(`HTTP 500 Internal Server Error at '${point}'`);
      case FailureScenario.HTTP_503_SERVICE_UNAVAILABLE:
        return new Error(`HTTP 503 Service Unavailable: Downstream outage at '${point}'`);
      case FailureScenario.HTTP_504_GATEWAY_TIMEOUT:
        return new Error(`HTTP 504 Gateway Timeout at '${point}'`);
      case FailureScenario.PAYMENT_TIMEOUT_AFTER_SUBMIT:
        return new Error(`PAYMENT_TIMEOUT_AFTER_SUBMIT: Network lost after bank debit dispatched`);
      case FailureScenario.PAYMENT_DECLINED:
        return new Error(`PAYMENT_DECLINED: Card/bank rejected transaction at '${point}'`);
      case FailureScenario.MANDATE_LIMIT_EXCEEDED:
        return new Error(`MANDATE_LIMIT_EXCEEDED: Spending threshold exceeded for mandate at '${point}'`);
      case FailureScenario.SUPPLIER_REJECTION:
        return new Error(`SUPPLIER_REJECTION: Supplier declined purchase order at '${point}'`);
      case FailureScenario.PARTIAL_DELIVERY:
        return new Error(`PARTIAL_DELIVERY: Supplier delivered fewer units than committed at '${point}'`);
      case FailureScenario.DELIVERY_DELAY_SLA:
        return new Error(`DELIVERY_DELAY_SLA: Expected delivery exceeded committed SLA at '${point}'`);
      case FailureScenario.RECONCILIATION_ARITHMETIC_MISMATCH:
        return new Error(`RECONCILIATION_ARITHMETIC_MISMATCH: Monetary allocations do not balance at '${point}'`);
      case FailureScenario.AI_MALFORMED_JSON:
        return new SyntaxError(`Unexpected token < in JSON at position 0 from AI model`);
      case FailureScenario.AI_HALLUCINATED_PRICE:
        return new Error(`AI_HALLUCINATED_PRICE: Extracted unit price is negative or zero`);
      case FailureScenario.DATABASE_CONNECTION_LOST:
        return new Error(`ECONNREFUSED: Database connection dropped at '${point}'`);
      case FailureScenario.CRASH_BEFORE_CHECKPOINT:
        return new Error(`CRASH_BEFORE_CHECKPOINT: Process killed before checkpoint persisted`);
      case FailureScenario.CRASH_AFTER_CHECKPOINT:
        return new Error(`CRASH_AFTER_CHECKPOINT: Process killed immediately after checkpoint persisted`);
      default:
        return new Error(`Injected failure scenario '${scenario}' triggered at '${point}'`);
    }
  }
}

export const failureInjector = new FailureInjector();

