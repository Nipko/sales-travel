import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TICKET_ISSUE_WARNINGS, type TicketDocument } from '@sales-travel/domain';
import { describe, expect, it } from 'vitest';
import {
  SABRE_FULFILL_ALREADY_FULFILLED_TYPES,
  SABRE_FULFILL_HUMAN_REVIEW_TYPES,
  SABRE_FULFILL_NOT_ISSUED_TYPES,
  SABRE_FULFILL_UNCERTAIN_TYPES,
  SABRE_FULFILL_WARNING_RULES,
  SabreFulfillMappingError,
  classifySabreFulfillIssues,
  mapSabreFulfillResponse,
  sabreTicketCoverage,
} from './fulfill.response.mapper';

/**
 * `FulfillTicketsResponse` (`booking-management-v1.yml:1022-1050`) con las respuestas oficiales.
 *
 * Procedencia de cada fixture, línea a línea del expediente
 * (`docs/sabre/evidence/specs/help/booking-management-api-v1/`):
 *
 *  - `fulfill-atpco-cash-200.json` ← `help-documentation-fulfill-flight-tickets-examples.txt:178-230`
 *    («Traditional ATPCO booking fulfillment with CASH form of payment», respuesta). Copia exacta.
 *  - `fulfill-atpco-pqr-downline-warning-200.json` ← `…-examples.txt:444-521` (emisión por PQR, con
 *    el único `DOWNLINE_SERVICE_WARNING` real del expediente). Copia exacta.
 *  - `fulfill-ndc-to-200.derived.json` ← `…-examples.txt:559-617` (NDC). Derivado: sólo `timestamp`
 *    y `tickets[]`. Se quitó el eco del request, que lleva una tarjeta de prueba: la emisión NDC con
 *    `CASH` no tiene ejemplo oficial (P-03) y se confirma en CERT (SAB-22).
 *
 * Los avisos salen de `help-documentation-fulfill-flight-tickets-warning-list.txt:9-56`, uno por
 * fila; el test de la tabla cruza el fichero entero para que no se pueda quedar uno fuera.
 */

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf8')) as Json;
}

const cash = (): Json => fixture('fulfill-atpco-cash-200.json');
const pqr = (): Json => fixture('fulfill-atpco-pqr-downline-warning-200.json');
const ndc = (): Json => fixture('fulfill-ndc-to-200.derived.json');

const ONE = { travelerCount: 1 };

function withWarning(body: Json, type: string, category = 'PROCESSING_WARNING'): Json {
  return {
    ...body,
    warnings: [{ category, type, description: `TEXTO LIBRE DEL PROVEEDOR para ${type} DRAKE` }],
  };
}

function withoutTickets(body: Json): Json {
  const { tickets: _tickets, ...rest } = body;
  return rest;
}

describe('la tabla de avisos es la lista oficial completa', () => {
  it('los siete tipos, con la categoría con que los publica el fabricante', () => {
    // `help-documentation-fulfill-flight-tickets-warning-list.txt`: cada fila es TIPO | CATEGORÍA.
    const rows = officialWarningRows();
    expect(rows).toHaveLength(7);
    expect(
      Object.fromEntries(
        Object.entries(SABRE_FULFILL_WARNING_RULES).map(([type, rule]) => [type, rule.category]),
      ),
    ).toEqual(Object.fromEntries(rows));
  });

  it('cada aviso se traduce a un código del vocabulario cerrado del dominio', () => {
    for (const rule of Object.values(SABRE_FULFILL_WARNING_RULES)) {
      expect(TICKET_ISSUE_WARNINGS).toContain(rule.warning);
    }
  });

  it('los tres ambiguos son los de la cola humana, también como error', () => {
    expect(
      Object.entries(SABRE_FULFILL_WARNING_RULES)
        .filter(([, rule]) => rule.effect === 'NEEDS_HUMAN')
        .map(([type]) => type)
        .sort(),
    ).toEqual([...SABRE_FULFILL_HUMAN_REVIEW_TYPES].sort());
  });

  it('las tablas de errores no se pisan entre sí', () => {
    const tables = [
      SABRE_FULFILL_ALREADY_FULFILLED_TYPES,
      SABRE_FULFILL_HUMAN_REVIEW_TYPES,
      SABRE_FULFILL_UNCERTAIN_TYPES,
      SABRE_FULFILL_NOT_ISSUED_TYPES,
    ];
    const all = tables.flatMap((table) => [...table]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('las respuestas oficiales', () => {
  it('los fixtures son copia exacta del expediente', () => {
    expect(cash()).toEqual(
      helpExample('A successful operation results', 'with CASH form of payment'),
    );
    expect(pqr()).toEqual(helpExample('A successful operation results', 'based on PQR data'));
    const official = helpExample('A successful operation results', 'NDC booking fulfillment');
    expect(ndc()).toEqual({ timestamp: official['timestamp'], tickets: official['tickets'] });
  });

  it('CASH (ATPCO): un pasajero, un tiquete TE grabado → ISSUED, con la oficina que emitió', () => {
    expect(mapSabreFulfillResponse(cash(), ONE)).toEqual({
      verdict: 'ISSUED',
      documents: [
        {
          number: '0016802004060',
          kind: 'TICKET',
          status: 'ISSUED',
          providerStatusCode: 'TE',
        },
      ],
      warnings: [],
      issuedTickets: 1,
      ticketingPcc: 'E9E7',
    });
  });

  it('PQR con DOWNLINE_SERVICE_WARNING: el aviso se registra y no cambia el desenlace', () => {
    // `…-examples.txt:514-520`: el mensaje de terminal reempaquetado («*PAC TO VERIFY…»).
    const mapped = mapSabreFulfillResponse(pqr(), ONE);
    expect(mapped.verdict).toBe('ISSUED');
    expect(mapped.warnings).toEqual(['provider-downline-notice']);
    // Un tiquete TE y un EMD ME: el EMD no cuenta como tiquete del pasajero.
    expect(mapped.documents.map((d) => [d.number, d.kind])).toEqual([
      ['1251934576908', 'EMD'],
      ['1255840965934', 'TICKET'],
    ]);
    expect(mapped.issuedTickets).toBe(1);
  });

  it('NDC: TO cuenta como emitido, y NDC no informa la oficina ni el grabado', () => {
    const mapped = mapSabreFulfillResponse(ndc(), { travelerCount: 2 });
    expect(mapped.verdict).toBe('ISSUED');
    expect(mapped.documents).toEqual([
      { number: '0015752129518', kind: 'TICKET', status: 'ISSUED', providerStatusCode: 'TO' },
      { number: '0015752129519', kind: 'TICKET', status: 'ISSUED', providerStatusCode: 'TO' },
    ]);
    expect(mapped).not.toHaveProperty('ticketingPcc');
  });

  it('ni nombres ni texto del proveedor llegan a la salida', () => {
    for (const body of [cash(), pqr(), ndc(), withWarning(cash(), 'PRICE_CHANGE')]) {
      const out = JSON.stringify(mapSabreFulfillResponse(body, { travelerCount: 2 }));
      for (const leak of [
        'DRAKE',
        'Drake',
        'JOHN',
        'SMITH',
        'EndTransactionLLSRQ',
        'TEXTO LIBRE',
      ]) {
        expect(out, leak).not.toContain(leak);
      }
    }
  });
});

describe('cada aviso de la lista oficial, con su efecto', () => {
  it.each([
    // [tipo, categoría oficial, desenlace con tiquete, código]
    ['EMAIL_NOT_FOUND', 'MISSING_DATA', 'ISSUED', 'provider-email-not-sent'],
    ['FUNCTIONALITY_NOT_APPLICABLE', 'IGNORED_DETAILS', 'ISSUED', 'provider-ignored-detail'],
    ['DOWNLINE_SERVICE_WARNING', 'PROCESSING_WARNING', 'ISSUED', 'provider-downline-notice'],
    ['PARTIAL_FULFILLMENT', 'PROCESSING_WARNING', 'NEEDS_HUMAN', 'partial-fulfillment'],
    ['FULFILLMENT_NOT_CONFIRMED', 'PROCESSING_WARNING', 'NEEDS_HUMAN', 'fulfillment-not-confirmed'],
    ['UNABLE_TO_RETRIEVE_TICKETS', 'PROCESSING_WARNING', 'NEEDS_HUMAN', 'documents-not-retrieved'],
    ['PRICE_CHANGE', 'PROCESSING_WARNING', 'NEEDS_HUMAN', 'price-changed'],
  ] as const)('%s (%s) con el tiquete emitido → %s', (type, category, verdict, code) => {
    const mapped = mapSabreFulfillResponse(withWarning(cash(), type, category), ONE);
    expect(mapped.verdict).toBe(verdict);
    expect(mapped.warnings).toContain(code);
  });

  it('se decide por type, no por category: el mismo tipo con otra categoría pesa igual', () => {
    expect(
      mapSabreFulfillResponse(withWarning(cash(), 'PARTIAL_FULFILLMENT', 'WARNING'), ONE).verdict,
    ).toBe('NEEDS_HUMAN');
  });

  it('PRICE_CHANGE sin tiquetes es la emisión que no ocurrió: FAILED', () => {
    const mapped = mapSabreFulfillResponse(
      withoutTickets(withWarning(cash(), 'PRICE_CHANGE')),
      ONE,
    );
    expect(mapped.verdict).toBe('FAILED');
    expect(mapped.warnings).toContain('price-changed');
  });

  it('los tres ambiguos son NEEDS_HUMAN también sin tiquetes', () => {
    for (const type of SABRE_FULFILL_HUMAN_REVIEW_TYPES) {
      const body = withoutTickets(withWarning(cash(), type));
      expect(mapSabreFulfillResponse(body, ONE).verdict, type).toBe('NEEDS_HUMAN');
    }
  });

  it('un aviso que no está en la lista se ve y no cambia el desenlace', () => {
    const mapped = mapSabreFulfillResponse(withWarning(cash(), 'NUEVO_AVISO_DE_SABRE'), ONE);
    expect(mapped.verdict).toBe('ISSUED');
    expect(mapped.warnings).toEqual(['provider-warning-unrecognized']);
  });
});

describe('cuántos tiquetes hay frente a cuántos pasajeros', () => {
  it('menos tiquetes que pasajeros es PARTIAL', () => {
    const mapped = mapSabreFulfillResponse(cash(), { travelerCount: 2 });
    expect(mapped.verdict).toBe('PARTIAL');
    expect(mapped.warnings).toContain('documents-missing');
  });

  it('un 200 sin tiquetes ni avisos no es éxito: UNVERIFIED', () => {
    const mapped = mapSabreFulfillResponse({ timestamp: '2024-04-10T13:53:25' }, ONE);
    expect(mapped.verdict).toBe('UNVERIFIED');
    expect(mapped.warnings).toEqual(['documents-missing']);
  });

  it('un tiquete emitido y no grabado en la reserva (isCommitted: false) es UNVERIFIED', () => {
    const body = cash();
    const [ticket] = body['tickets'] as Json[];
    const mapped = mapSabreFulfillResponse(
      { ...body, tickets: [{ ...ticket, isCommitted: false }] },
      ONE,
    );
    expect(mapped.verdict).toBe('UNVERIFIED');
    expect(mapped.warnings).toContain('document-not-committed');
  });

  it('un EMD solo no es el tiquete del pasajero', () => {
    const body = cash();
    const [ticket] = body['tickets'] as Json[];
    const mapped = mapSabreFulfillResponse(
      { ...body, tickets: [{ ...ticket, ticketStatusCode: 'ME' }] },
      ONE,
    );
    expect(mapped.verdict).toBe('UNVERIFIED');
    expect(mapped.issuedTickets).toBe(0);
  });

  it('el mismo número dos veces es UN documento', () => {
    const body = cash();
    const [ticket] = body['tickets'] as Json[];
    const mapped = mapSabreFulfillResponse(
      { ...body, tickets: [ticket, { ...ticket, number: '0016802004060/61' }] },
      { travelerCount: 2 },
    );
    expect(mapped.documents).toHaveLength(1);
    expect(mapped.verdict).toBe('PARTIAL');
  });

  it('un número ilegible o un estado desconocido se avisa y no se inventa', () => {
    const body = cash();
    const [ticket] = body['tickets'] as Json[];
    const mapped = mapSabreFulfillResponse(
      {
        ...body,
        tickets: [
          { ...ticket, number: 'X1' },
          { ...ticket, number: '0016802004099', ticketStatusCode: 'TV' },
        ],
      },
      ONE,
    );
    expect(mapped.warnings).toEqual(
      expect.arrayContaining(['document-number-malformed', 'document-status-unknown']),
    );
    expect(mapped.documents).toEqual([
      { number: '0016802004099', kind: 'TICKET', status: 'UNKNOWN', providerStatusCode: 'TV' },
    ]);
    expect(mapped.verdict).toBe('UNVERIFIED');
  });

  it('dos oficinas distintas en la misma respuesta: no se elige una', () => {
    const body = cash();
    const [ticket] = body['tickets'] as Json[];
    const mapped = mapSabreFulfillResponse(
      {
        ...body,
        tickets: [ticket, { ...ticket, number: '0016802004061', ticketingPcc: 'A1B2' }],
      },
      { travelerCount: 2 },
    );
    expect(mapped.verdict).toBe('ISSUED');
    expect(mapped).not.toHaveProperty('ticketingPcc');
  });
});

describe('errors[] dentro del cuerpo: el vocabulario de errores de la lista oficial', () => {
  const withErrors = (...errors: Json[]): Json => ({ timestamp: '2024-04-10T13:53:25', errors });

  it.each([
    ['PRICE_MISMATCH', 'APPLICATION_ERROR', 'FAILED'],
    ['PRINTER_NOT_ASSIGNED', 'APPLICATION_ERROR', 'FAILED'],
    ['HYBRID_CONTENT_NOT_SUPPORTED', 'BAD_REQUEST', 'FAILED'],
    ['BOOKING_NOT_FOUND', 'RESOURCE_NOT_FOUND', 'FAILED'],
    ['ANCILLARY_NOT_FOUND', 'INVALID_DATA', 'FAILED'],
    ['BOOKING_FULFILLED', 'APPLICATION_ERROR', 'ALREADY_FULFILLED'],
    ['UNABLE_TO_RETRIEVE_TICKETS', 'APPLICATION_ERROR', 'NEEDS_HUMAN'],
    ['INTERNAL_SERVER_TIMEOUT', 'APPLICATION_ERROR', 'UNVERIFIED'],
    ['PAYMENT_CARD_ISSUE', 'APPLICATION_ERROR', 'UNVERIFIED'],
    ['DOWNLINE_SERVICE_ERROR', 'APPLICATION_ERROR', 'UNVERIFIED'],
    ['UN_ERROR_QUE_NADIE_PUBLICO', 'APPLICATION_ERROR', 'UNVERIFIED'],
  ] as const)('%s (%s) → %s', (type, category, verdict) => {
    expect(mapSabreFulfillResponse(withErrors({ category, type }), ONE).verdict).toBe(verdict);
  });

  it('PRICE_MISMATCH avisa además del cambio de precio', () => {
    expect(
      mapSabreFulfillResponse(
        withErrors({ category: 'APPLICATION_ERROR', type: 'PRICE_MISMATCH' }),
        ONE,
      ).warnings,
    ).toEqual(['provider-rejected', 'price-changed']);
  });

  it('«ya estaba emitida» mezclado con otro error no se da por emitida', () => {
    expect(
      mapSabreFulfillResponse(
        withErrors(
          { category: 'APPLICATION_ERROR', type: 'BOOKING_FULFILLED' },
          { category: 'APPLICATION_ERROR', type: 'PRICE_MISMATCH' },
        ),
        ONE,
      ).verdict,
    ).toBe('UNVERIFIED');
  });

  it('«no se emitió nada» con tiquetes en el mismo cuerpo no es FAILED: lo mira una persona', () => {
    const mapped = mapSabreFulfillResponse(
      { ...cash(), errors: [{ category: 'APPLICATION_ERROR', type: 'PRICE_MISMATCH' }] },
      ONE,
    );
    expect(mapped.verdict).toBe('NEEDS_HUMAN');
    expect(mapped.documents).toHaveLength(1);
    expect(mapped.warnings).toEqual(['provider-rejected', 'price-changed']);
  });

  it('un error con tiquetes en el mismo cuerpo: manda el error y los documentos se conservan', () => {
    const mapped = mapSabreFulfillResponse(
      { ...cash(), errors: [{ category: 'APPLICATION_ERROR', type: 'PAYMENT_CARD_ISSUE' }] },
      ONE,
    );
    expect(mapped.verdict).toBe('UNVERIFIED');
    expect(mapped.documents).toHaveLength(1);
  });
});

describe('classifySabreFulfillIssues — los problemas ya pasados por errors.ts', () => {
  it('un aviso ambiguo junto a un error que dice «no se emitió» gana el aviso', () => {
    expect(
      classifySabreFulfillIssues([
        { severity: 'error', category: 'APPLICATION_ERROR', type: 'PRICE_MISMATCH' },
        { severity: 'warning', category: 'PROCESSING_WARNING', type: 'PARTIAL_FULFILLMENT' },
      ]).verdict,
    ).toBe('NEEDS_HUMAN');
  });

  it('sin tipo publicable no se da por rechazo, salvo por la categoría', () => {
    expect(classifySabreFulfillIssues([{ severity: 'error' }]).verdict).toBe('UNVERIFIED');
    expect(
      classifySabreFulfillIssues([{ severity: 'error', category: 'BAD_REQUEST' }]).verdict,
    ).toBe('FAILED');
  });

  it('sólo avisos, sin errores: no hay rechazo que afirmar', () => {
    expect(
      classifySabreFulfillIssues([
        { severity: 'warning', category: 'MISSING_DATA', type: 'EMAIL_NOT_FOUND' },
      ]),
    ).toEqual({
      verdict: 'UNVERIFIED',
      warnings: ['provider-email-not-sent', 'provider-error-uncertain'],
    });
  });
});

describe('la forma rota es error de mapeo, con rutas y sin valores', () => {
  it.each([
    ['tickets no es array', { tickets: { number: '0016802004060' } }],
    ['un tiquete es texto', { tickets: ['0016802004060 DRAKE'] }],
    ['warnings no es array', { warnings: 'DRAKE' }],
    ['la raíz no es objeto', 'DRAKE'],
  ])('%s', (_label, body) => {
    try {
      mapSabreFulfillResponse(body, ONE);
      throw new Error('se esperaba un SabreFulfillMappingError');
    } catch (error) {
      expect(error).toBeInstanceOf(SabreFulfillMappingError);
      expect((error as Error).message).not.toContain('DRAKE');
      expect((error as Error).message).not.toContain('0016802004060');
    }
  });

  it('sin un número de pasajeros válido no se decide nada', () => {
    expect(() => mapSabreFulfillResponse(cash(), { travelerCount: 0 })).toThrow(
      SabreFulfillMappingError,
    );
  });
});

describe('sabreTicketCoverage — quién tiene ya su tiquete según la reserva', () => {
  const ticket = (overrides: Partial<TicketDocument>): TicketDocument => ({
    number: '0016802004060',
    kind: 'TICKET',
    status: 'ISSUED',
    ...overrides,
  });

  it('cada pasajero con su tiquete emitido es COMPLETE', () => {
    expect(
      sabreTicketCoverage(
        [ticket({ travelerIndex: 0 }), ticket({ number: '0016802004061', travelerIndex: 1 })],
        2,
      ),
    ).toBe('COMPLETE');
  });

  it('un pasajero sin tiquete es PARTIAL', () => {
    expect(sabreTicketCoverage([ticket({ travelerIndex: 0 })], 2)).toBe('PARTIAL');
  });

  it('un tiquete sin pasajero nunca completa, pero dice que hay algo emitido', () => {
    expect(sabreTicketCoverage([ticket({})], 1)).toBe('PARTIAL');
  });

  it('EMD, anulados y desconocidos no son el tiquete del pasajero', () => {
    expect(
      sabreTicketCoverage(
        [
          ticket({ kind: 'EMD', travelerIndex: 0 }),
          ticket({ status: 'VOIDED', travelerIndex: 0 }),
          ticket({ status: 'UNKNOWN', travelerIndex: 0 }),
        ],
        1,
      ),
    ).toBe('NONE');
  });

  it('un índice fuera de la reserva no cuenta', () => {
    expect(sabreTicketCoverage([ticket({ travelerIndex: 3 })], 1)).toBe('PARTIAL');
  });
});

// ---------------------------------------------------------------------------------------------
// El expediente
// ---------------------------------------------------------------------------------------------

const HELP_DIR = ['docs', 'sabre', 'evidence', 'specs', 'help', 'booking-management-api-v1'];
const BACKSLASH = String.fromCharCode(92);

function helpText(file: string): string {
  return readFileSync(join(findRepoRoot(), ...HELP_DIR, file), 'utf8');
}

/** El bloque JSON que sigue a `label` dentro de la sección `after` del fichero de ejemplos. */
function helpExample(label: string, after: string): Json {
  const text = helpText('help-documentation-fulfill-flight-tickets-examples.txt');
  const from = text.indexOf(after);
  if (from < 0) throw new Error(`no está la sección «${after}»`);
  const start = text.indexOf('{', text.indexOf(label, from));
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === BACKSLASH) i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Json;
    }
  }
  throw new Error(`bloque JSON sin cerrar tras «${label}»`);
}

/**
 * Las filas TIPO | CATEGORÍA de la lista oficial de avisos. En el texto cada celda es una línea y
 * las separa una línea con ` |`: el tipo es la primera celda de cada fila y la categoría, la segunda.
 */
function officialWarningRows(): [string, string][] {
  const cells = helpText('help-documentation-fulfill-flight-tickets-warning-list.txt')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '|');
  const rows: [string, string][] = [];
  for (let i = 0; i < cells.length - 1; i += 1) {
    const type = cells[i] ?? '';
    const category = cells[i + 1] ?? '';
    if (/^[A-Z_]+$/.test(type) && /^[A-Z_]+$/.test(category)) {
      rows.push([type, category]);
      i += 1;
    }
  }
  return rows;
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no se encontró la raíz del monorepo');
    dir = parent;
  }
}
