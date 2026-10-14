import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TICKET_DOCUMENT_KINDS,
  TICKET_DOCUMENT_STATUSES,
  TICKETING_DEADLINE_ZONES as DOMAIN_DEADLINE_ZONES,
  type OrderView,
  type TicketDocument,
} from '@sales-travel/domain';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import {
  FLIGHT_DOCUMENT_KINDS,
  FLIGHT_DOCUMENT_STATUSES,
  TICKETING_DEADLINE_ZONES,
  type DB,
} from '../database/database.types.js';
import {
  FlightOrderTrackingStore,
  deadlineInstant,
  flightReadOf,
  nextFlightDocumentState,
  publicFlightOrderTracking,
  type StoredFlightDocument,
} from './flight-order-tracking.store.js';

/**
 * El seguimiento de una orden de vuelo (0082) sin Postgres: las reglas puras (qué se guarda de una
 * lectura, cómo cambia un documento, qué sale por la API), el vocabulario contra los CHECK de la
 * migración y el SQL que el store manda, con el compilador REAL de Postgres de Kysely. Contra
 * Postgres de verdad, con RLS, corre `flight-order-tracking.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';
const AHORA = new Date('2026-10-13T15:00:00.000Z');
const TIQUETE = '0457123456789';

function vista(extra: Partial<OrderView> = {}): OrderView {
  return { found: true, airlineLocators: [], warnings: [], ...extra };
}

function emitido(extra: Partial<TicketDocument> = {}): TicketDocument {
  return { number: TIQUETE, kind: 'TICKET', status: 'ISSUED', providerStatusCode: 'TE', ...extra };
}

function guardado(extra: Partial<StoredFlightDocument> = {}): StoredFlightDocument {
  return {
    number: TIQUETE,
    kind: 'TICKET',
    travelerIndex: 0,
    status: 'ISSUED',
    providerStatusCode: 'TE',
    ...extra,
  };
}

describe('flightReadOf — lo que una lectura deja escrito', () => {
  it('localizadores válidos, sin repetir y en orden; lo que no encaja se descarta', () => {
    const read = flightReadOf(
      vista({
        airlineLocators: [
          { carrierCode: 'LA', locator: 'XKCD12' },
          { carrierCode: 'LA', locator: 'XKCD12' },
          { carrierCode: 'UAD', locator: 'MFFPXC' },
          { carrierCode: 'la', locator: 'XKCD12' },
          { carrierCode: 'AV', locator: 'ab<script>' },
        ],
      }),
      AHORA,
    );
    expect(read.airlineLocators).toEqual([
      { carrierCode: 'LA', locator: 'XKCD12' },
      { carrierCode: 'UAD', locator: 'MFFPXC' },
    ]);
    expect(read.at).toBe(AHORA);
  });

  it('los documentos del adapter, validados y uno por número (gana el estado terminal)', () => {
    const read = flightReadOf(
      vista({
        documents: [
          emitido({ travelerIndex: 0 }),
          emitido({ status: 'REFUNDED', providerStatusCode: 'TR' }),
          emitido({ number: '12345' }),
          emitido({ number: '1251934576908', kind: 'EMD', providerStatusCode: 'me' }),
        ],
      }),
      AHORA,
    );
    expect(read.documents).toEqual([emitido({ status: 'REFUNDED', providerStatusCode: 'TR' })]);
  });

  it('sin `documents`, los `ticketNumbers` son tiquetes sin confirmar (LATAM)', () => {
    const read = flightReadOf(
      vista({ ticketNumbers: [TIQUETE, TIQUETE, '045-7123456789'] }),
      AHORA,
    );
    expect(read.documents).toEqual([{ number: TIQUETE, kind: 'TICKET', status: 'UNKNOWN' }]);
  });

  it('con `documents` presente y vacío, no se cae a `ticketNumbers`', () => {
    const read = flightReadOf(vista({ documents: [], ticketNumbers: [TIQUETE] }), AHORA);
    expect(read.documents).toEqual([]);
  });

  it('un plazo válido pasa; uno que no existe en el calendario o con hora rara, no', () => {
    expect(
      flightReadOf(
        vista({ ticketingDeadline: { date: '2026-10-20', time: '15:00', zone: 'PROVIDER_LOCAL' } }),
        AHORA,
      ).ticketingDeadline,
    ).toEqual({ date: '2026-10-20', time: '15:00', zone: 'PROVIDER_LOCAL' });
    expect(
      flightReadOf(vista({ ticketingDeadline: { date: '2026-10-20', zone: 'UTC' } }), AHORA)
        .ticketingDeadline,
    ).toEqual({ date: '2026-10-20', zone: 'UTC' });
    for (const ticketingDeadline of [
      { date: '2026-02-30', zone: 'UTC' as const },
      { date: '2026-10-20', time: '25:00', zone: 'UTC' as const },
      { date: '2026-10-20', zone: 'LOCAL' as never },
    ]) {
      expect(flightReadOf(vista({ ticketingDeadline }), AHORA)).not.toHaveProperty(
        'ticketingDeadline',
      );
    }
  });
});

describe('nextFlightDocumentState — la transición de un documento', () => {
  it('uno nuevo se agrega con el instante de su estado', () => {
    expect(nextFlightDocumentState(undefined, emitido({ travelerIndex: 1 }), AHORA)).toEqual({
      change: 'added',
      kind: 'TICKET',
      status: 'ISSUED',
      travelerIndex: 1,
      providerStatusCode: 'TE',
      issuedAt: AHORA,
    });
    expect(
      nextFlightDocumentState(
        undefined,
        emitido({ status: 'VOIDED', providerStatusCode: 'OV' }),
        AHORA,
      ),
    ).toMatchObject({ change: 'added', status: 'VOIDED', voidedAt: AHORA, travelerIndex: null });
  });

  it('emitido → anulado o devuelto es un cambio de estado, con su instante', () => {
    expect(
      nextFlightDocumentState(
        guardado(),
        emitido({ status: 'VOIDED', providerStatusCode: 'OV' }),
        AHORA,
      ),
    ).toEqual({
      change: 'status',
      kind: 'TICKET',
      status: 'VOIDED',
      travelerIndex: 0,
      providerStatusCode: 'OV',
      voidedAt: AHORA,
    });
    expect(
      nextFlightDocumentState(
        guardado(),
        emitido({ status: 'REFUNDED', providerStatusCode: 'TR' }),
        AHORA,
      ),
    ).toMatchObject({ change: 'status', status: 'REFUNDED', refundedAt: AHORA });
  });

  it('un estado terminal no vuelve a emitido ni a desconocido', () => {
    const anulado = guardado({ status: 'VOIDED', providerStatusCode: 'OV' });
    expect(nextFlightDocumentState(anulado, emitido(), AHORA)).toMatchObject({
      change: 'detail',
      status: 'VOIDED',
    });
    expect(
      nextFlightDocumentState(
        anulado,
        emitido({ status: 'UNKNOWN', providerStatusCode: 'OV' }),
        AHORA,
      ),
    ).toBeNull();
  });

  it('entre terminales manda la lectura nueva', () => {
    expect(
      nextFlightDocumentState(
        guardado({ status: 'VOIDED' }),
        emitido({ status: 'EXCHANGED', providerStatusCode: undefined }),
        AHORA,
      ),
    ).toMatchObject({ change: 'status', status: 'EXCHANGED' });
  });

  it('UNKNOWN no pisa un estado ni un tipo conocidos, pero deja su código', () => {
    const emd = guardado({ kind: 'EMD', providerStatusCode: 'ME' });
    expect(
      nextFlightDocumentState(emd, emitido({ status: 'UNKNOWN', providerStatusCode: 'XX' }), AHORA),
    ).toEqual({
      change: 'detail',
      kind: 'EMD',
      status: 'ISSUED',
      travelerIndex: 0,
      providerStatusCode: 'XX',
    });
  });

  it('un desconocido que pasa a conocido es un cambio de estado', () => {
    expect(
      nextFlightDocumentState(
        guardado({ status: 'UNKNOWN', providerStatusCode: null }),
        emitido(),
        AHORA,
      ),
    ).toMatchObject({ change: 'status', status: 'ISSUED', issuedAt: AHORA });
  });

  it('la misma lectura otra vez no escribe nada; sin pasajero se conserva el guardado', () => {
    expect(nextFlightDocumentState(guardado(), emitido(), AHORA)).toBeNull();
    expect(nextFlightDocumentState(guardado({ travelerIndex: 2 }), emitido(), AHORA)).toBeNull();
    expect(nextFlightDocumentState(guardado(), emitido({ travelerIndex: 1 }), AHORA)).toMatchObject(
      { change: 'detail', travelerIndex: 1 },
    );
  });
});

describe('publicFlightOrderTracking — lo que sale por la API', () => {
  it('localizadores, documentos sin código del proveedor y el plazo con su instante en ISO', () => {
    const at = new Date('2026-10-20T20:00:00.000Z');
    expect(
      publicFlightOrderTracking({
        orderId: ORDEN,
        airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
        documents: [guardado({ travelerIndex: null })],
        ticketingDeadline: { date: '2026-10-20', time: '20:00', zone: 'UTC', at },
        lastReadAt: AHORA,
      }),
    ).toEqual({
      airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
      documents: [{ number: TIQUETE, kind: 'TICKET', status: 'ISSUED', travelerIndex: null }],
      ticketingDeadline: {
        date: '2026-10-20',
        time: '20:00',
        zone: 'UTC',
        at: '2026-10-20T20:00:00.000Z',
      },
    });
  });

  it('sin plazo, `null`; con la hora de la oficina, sin instante', () => {
    const base = {
      orderId: ORDEN,
      airlineLocators: [],
      documents: [],
      lastReadAt: null,
    };
    expect(publicFlightOrderTracking({ ...base, ticketingDeadline: null }).ticketingDeadline).toBe(
      null,
    );
    expect(
      publicFlightOrderTracking({
        ...base,
        ticketingDeadline: { date: '2026-10-20', zone: 'PROVIDER_LOCAL' },
      }).ticketingDeadline,
    ).toEqual({ date: '2026-10-20', zone: 'PROVIDER_LOCAL' });
  });
});

describe('la zona de la oficina en el plazo (0084)', () => {
  it('flightReadOf la conserva sólo con la hora de la oficina y si es una zona IANA conocida', () => {
    const plazo = (ticketingDeadline: OrderView['ticketingDeadline']) =>
      flightReadOf(vista({ ticketingDeadline }), AHORA).ticketingDeadline;
    expect(
      plazo({
        date: '2026-10-20',
        time: '18:00',
        zone: 'PROVIDER_LOCAL',
        timeZone: 'America/Lima',
      }),
    ).toEqual({
      date: '2026-10-20',
      time: '18:00',
      zone: 'PROVIDER_LOCAL',
      timeZone: 'America/Lima',
    });
    // Una zona que no existe o con forma rara se pierde sola; el plazo sigue valiendo.
    for (const timeZone of ['Marte/Olympus', 'America/Bogota; DROP', '', 'x'.repeat(65)]) {
      expect(
        plazo({ date: '2026-10-20', time: '18:00', zone: 'PROVIDER_LOCAL', timeZone }),
      ).toEqual({ date: '2026-10-20', time: '18:00', zone: 'PROVIDER_LOCAL' });
    }
    // Un plazo UTC no lleva zona de oficina.
    expect(
      plazo({ date: '2026-10-20', time: '18:00', zone: 'UTC', timeZone: 'America/Lima' }),
    ).toEqual({ date: '2026-10-20', time: '18:00', zone: 'UTC' });
  });

  it('deadlineInstant: UTC tal cual, la oficina con su zona, y sin hora o sin zona no hay instante', () => {
    expect(deadlineInstant({ date: '2026-10-20', time: '18:00', zone: 'UTC' })).toEqual(
      new Date('2026-10-20T18:00:00.000Z'),
    );
    expect(
      deadlineInstant({
        date: '2026-10-20',
        time: '18:00',
        zone: 'PROVIDER_LOCAL',
        timeZone: 'America/Sao_Paulo',
      }),
    ).toEqual(new Date('2026-10-20T21:00:00.000Z'));
    expect(deadlineInstant({ date: '2026-10-20', time: '18:00', zone: 'PROVIDER_LOCAL' })).toBe(
      null,
    );
    expect(
      deadlineInstant({ date: '2026-10-20', zone: 'PROVIDER_LOCAL', timeZone: 'America/Lima' }),
    ).toBe(null);
    expect(deadlineInstant({ date: '2026-10-20', zone: 'UTC' })).toBe(null);
  });

  it('la vista pública lleva la zona de la oficina y el instante', () => {
    const at = new Date('2026-10-20T23:00:00.000Z');
    expect(
      publicFlightOrderTracking({
        orderId: ORDEN,
        airlineLocators: [],
        documents: [],
        ticketingDeadline: {
          date: '2026-10-20',
          time: '18:00',
          zone: 'PROVIDER_LOCAL',
          timeZone: 'America/Bogota',
          at,
        },
        lastReadAt: null,
      }).ticketingDeadline,
    ).toEqual({
      date: '2026-10-20',
      time: '18:00',
      zone: 'PROVIDER_LOCAL',
      timeZone: 'America/Bogota',
      at: '2026-10-20T23:00:00.000Z',
    });
  });

  it('listTracking devuelve la zona guardada', async () => {
    const at = new Date('2026-10-20T23:00:00.000Z');
    const b = banco((q) =>
      q.sql.includes('from "flight_order_tracking"')
        ? {
            rows: [
              {
                order_id: ORDEN,
                airline_locators: [],
                ticketing_deadline_date: '2026-10-20',
                ticketing_deadline_time: '18:00',
                ticketing_deadline_zone: 'PROVIDER_LOCAL',
                ticketing_deadline_time_zone: 'America/Bogota',
                ticketing_deadline_at: at,
                last_read_at: null,
              },
            ],
          }
        : {},
    );
    expect((await b.store.listTracking(TENANT, [ORDEN])).get(ORDEN)?.ticketingDeadline).toEqual({
      date: '2026-10-20',
      time: '18:00',
      zone: 'PROVIDER_LOCAL',
      timeZone: 'America/Bogota',
      at,
    });
  });
});

describe('0082 — el vocabulario de la app es el de los CHECK y el del dominio', () => {
  const MIGRACION = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'db',
    'migrations',
    '0082_flight_order_tracking.sql',
  );
  const sql = readFileSync(MIGRACION, 'utf8').replace(/--.*$/gm, '');

  function vocabulario(columna: string): string[] {
    const m = new RegExp(`CHECK \\(${columna} IN \\(([^)]*)\\)\\)`).exec(sql);
    expect(m, `sin CHECK (${columna} IN (...))`).not.toBeNull();
    return (m?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  }

  it('cada CHECK dice lo mismo que database.types.ts', () => {
    expect({
      kind: vocabulario('kind'),
      status: vocabulario('status'),
      ticketing_deadline_zone: vocabulario('ticketing_deadline_zone'),
    }).toEqual({
      kind: [...FLIGHT_DOCUMENT_KINDS],
      status: [...FLIGHT_DOCUMENT_STATUSES],
      ticketing_deadline_zone: [...TICKETING_DEADLINE_ZONES],
    });
  });

  it('y database.types.ts dice lo mismo que el puerto del dominio', () => {
    expect([...FLIGHT_DOCUMENT_KINDS]).toEqual([...TICKET_DOCUMENT_KINDS]);
    expect([...FLIGHT_DOCUMENT_STATUSES]).toEqual([...TICKET_DOCUMENT_STATUSES]);
    expect([...TICKETING_DEADLINE_ZONES]).toEqual([...DOMAIN_DEADLINE_ZONES]);
  });

  it('las dos tablas tienen tenant_id, RLS forzada, policy con WITH CHECK y FK por tenant', () => {
    const tablas = [...sql.matchAll(/CREATE TABLE\s+(\w+)/g)].map((m) => m[1] ?? '');
    expect(tablas).toEqual(['flight_order_tracking', 'order_flight_documents']);
    const tenantActivo = `\\(tenant_id::text = current_setting\\('app\\.current_tenant_id', true\\)\\)`;
    for (const t of tablas) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE TABLE ${t} \\([\\s\\S]*?tenant_id\\s+UUID\\s+NOT NULL REFERENCES tenants`,
        ),
      );
      expect(sql).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY;`);
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY \\w+ ON ${t}\\s+USING\\s+${tenantActivo}\\s+WITH CHECK\\s+${tenantActivo}`,
        ),
      );
    }
    // Con una FK a `id` a secas, una agencia podría colgar filas de una orden ajena.
    expect([
      ...sql.matchAll(/FOREIGN KEY \(order_id, tenant_id\) REFERENCES orders \(id, tenant_id\)/g),
    ]).toHaveLength(2);
  });

  it('el número del documento en la base es el mismo patrón que valida la app', () => {
    expect(sql).toContain("CHECK (number ~ '^[0-9]{10,16}$')");
  });
});

// ---------------------------------------------------------------------------------------------
// El SQL del store, con el compilador real de Postgres
// ---------------------------------------------------------------------------------------------

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => { rows?: unknown[] }) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: (this.responder(q).rows ?? []) as R[] }),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

function banco(responder: (q: CompiledQuery) => { rows?: unknown[] } = () => ({})) {
  const consultas: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new DriverQueGraba((q) => {
          consultas.push(q);
          return responder(q);
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const database = new DatabaseService();
  database.db = db;
  const negocio = () =>
    consultas.filter(
      (q) => !q.sql.includes('set_config') && !/^(begin|commit|rollback)/i.test(q.sql),
    );
  return { store: new FlightOrderTrackingStore(database), consultas, negocio };
}

describe('FlightOrderTrackingStore.recordRead', () => {
  it('fija el tenant, y la fila de seguimiento va primero (toma el lock de la orden)', async () => {
    const b = banco();
    await b.store.recordRead(TENANT, ORDEN, flightReadOf(vista(), AHORA));

    expect(b.consultas.some((q) => q.sql.includes('set_config'))).toBe(true);
    const [primera] = b.negocio();
    expect(primera?.sql).toBe(
      'insert into "flight_order_tracking" ("order_id", "tenant_id", "last_read_at") values ($1, $2, $3) on conflict ("order_id") do update set "last_read_at" = $4',
    );
    expect(primera?.parameters).toEqual([ORDEN, TENANT, AHORA, AHORA]);
  });

  it('una lectura sin localizadores ni plazo no los borra: sólo mueve el momento de la lectura', async () => {
    const b = banco();
    const cambios = await b.store.recordRead(TENANT, ORDEN, flightReadOf(vista(), AHORA));

    expect(cambios).toEqual({ added: 0, statusChanged: 0 });
    expect(b.negocio()).toHaveLength(1);
    expect(b.negocio()[0]?.sql).not.toContain('airline_locators');
    expect(b.negocio()[0]?.sql).not.toContain('ticketing_deadline');
  });

  it('con localizadores y plazo UTC los reemplaza, con el instante calculado', async () => {
    const b = banco();
    await b.store.recordRead(
      TENANT,
      ORDEN,
      flightReadOf(
        vista({
          airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
          ticketingDeadline: { date: '2026-10-20', time: '20:00', zone: 'UTC' },
        }),
        AHORA,
      ),
    );
    const upsert = b.negocio()[0];
    expect(upsert?.sql).toContain(
      'do update set "last_read_at" = $10, "airline_locators" = $11, "ticketing_deadline_date" = $12, "ticketing_deadline_time" = $13, "ticketing_deadline_zone" = $14, "ticketing_deadline_time_zone" = $15, "ticketing_deadline_at" = $16',
    );
    expect(upsert?.parameters.slice(2, 8)).toEqual([
      AHORA,
      JSON.stringify([{ carrierCode: 'LA', locator: 'XKCD12' }]),
      '2026-10-20',
      '20:00',
      'UTC',
      null,
    ]);
    expect(upsert?.parameters[8]).toEqual(new Date('2026-10-20T20:00:00.000Z'));
  });

  it('una lectura con plazo vuelve a NULL los avisos sólo si cambia el instante (0084)', async () => {
    const b = banco();
    await b.store.recordRead(
      TENANT,
      ORDEN,
      flightReadOf(
        vista({ ticketingDeadline: { date: '2026-10-20', time: '20:00', zone: 'UTC' } }),
        AHORA,
      ),
    );
    const sql = b.negocio()[0]?.sql ?? '';
    for (const columna of ['deadline_alerted_24h_at', 'deadline_alerted_2h_at']) {
      expect(sql).toContain(
        `"${columna}" = CASE WHEN flight_order_tracking.ticketing_deadline_at IS NOT DISTINCT FROM excluded.ticketing_deadline_at THEN flight_order_tracking.${columna} END`,
      );
    }
    // Y sin plazo en la lectura, los avisos no se tocan.
    const sinPlazo = banco();
    await sinPlazo.store.recordRead(TENANT, ORDEN, flightReadOf(vista(), AHORA));
    expect(sinPlazo.negocio()[0]?.sql).not.toContain('deadline_alerted');
  });

  it('con la hora de la oficina y la zona de la cuenta, el instante sale de esa zona (0084)', async () => {
    const b = banco();
    await b.store.recordRead(
      TENANT,
      ORDEN,
      flightReadOf(
        vista({
          ticketingDeadline: {
            date: '2026-10-20',
            time: '18:00',
            zone: 'PROVIDER_LOCAL',
            timeZone: 'America/Bogota',
          },
        }),
        AHORA,
      ),
    );
    expect(b.negocio()[0]?.parameters.slice(2, 8)).toEqual([
      AHORA,
      '2026-10-20',
      '18:00',
      'PROVIDER_LOCAL',
      'America/Bogota',
      new Date('2026-10-20T23:00:00.000Z'),
    ]);
  });

  it('con la hora de la oficina no hay instante, y sin hora la columna queda NULL', async () => {
    const b = banco();
    await b.store.recordRead(
      TENANT,
      ORDEN,
      flightReadOf(
        vista({ ticketingDeadline: { date: '2026-10-20', zone: 'PROVIDER_LOCAL' } }),
        AHORA,
      ),
    );
    expect(b.negocio()[0]?.parameters.slice(2, 7)).toEqual([
      AHORA,
      '2026-10-20',
      null,
      'PROVIDER_LOCAL',
      null,
    ]);
  });

  it('un documento nuevo se inserta y uno que cambió de estado se actualiza sin pisar su primer instante', async () => {
    const b = banco((q) =>
      q.sql.startsWith('select')
        ? {
            rows: [
              {
                number: '1251934576908',
                kind: 'EMD',
                traveler_index: 0,
                status: 'ISSUED',
                provider_status_code: 'ME',
              },
            ],
          }
        : {},
    );

    const cambios = await b.store.recordRead(
      TENANT,
      ORDEN,
      flightReadOf(
        vista({
          documents: [
            emitido({ travelerIndex: 0 }),
            emitido({
              number: '1251934576908',
              kind: 'EMD',
              status: 'VOIDED',
              providerStatusCode: 'MV',
            }),
          ],
        }),
        AHORA,
      ),
    );

    expect(cambios).toEqual({ added: 1, statusChanged: 1 });
    const [, select, insert, update] = b.negocio();
    expect(select?.sql).toBe(
      'select "number", "kind", "traveler_index", "status", "provider_status_code" from "order_flight_documents" where "order_id" = $1 and "tenant_id" = $2',
    );
    expect(insert?.sql).toBe(
      'insert into "order_flight_documents" ("tenant_id", "order_id", "number", "kind", "status", "traveler_index", "provider_status_code", "issued_at") values ($1, $2, $3, $4, $5, $6, $7, $8)',
    );
    expect(insert?.parameters).toEqual([
      TENANT,
      ORDEN,
      TIQUETE,
      'TICKET',
      'ISSUED',
      0,
      'TE',
      AHORA,
    ]);
    expect(update?.sql).toBe(
      'update "order_flight_documents" set "kind" = $1, "status" = $2, "traveler_index" = $3, "provider_status_code" = $4, "voided_at" = coalesce(voided_at, $5) where "order_id" = $6 and "tenant_id" = $7 and "number" = $8',
    );
    expect(update?.parameters).toEqual([
      'EMD',
      'VOIDED',
      0,
      'MV',
      AHORA,
      ORDEN,
      TENANT,
      '1251934576908',
    ]);
  });

  it('un cambio que no es de estado (el pasajero llegó después) se escribe pero no se cuenta', async () => {
    const b = banco((q) =>
      q.sql.startsWith('select')
        ? {
            rows: [
              {
                number: TIQUETE,
                kind: 'TICKET',
                traveler_index: null,
                status: 'ISSUED',
                provider_status_code: 'TE',
              },
            ],
          }
        : {},
    );
    const cambios = await b.store.recordRead(
      TENANT,
      ORDEN,
      flightReadOf(vista({ documents: [emitido({ travelerIndex: 1 })] }), AHORA),
    );
    expect(cambios).toEqual({ added: 0, statusChanged: 0 });
    expect(b.negocio()[2]?.sql).toMatch(/^update "order_flight_documents" set /);
  });
});

describe('FlightOrderTrackingStore.listTracking', () => {
  it('sin órdenes no consulta', async () => {
    const b = banco();
    expect(await b.store.listTracking(TENANT, [])).toEqual(new Map());
    expect(b.consultas).toEqual([]);
  });

  it('lee en lote, filtrando por tenant, con la fecha como texto (sin medianoche local)', async () => {
    const at = new Date('2026-10-20T20:00:00.000Z');
    const b = banco((q) => {
      if (q.sql.includes('from "flight_order_tracking"')) {
        return {
          rows: [
            {
              order_id: ORDEN,
              airline_locators: [
                { carrierCode: 'LA', locator: 'XKCD12' },
                { carrierCode: 'x', locator: '?' },
              ],
              ticketing_deadline_date: '2026-10-20',
              ticketing_deadline_time: '20:00',
              ticketing_deadline_zone: 'UTC',
              ticketing_deadline_at: at,
              last_read_at: '2026-10-13T15:00:00.000Z',
            },
          ],
        };
      }
      if (q.sql.includes('from "order_flight_documents"')) {
        return {
          rows: [
            {
              order_id: ORDEN,
              number: TIQUETE,
              kind: 'TICKET',
              traveler_index: 0,
              status: 'ISSUED',
              provider_status_code: 'TE',
            },
            {
              order_id: 'otra',
              number: '1251934576908',
              kind: 'EMD',
              traveler_index: null,
              status: 'UNKNOWN',
              provider_status_code: null,
            },
          ],
        };
      }
      return {};
    });

    const result = await b.store.listTracking(TENANT, [ORDEN, 'otra']);

    const [tracking, documentos] = b.negocio();
    expect(tracking?.sql).toBe(
      'select "order_id", "airline_locators", to_char(ticketing_deadline_date, \'YYYY-MM-DD\') as "ticketing_deadline_date", "ticketing_deadline_time", "ticketing_deadline_zone", "ticketing_deadline_time_zone", "ticketing_deadline_at", "last_read_at" from "flight_order_tracking" where "tenant_id" = $1 and "order_id" in ($2, $3)',
    );
    expect(documentos?.sql).toContain('where "tenant_id" = $1 and "order_id" in ($2, $3)');
    expect(result.get(ORDEN)).toEqual({
      orderId: ORDEN,
      airlineLocators: [{ carrierCode: 'LA', locator: 'XKCD12' }],
      documents: [guardado()],
      ticketingDeadline: { date: '2026-10-20', time: '20:00', zone: 'UTC', at },
      lastReadAt: AHORA,
    });
    // Documentos sin fila de seguimiento (no debería pasar) igual se muestran.
    expect(result.get('otra')).toMatchObject({
      airlineLocators: [],
      ticketingDeadline: null,
      documents: [{ number: '1251934576908', status: 'UNKNOWN' }],
    });
  });

  it('localizadores guardados como texto, o que no son una lista, se leen sin romper', async () => {
    const fila = (airline_locators: unknown) => ({
      rows: [
        {
          order_id: ORDEN,
          airline_locators,
          ticketing_deadline_date: null,
          ticketing_deadline_time: null,
          ticketing_deadline_zone: null,
          ticketing_deadline_at: null,
          last_read_at: null,
        },
      ],
    });
    const texto = banco((q) =>
      q.sql.includes('from "flight_order_tracking"')
        ? fila(JSON.stringify([{ carrierCode: 'LA', locator: 'XKCD12' }]))
        : {},
    );
    expect((await texto.store.listTracking(TENANT, [ORDEN])).get(ORDEN)?.airlineLocators).toEqual([
      { carrierCode: 'LA', locator: 'XKCD12' },
    ]);
    const raro = banco((q) => (q.sql.includes('from "flight_order_tracking"') ? fila({}) : {}));
    expect((await raro.store.listTracking(TENANT, [ORDEN])).get(ORDEN)).toMatchObject({
      airlineLocators: [],
      ticketingDeadline: null,
      lastReadAt: null,
    });
  });
});
