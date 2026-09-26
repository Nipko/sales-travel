import type { ExecutionContext } from '@nestjs/common';
import { Subject, lastValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  HTTP_HANDLER_WORK_KIND,
  InflightHandlersInterceptor,
} from './inflight-handlers.interceptor.js';
import { InflightWorkRegistry } from './inflight-work.registry.js';

/** Handlers HTTP como trabajo en curso del apagado ordenado (docs/tbo/09 PR-4.10). */

const context = {} as ExecutionContext;

describe('InflightHandlersInterceptor', () => {
  it('cuenta el handler desde que entra hasta que termina', async () => {
    const registry = new InflightWorkRegistry();
    const interceptor = new InflightHandlersInterceptor(registry);
    const handler = new Subject<string>();

    const result = lastValueFrom(
      interceptor.intercept(context, { handle: () => handler.asObservable() }),
    );
    expect(registry.countsByKind()).toEqual({ [HTTP_HANDLER_WORK_KIND]: 1 });

    handler.next('ok');
    handler.complete();
    await expect(result).resolves.toBe('ok');
    expect(registry.size).toBe(0);
  });

  it('un handler que falla también libera el registro', async () => {
    const registry = new InflightWorkRegistry();
    const interceptor = new InflightHandlersInterceptor(registry);

    const result = lastValueFrom(
      interceptor.intercept(context, {
        handle: () => throwError(() => new Error('BOOK_FAILED')),
      }),
    );

    await expect(result).rejects.toThrow('BOOK_FAILED');
    expect(registry.size).toBe(0);
  });
});
