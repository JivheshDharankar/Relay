/**
 * Relay Event / Audit System Baseline
 * Prepares the architecture for deterministic event recording and audit log persistence.
 */

export interface RelayDomainEvent<T = unknown> {
  id: string;
  name: string;
  aggregateId?: string;
  timestamp: string;
  payload: T;
}

export type EventHandler<T = unknown> = (event: RelayDomainEvent<T>) => Promise<void> | void;

export class InMemoryEventBus {
  private handlers = new Map<string, EventHandler[]>();

  public subscribe<T>(eventName: string, handler: EventHandler<T>): void {
    const existing = this.handlers.get(eventName) || [];
    this.handlers.set(eventName, [...existing, handler as EventHandler]);
  }

  public unsubscribe<T>(eventName: string, handler?: EventHandler<T>): void {
    if (!handler) {
      this.handlers.delete(eventName);
      return;
    }
    const existing = this.handlers.get(eventName) || [];
    this.handlers.set(
      eventName,
      existing.filter((h) => h !== (handler as EventHandler))
    );
  }

  public clear(): void {
    this.handlers.clear();
  }

  public async publish<T>(event: RelayDomainEvent<T>): Promise<void> {
    const handlers = this.handlers.get(event.name) || [];
    await Promise.all(handlers.map((fn) => fn(event)));
  }
}

export const eventBus = new InMemoryEventBus();

