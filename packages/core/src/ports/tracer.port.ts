export interface SpanPort {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: Error): void;
  end(): void;
}

export interface TracerPort {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): SpanPort;
}
