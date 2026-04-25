export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', { resource, id });
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', meta);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN');
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super(message, 'CONFLICT', meta);
  }
}

export class ProviderError extends DomainError {
  constructor(provider: string, message: string, meta?: Record<string, unknown>) {
    super(`[${provider}] ${message}`, 'PROVIDER_ERROR', { provider, ...meta });
  }
}

export class TenantIsolationError extends DomainError {
  constructor(message = 'Cross-tenant access denied') {
    super(message, 'TENANT_ISOLATION');
  }
}
