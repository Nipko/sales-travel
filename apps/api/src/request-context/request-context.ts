import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  userId?: string;
  tenantId?: string;
  requestId?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function currentUserId(): string | undefined {
  return requestContextStorage.getStore()?.userId;
}

export function currentTenantId(): string | undefined {
  return requestContextStorage.getStore()?.tenantId;
}
