import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { SearchTelemetryService } from './search-telemetry.service.js';

/** Un Kysely que no habla con Postgres: guarda la consulta y devuelve las filas que se le dan. */
function fakeDb(rows: unknown[]) {
  const seen: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      seen.push(query);
      return Promise.resolve({ rows: rows as R[] });
    },
    streamQuery() {
      throw new Error('sin stream');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { database: { db } as unknown as DatabaseService, seen };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('calendario de precios (0094)', () => {
  it('siete días alrededor de la fecha, con precio donde hubo búsquedas y null donde no', async () => {
    const { database, seen } = fakeDb([
      { departure_date: '2026-12-08', min_price_minor: '97980000' },
      { departure_date: new Date('2026-12-10T00:00:00Z'), min_price_minor: 98796300 },
    ]);
    const out = await new SearchTelemetryService(database).priceCalendar(TENANT, {
      origin: 'CTG',
      destination: 'MIA',
      departureDate: '2026-12-09',
      cabin: 'economy',
      currency: 'COP',
      paxCount: { adults: 1, children: 0, infants: 0 },
    });
    expect(out.currency).toBe('COP');
    expect(out.days.map((d) => d.date)).toEqual([
      '2026-12-06',
      '2026-12-07',
      '2026-12-08',
      '2026-12-09',
      '2026-12-10',
      '2026-12-11',
      '2026-12-12',
    ]);
    expect(out.days.find((d) => d.date === '2026-12-08')?.minPriceMinor).toBe(97980000);
    expect(out.days.find((d) => d.date === '2026-12-10')?.minPriceMinor).toBe(98796300);
    expect(out.days.find((d) => d.date === '2026-12-09')?.minPriceMinor).toBeNull();
    expect(seen[0]?.sql).toMatch(/flight_price_calendar/);
    // Solo ida: sin noches de estadía.
    expect(seen[0]?.parameters).toContain(null);
  });

  it('ida y vuelta: pide la misma cantidad de noches', async () => {
    const { database, seen } = fakeDb([]);
    await new SearchTelemetryService(database).priceCalendar(TENANT, {
      origin: 'CTG',
      destination: 'MIA',
      departureDate: '2026-12-09',
      returnDate: '2026-12-19',
      cabin: 'economy',
      currency: 'COP',
      paxCount: { adults: 2, children: 1, infants: 0 },
    });
    expect(seen[0]?.parameters).toContain(10);
  });
});

describe('estado de proveedores para la agencia (0096)', () => {
  it('lee la función con la agencia y la ventana', async () => {
    const fila = {
      provider_code: 'sabre',
      vertical: 'flights',
      recent_searches: '5',
      recent_with_results: '5',
      provider_errors: '0',
      internal_errors: '0',
      last_result_at: null,
    };
    const { database, seen } = fakeDb([fila]);
    const rows = await new SearchTelemetryService(database).providerStatusRows(
      TENANT,
      new Date('2026-11-12T00:00:00Z'),
    );
    expect(rows).toEqual([fila]);
    expect(seen[0]?.sql).toMatch(/provider_search_status/);
    expect(seen[0]?.parameters).toContain(TENANT);
  });
});
