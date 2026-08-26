import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { SearchTelemetryService } from './search-telemetry.service.js';

/**
 * Red de seguridad del ESCRITOR de `search_logs`.
 *
 * La migración 0035 creó `search_group_id` y cambió `count_recent_searches` a contar por
 * grupo, pero nadie escribía la columna: la telemetría seguía metiendo UNA fila por búsqueda
 * con los códigos de proveedor concatenados. Con eso, el criterio "N búsquedas × M
 * proveedores cuentan N" se cumplía por accidente —había una sola fila— y la pregunta que
 * justifica la tabla ("¿cuál de los proveedores está degradado?") no tenía respuesta.
 *
 * Lo que se fija acá: una fila POR PROVEEDOR, todas del MISMO grupo. Nada de esto depende de
 * qué proveedor entre segundo: los códigos son stubs anónimos.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ALFA = 'alfa-air';
const BETA = 'beta-air';

/** UUID v4 en cualquiera de sus formas canónicas: la columna del grupo es UUID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Fila {
  tenant_id: string;
  search_group_id: string | null;
  provider_code: string;
  vertical: string;
  duration_ms: number;
  result_count: number;
  outcome: string;
  error_code: string | null;
  criteria: string;
}

function banco(opts: { insertFalla?: boolean } = {}) {
  const lotes: Fila[][] = [];

  const db = {
    db: {
      insertInto: (table: string) => {
        expect(table).toBe('search_logs');
        return {
          values: (rows: Fila | Fila[]) => ({
            execute: () => {
              if (opts.insertFalla) return Promise.reject(new Error('conexión caída'));
              lotes.push(Array.isArray(rows) ? rows : [rows]);
              return Promise.resolve([]);
            },
          }),
        };
      },
    },
  } as unknown as DatabaseService;

  return {
    service: new SearchTelemetryService(db),
    /** Cada elemento es un INSERT; dentro, sus filas. */
    lotes,
    filas: (): Fila[] => lotes.flat(),
    grupos: (): Set<string | null> => new Set(lotes.flat().map((f) => f.search_group_id)),
  };
}

describe('SearchTelemetryService.record', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('escribe UNA FILA POR PROVEEDOR, todas con el mismo search_group_id', async () => {
    const b = banco();

    await b.service.record({
      tenantId: TENANT,
      vertical: 'flights',
      providers: [
        { providerCode: ALFA, durationMs: 120, resultCount: 4, outcome: 'ok' },
        { providerCode: BETA, durationMs: 980, resultCount: 0, outcome: 'empty' },
      ],
    });

    const filas = b.filas();
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.provider_code).sort()).toEqual([ALFA, BETA]);

    // Un solo grupo, y con forma de UUID: si fuera null, la cuota contaría cada fila aparte
    // y una agencia con dos proveedores gastaría su plan al doble de velocidad.
    expect(b.grupos().size).toBe(1);
    expect(filas[0]!.search_group_id).toMatch(UUID_RE);
    expect(filas[1]!.search_group_id).toBe(filas[0]!.search_group_id);
  });

  it('la latencia y el resultado quedan atribuidos a CADA proveedor, no agregados', async () => {
    // Es la razón de ser del cambio: con los códigos concatenados en una fila no se podía
    // decir cuál de los dos tardó 980 ms ni cuál no aportó ninguna oferta.
    const b = banco();

    await b.service.record({
      tenantId: TENANT,
      vertical: 'flights',
      providers: [
        { providerCode: ALFA, durationMs: 120, resultCount: 4, outcome: 'ok' },
        { providerCode: BETA, durationMs: 980, resultCount: 0, outcome: 'empty' },
      ],
    });

    const porCodigo = new Map(b.filas().map((f) => [f.provider_code, f]));
    expect(porCodigo.get(ALFA)).toMatchObject({ duration_ms: 120, result_count: 4, outcome: 'ok' });
    expect(porCodigo.get(BETA)).toMatchObject({
      duration_ms: 980,
      result_count: 0,
      outcome: 'empty',
    });
    // Ningún `provider_code` compuesto: cada fila nombra a UN proveedor.
    for (const f of b.filas()) expect(f.provider_code).not.toContain('+');
  });

  it('las N filas van en un solo INSERT: media búsqueda registrada no es un estado válido', async () => {
    const b = banco();

    await b.service.record({
      tenantId: TENANT,
      vertical: 'flights',
      providers: [
        { providerCode: ALFA, durationMs: 10, resultCount: 1, outcome: 'ok' },
        { providerCode: BETA, durationMs: 20, resultCount: 1, outcome: 'ok' },
      ],
    });

    expect(b.lotes).toHaveLength(1);
    expect(b.lotes[0]).toHaveLength(2);
  });

  it('dos búsquedas distintas no comparten grupo', async () => {
    const b = banco();
    const una = {
      tenantId: TENANT,
      vertical: 'flights' as const,
      providers: [{ providerCode: ALFA, durationMs: 10, resultCount: 1, outcome: 'ok' as const }],
    };

    await b.service.record(una);
    await b.service.record(una);

    expect(b.grupos().size).toBe(2);
  });

  it('sin proveedores activos deja constancia igual, para que la búsqueda cuente en la cuota', async () => {
    // Un tenant sin ninguna credencial cargada no puede machacar el endpoint gratis.
    const b = banco();

    await b.service.record({ tenantId: TENANT, vertical: 'flights', providers: [] });

    const filas = b.filas();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ provider_code: 'none', outcome: 'empty', result_count: 0 });
    expect(filas[0]!.search_group_id).toMatch(UUID_RE);
  });

  it('redondea y nunca escribe una duración negativa', async () => {
    const b = banco();

    await b.service.record({
      tenantId: TENANT,
      vertical: 'hotels',
      providers: [
        { providerCode: ALFA, durationMs: 12.6, resultCount: 0, outcome: 'empty' },
        { providerCode: BETA, durationMs: -5, resultCount: 0, outcome: 'empty' },
      ],
    });

    expect(b.filas().map((f) => f.duration_ms)).toEqual([13, 0]);
  });

  it('un fallo del INSERT no rompe la búsqueda ni filtra los criterios al log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const b = banco({ insertFalla: true });

    await expect(
      b.service.record({
        tenantId: TENANT,
        vertical: 'flights',
        providers: [{ providerCode: ALFA, durationMs: 10, resultCount: 1, outcome: 'ok' }],
        criteria: { origin: 'BOG', destination: 'LIM' },
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('BOG');
  });
});

describe('SearchTelemetryService.instrument', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('con desglose, escribe la fila de cada proveedor bajo un único grupo', async () => {
    const b = banco();

    const res = await b.service.instrument(
      { tenantId: TENANT, vertical: 'flights', providerCodes: [ALFA, BETA] },
      () => Promise.resolve({ offers: 6 }),
      (r) => r.offers,
      () => false,
      () => [
        { providerCode: ALFA, durationMs: 111, resultCount: 6, outcome: 'ok' },
        { providerCode: BETA, durationMs: 222, resultCount: 0, outcome: 'error', errorCode: 'E' },
      ],
    );

    expect(res).toEqual({ offers: 6 });
    const filas = b.filas();
    expect(filas).toHaveLength(2);
    expect(b.grupos().size).toBe(1);
    expect(filas.find((f) => f.provider_code === BETA)).toMatchObject({
      outcome: 'error',
      error_code: 'E',
    });
  });

  it('sin desglose atribuye la búsqueda a cada código declarado', async () => {
    const b = banco();

    await b.service.instrument(
      { tenantId: TENANT, vertical: 'hotels', providerCodes: [ALFA] },
      () => Promise.resolve([1, 2, 3]),
      (r) => r.length,
    );

    expect(b.filas()).toHaveLength(1);
    expect(b.filas()[0]).toMatchObject({ provider_code: ALFA, result_count: 3, outcome: 'ok' });
  });

  it('marca `simulated` aparte: contarlo como éxito falsearía la tasa real', async () => {
    const b = banco();

    await b.service.instrument(
      { tenantId: TENANT, vertical: 'flights', providerCodes: [ALFA] },
      () => Promise.resolve({ n: 2 }),
      (r) => r.n,
      () => true,
    );

    expect(b.filas()[0]).toMatchObject({ outcome: 'simulated' });
  });

  it('si `run` explota, escribe una fila de error por proveedor declarado y propaga', async () => {
    const b = banco();

    class ProviderDownError extends Error {
      override readonly name = 'ProviderDownError';
    }

    await expect(
      b.service.instrument(
        { tenantId: TENANT, vertical: 'flights', providerCodes: [ALFA, BETA] },
        () => Promise.reject(new ProviderDownError('todos caídos')),
        () => 0,
      ),
    ).rejects.toBeInstanceOf(ProviderDownError);

    const filas = b.filas();
    expect(filas).toHaveLength(2);
    expect(b.grupos().size).toBe(1);
    for (const f of filas) {
      expect(f).toMatchObject({ outcome: 'error', error_code: 'ProviderDownError' });
    }
  });

  it('un desglose vacío cae al reparto uniforme en vez de perder la búsqueda', async () => {
    // Si se perdiera, la búsqueda no contaría para la cuota.
    const b = banco();

    await b.service.instrument(
      { tenantId: TENANT, vertical: 'flights', providerCodes: [ALFA] },
      () => Promise.resolve(0),
      (r) => r,
      () => false,
      () => [],
    );

    expect(b.filas()).toHaveLength(1);
    expect(b.filas()[0]).toMatchObject({ provider_code: ALFA, outcome: 'empty' });
  });
});
