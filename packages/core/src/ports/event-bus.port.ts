export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  tenantId: string;
  occurredAt: Date;
  payload: T;
  correlationId?: string;
  causationId?: string;
}

export interface EventBusPort {
  publish<T>(event: DomainEvent<T>): Promise<void>;
}
