import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { ProviderDisclosureService } from './provider-disclosure.service.js';

/**
 * El servicio por su puerta pública, con la base sustituida por las filas que devolvería
 * `provider_disclosure_chain` (0036). Lo que se ejercita acá es el camino real: mapear la
 * fila, plegar la cadena y escribir el valor propio.
 *
 * El ejecutor falso es el mínimo que consume `sql\`...\`.execute(db)` de kysely: compilar
 * la consulta y devolver filas. No prueba el SQL —eso es
 * `provider-disclosure.integration.test.ts`, que necesita base—, prueba lo que el servicio
 * hace con lo que el SQL le entrega.
 */

const CONSOLIDADOR = '11111111-1111-4111-8111-111111111111';
const AGENCIA = '22222222-2222-4222-8222-222222222222';

interface ChainRow {
  tenant_id: string;
  lvl: number;
  show_provider_in_results: boolean | null;
}

function ejecutorCon(rows: readonly ChainRow[]) {
  return {
    transformQuery: (node: unknown) => node,
    compileQuery: () => ({ sql: '', parameters: [] }),
    executeQuery: () => Promise.resolve({ rows }),
  };
}

interface Banco {
  service: ProviderDisclosureService;
  /** Lo último que se escribió en `tenants`, para afirmar sobre el UPDATE. */
  escrito: () => Record<string, unknown> | null;
}

function banco(rows: readonly ChainRow[]): Banco {
  let escrito: Record<string, unknown> | null = null;

  const trx = {
    updateTable: () => ({
      set: (values: Record<string, unknown>) => {
        escrito = values;
        return { where: () => ({ execute: () => Promise.resolve([]) }) };
      },
    }),
  };

  const db = {
    db: { getExecutor: () => ejecutorCon(rows) },
    withRequestContext: (_ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(trx),
  } as unknown as DatabaseService;

  return { service: new ProviderDisclosureService(db), escrito: () => escrito };
}

describe('ProviderDisclosureService.view', () => {
  it('pliega la cadena que devuelve la base: el "oculto" del consolidador manda', async () => {
    const { service } = banco([
      { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: false },
      { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: true },
    ]);

    const view = await service.view(AGENCIA);
    expect(view.effective).toBe(false);
    expect(view.lockedByAncestor).toBe(true);
    expect(view.own).toBe(true);
  });

  it('la agencia sin valor propio hereda el del consolidador', async () => {
    const { service } = banco([
      { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: true },
      { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: null },
    ]);

    const view = await service.view(AGENCIA);
    expect(view.effective).toBe(true);
    expect(view.own).toBeNull();
  });
});

describe('ProviderDisclosureService.effective', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('si la base no contesta, oculta: nunca se filtra el proveedor por un fallo', async () => {
    const db = {
      db: {
        getExecutor: () => {
          throw new Error('base caída');
        },
      },
    } as unknown as DatabaseService;

    await expect(new ProviderDisclosureService(db).effective(AGENCIA)).resolves.toBe(false);
  });

  it('pero el fallo se DICE: recuperarse en silencio esconde una base rota', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = {
      db: {
        getExecutor: () => {
          throw new Error('base caída');
        },
      },
    } as unknown as DatabaseService;

    await new ProviderDisclosureService(db).effective(AGENCIA);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('base caída'));
  });
});

describe('ProviderDisclosureService.setOwn', () => {
  it('escribe el booleano en la columna del tenant', async () => {
    const { service, escrito } = banco([
      { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: true },
    ]);

    await service.setOwn(AGENCIA, true, 'u1');
    expect(escrito()).toEqual({ show_provider_in_results: true });
  });

  it('`null` se guarda como null —volver a heredar—, no como `false`', async () => {
    const { service, escrito } = banco([
      { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: null },
    ]);

    await service.setOwn(AGENCIA, null, 'u1');
    expect(escrito()).toEqual({ show_provider_in_results: null });
  });

  it('devuelve la vista RECALCULADA: guardar bajo un padre que oculta no muestra nada', async () => {
    const { service } = banco([
      { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: false },
      { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: true },
    ]);

    const view = await service.setOwn(AGENCIA, true, 'u1');
    expect(view.effective).toBe(false);
    expect(view.lockedByAncestor).toBe(true);
  });
});
