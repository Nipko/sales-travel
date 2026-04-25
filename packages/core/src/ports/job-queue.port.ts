export interface JobOptions {
  delayMs?: number;
  attempts?: number;
  backoff?: { type: 'exponential' | 'fixed'; delayMs: number };
  idempotencyKey?: string;
}

export interface JobQueuePort {
  enqueue<T>(queue: string, payload: T, options?: JobOptions): Promise<string>;
}
