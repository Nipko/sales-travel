import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sabreBodyDigest } from '../canonical-json';
import {
  SABRE_FULFILL_COMMIT_WAIT_MS,
  SABRE_FULFILL_PATH,
  SABRE_FULFILL_RECEIVED_FROM,
  SabreFulfillBuildError,
  buildSabreFulfillRequest,
  describeSabreFulfillRequest,
  formatSabreCommissionPercentage,
  sabreFulfillIdempotencyKey,
  type SabreFulfillInput,
  type SabreFulfillRule,
} from './fulfill.request.builder';

/**
 * El cuerpo de `fulfillFlightTickets` (`booking-management-v1.yml:912-1020`) contra el contrato y
 * contra el ejemplo oficial de emisión con `CASH`
 * (`help/booking-management-api-v1/help-documentation-fulfill-flight-tickets-examples.txt:148-174`).
 * Ningún test llama a Sabre: lo que viaja de verdad por el cable lo mide
 * `sabre-ticketing.adapter.test.ts` por la puerta pública.
 */

const PNR = 'QWERTY';
const PAN = '4111111111111111';

function build(overrides: Partial<SabreFulfillInput> = {}) {
  return buildSabreFulfillRequest({ confirmationId: PNR, formOfPayment: 'CASH', ...overrides });
}

function ruleOf(run: () => unknown): SabreFulfillRule {
  try {
    run();
  } catch (error) {
    if (error instanceof SabreFulfillBuildError) return error.rule;
    throw error;
  }
  throw new Error('se esperaba un SabreFulfillBuildError');
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('se esperaba un rechazo');
}

/** La entrada con TODO relleno: los flags estrictos no pueden depender de qué opcionales lleguen. */
const MAXIMAL: SabreFulfillInput = {
  confirmationId: PNR,
  formOfPayment: 'INVOICE',
  invoiceDescription: 'AGT INVOICE',
  ancillaryItemIds: ['19', '17'],
  validatingAirlineCode: 'AV',
  commissionPercentage: 7.5,
  targetPcc: 'A1B2',
  printers: { hardcopyAddress: 'B18BG1', ticketCountryCode: 'CO' },
};

describe('los flags de precio estricto viajan SIEMPRE', () => {
  it.each([
    ['la entrada mínima', {}],
    ['la entrada máxima', MAXIMAL],
  ] as const)('%s', (_label, input) => {
    const body = build(input);
    // Los cuatro defaults del contrato son los contrarios (`:991-1015`): se mandan explícitos.
    expect(body.acceptPriceChanges).toBe(false);
    expect(body.priceQuoteExpirationMethod).toBe('Quit');
    expect(body.backDatePriceQuoteMethod).toBe('Quit');
    expect(body.commitTicketToBookingWaitTime).toBe(SABRE_FULFILL_COMMIT_WAIT_MS);
    expect(SABRE_FULFILL_COMMIT_WAIT_MS).toBe(3000);
    expect(body.receivedFrom).toBe(SABRE_FULFILL_RECEIVED_FROM);
    expect(SABRE_FULFILL_RECEIVED_FROM).toBe('PLANETOUR');
  });

  it('no se pide la emisión parcial, ni el correo del proveedor, ni nombres de pasajero', () => {
    const wire = JSON.stringify(build(MAXIMAL));
    // `ALLOW_PARTIAL_FULFILLMENT` es el default del contrato y no se apaga con su enum: lo que sí
    // está en nuestra mano es no pedirlo. El correo del proveedor no respeta la marca de pruebas.
    expect(wire).not.toContain('errorHandlingPolicy');
    expect(wire).not.toContain('ALLOW_PARTIAL_FULFILLMENT');
    expect(wire).not.toContain('notificationEmail');
    expect(wire).not.toContain('"travelers"');
    expect(wire).not.toContain('acceptNegotiatedFare');
  });

  it('la ruta es la del contrato', () => {
    expect(SABRE_FULFILL_PATH).toBe('/v1/trip/orders/fulfillFlightTickets');
  });
});

describe('la forma de pago es la de la cuenta, nunca tarjeta (D1)', () => {
  it.each(['CASH', 'ON_ACCOUNT', 'INVOICE'] as const)(
    '%s viaja sola, sin campos de tarjeta',
    (type) => {
      const body = build({ formOfPayment: type });
      expect(body.formsOfPayment).toEqual([{ type }]);
    },
  );

  it('PAYMENTCARD no compila y, si llega por un cast, no sale', () => {
    // @ts-expect-error — la emisión sólo admite CASH, ON_ACCOUNT o INVOICE.
    expect(ruleOf(() => build({ formOfPayment: 'PAYMENTCARD' }))).toBe('FORM_OF_PAYMENT_INVALID');
    // @ts-expect-error — la tarjeta virtual tampoco: es un código de cuenta de tarjeta.
    expect(ruleOf(() => build({ formOfPayment: 'VIRTUAL_CARD' }))).toBe('FORM_OF_PAYMENT_INVALID');
  });

  it('los campos de tarjeta de FulfillFormOfPayment no compilan y no pasan en ejecución', () => {
    // @ts-expect-error — `cardNumber?: never`.
    expect(ruleOf(() => build({ cardNumber: PAN }))).toBe('INPUT_INVALID');
    // @ts-expect-error — `cardHolder?: never`.
    expect(ruleOf(() => build({ cardHolder: { givenName: 'X' } }))).toBe('INPUT_INVALID');
    // @ts-expect-error — `payer?: never`.
    expect(ruleOf(() => build({ payer: { givenName: 'X' } }))).toBe('INPUT_INVALID');
    // @ts-expect-error — `manualApprovalCode?: never`.
    expect(ruleOf(() => build({ manualApprovalCode: '12345' }))).toBe('INPUT_INVALID');
    // @ts-expect-error — `authentications?: never`.
    expect(ruleOf(() => build({ authentications: [{ channelCode: 'MO' }] }))).toBe('INPUT_INVALID');
    // @ts-expect-error — `virtualCardCode?: never`.
    expect(ruleOf(() => build({ virtualCardCode: 'SABREVIRTUAL' }))).toBe('INPUT_INVALID');
  });

  it('el rechazo de una clave de tarjeta no lleva su valor', () => {
    const message = messageOf(() =>
      buildSabreFulfillRequest({
        confirmationId: PNR,
        formOfPayment: 'CASH',
        ...({ cardNumber: PAN } as object),
      }),
    );
    expect(message).not.toContain(PAN);
    expect(message).toContain('unrecognized_keys');
  });

  it('una clave que la entrada no declara se rechaza entera: el esquema es strict', () => {
    expect(
      ruleOf(() =>
        build({ ...({ travelers: [{ givenName: 'JOHN', surname: 'DRAKE' }] } as object) }),
      ),
    ).toBe('INPUT_INVALID');
  });
});

describe('los índices de forma de pago salen en base 1 (indices.ts)', () => {
  it('la única forma de pago es la 1, nunca la 0', () => {
    const body = build();
    expect(body.fulfillments).toEqual([{ payment: { primaryFormOfPayment: 1 } }]);
  });

  it('el EMD va en una segunda entrada que apunta a la MISMA forma de pago', () => {
    const body = build({ ancillaryItemIds: ['17', '19'] });
    expect(body.fulfillments.map((f) => f.payment.primaryFormOfPayment)).toEqual([1, 1]);
    expect(body.fulfillments[1]).toEqual({
      ancillaryIds: ['17', '19'],
      payment: { primaryFormOfPayment: 1 },
    });
  });

  it('los ids de EMD salen en orden canónico y sin repetidos', () => {
    expect(build({ ancillaryItemIds: ['19', '17'] }).fulfillments[1]?.ancillaryIds).toEqual([
      '17',
      '19',
    ]);
    expect(ruleOf(() => build({ ancillaryItemIds: ['17', '17'] }))).toBe('ANCILLARY_ID_INVALID');
  });

  it('sin EMD no hay segunda entrada: un array vacío es «sólo tiquetes»', () => {
    expect(build({ ancillaryItemIds: [] }).fulfillments).toHaveLength(1);
  });

  it.each(['12a', '1 2', '', '123456789'])('un id de EMD %j no sale', (id) => {
    expect(ruleOf(() => build({ ancillaryItemIds: [id] }))).toBe('ANCILLARY_ID_INVALID');
  });
});

describe('commissionPercentage: 0 a 99,99 con dos decimales, con el nombre del contrato', () => {
  it.each([
    [0, '0'],
    [7.5, '7.50'],
    [10, '10'],
    [12.34, '12.34'],
    [99.99, '99.99'],
    [0.1 + 0.2, '0.30'],
  ])('%s → %s', (value, wire) => {
    expect(formatSabreCommissionPercentage(value)).toBe(wire);
    // El patrón literal del contrato (`:7687-7691`).
    expect(wire).toMatch(/^[0-9]{1,2}(\.[0-9]{1,2})?$/);
  });

  it.each([100, 99.991, -0.01, 1.234, Number.NaN, Number.POSITIVE_INFINITY])(
    '%s no sale',
    (value) => {
      expect(ruleOf(() => build({ commissionPercentage: value }))).toBe('COMMISSION_INVALID');
    },
  );

  it('viaja como `commissionPercentage` en los calificadores del tiquete, no `commissionPercent`', () => {
    const body = build({ commissionPercentage: 7.5, ancillaryItemIds: ['17'] });
    expect(body.fulfillments[0]?.ticketingQualifiers).toEqual({ commissionPercentage: '7.50' });
    // El EMD no lleva comisión de tiquete.
    expect(body.fulfillments[1]?.ticketingQualifiers).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('commissionPercent"');
  });

  it('sin comisión ni validadora no hay bloque de calificadores', () => {
    expect(build().fulfillments[0]).not.toHaveProperty('ticketingQualifiers');
  });
});

describe('el resto de campos, con su patrón', () => {
  it('confirmationId: un PNR o una orden NDC; nada más largo, y así no cabe un PAN de 16', () => {
    expect(build({ confirmationId: 'ABCDEF' }).bookingSource).toBe('SABRE');
    expect(build({ confirmationId: '1SXXXCI666890' }).bookingSource).toBe('SABRE_ORDER');
    for (const bad of ['ABCDE', 'abcdef', 'ABC DEF', PAN, '1SXXXCI6668901X']) {
      expect(
        ruleOf(() => build({ confirmationId: bad })),
        bad,
      ).toBe('CONFIRMATION_ID_INVALID');
    }
    expect(messageOf(() => build({ confirmationId: PAN }))).not.toContain(PAN);
  });

  it('invoiceDescription sólo con INVOICE, corta y sin tiradas de dígitos', () => {
    expect(
      build({ formOfPayment: 'INVOICE', invoiceDescription: 'AGT INVOICE' }).formsOfPayment,
    ).toEqual([{ type: 'INVOICE', invoiceDescription: 'AGT INVOICE' }]);
    expect(ruleOf(() => build({ formOfPayment: 'CASH', invoiceDescription: 'AGT' }))).toBe(
      'INVOICE_DESCRIPTION_WITHOUT_INVOICE',
    );
    for (const bad of [`INV ${PAN}`, 'factura ñ', 'x'.repeat(41), '']) {
      expect(
        ruleOf(() => build({ formOfPayment: 'INVOICE', invoiceDescription: bad })),
        bad,
      ).toBe('INVOICE_DESCRIPTION_INVALID');
    }
  });

  it('validatingAirlineCode y targetPcc', () => {
    expect(build({ validatingAirlineCode: 'AV' }).fulfillments[0]?.ticketingQualifiers).toEqual({
      validatingAirlineCode: 'AV',
    });
    expect(ruleOf(() => build({ validatingAirlineCode: 'AVA' }))).toBe(
      'VALIDATING_AIRLINE_INVALID',
    );
    expect(build({ targetPcc: 'A1B2' }).targetPcc).toBe('A1B2');
    expect(build()).not.toHaveProperty('targetPcc');
    expect(ruleOf(() => build({ targetPcc: 'a1b2' }))).toBe('TARGET_PCC_INVALID');
  });

  it('impresoras: un perfil o una designación manual, un tipo por objeto', () => {
    expect(build({ printers: { profileNumber: 3 } }).designatePrinters).toEqual([
      { profileNumber: 3 },
    ]);
    // La forma del ejemplo oficial de CASH (`examples.txt:157-168`).
    expect(
      build({ printers: { hardcopyAddress: 'B18BG1', ticketCountryCode: 'AT' } }).designatePrinters,
    ).toEqual([{ hardcopy: { address: 'B18BG1' } }, { ticket: { countryCode: 'AT' } }]);
    expect(build()).not.toHaveProperty('designatePrinters');
    expect(
      ruleOf(() =>
        // @ts-expect-error — perfil y designación manual son excluyentes.
        build({ printers: { profileNumber: 1, hardcopyAddress: 'B18BG1' } }),
      ),
    ).toBe('PRINTERS_INVALID');
    expect(ruleOf(() => build({ printers: {} }))).toBe('PRINTERS_INVALID');
    expect(ruleOf(() => build({ printers: { hardcopyAddress: 'B18BG' } }))).toBe(
      'PRINTERS_INVALID',
    );
  });
});

describe('el cuerpo tiene la forma del ejemplo oficial de emisión con CASH', () => {
  it('fulfillments y formsOfPayment son los del ejemplo, y los flags nuestros van aparte', () => {
    // `help-documentation-fulfill-flight-tickets-examples.txt:148-174`, el request de CASH.
    const example = officialCashRequest();
    const body = build({
      confirmationId: example['confirmationId'] as string,
      printers: { hardcopyAddress: 'B18BG1', ticketCountryCode: 'AT' },
    });
    expect(body.fulfillments).toEqual(example['fulfillments']);
    expect(body.formsOfPayment).toEqual(example['formsOfPayment']);
    expect(body.designatePrinters).toEqual(example['designatePrinters']);
  });
});

describe('idempotencia: el mismo pedido da la misma clave', () => {
  it('es el sha256 del cuerpo canónico, como el de cancelación', () => {
    const body = build(MAXIMAL);
    const key = sabreFulfillIdempotencyKey(body);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(sabreBodyDigest(body));
  });

  it('no depende del orden de los EMD ni del de las claves', () => {
    const left = sabreFulfillIdempotencyKey(build({ ancillaryItemIds: ['17', '19'] }));
    const right = sabreFulfillIdempotencyKey(build({ ancillaryItemIds: ['19', '17'] }));
    expect(left).toBe(right);
  });

  it('un pedido distinto da una clave distinta', () => {
    const base = sabreFulfillIdempotencyKey(build());
    expect(sabreFulfillIdempotencyKey(build({ formOfPayment: 'ON_ACCOUNT' }))).not.toBe(base);
    expect(sabreFulfillIdempotencyKey(build({ confirmationId: 'ASDFGH' }))).not.toBe(base);
    expect(sabreFulfillIdempotencyKey(build({ commissionPercentage: 1 }))).not.toBe(base);
  });
});

describe('la línea de log nombra la forma, nunca los identificadores', () => {
  it('sin PNR, sin PCC, sin descripción de factura', () => {
    const shape = describeSabreFulfillRequest(build(MAXIMAL));
    const text = JSON.stringify(shape);
    for (const value of [PNR, 'A1B2', 'AGT INVOICE', 'B18BG1', '17', '7.50']) {
      expect(text, value).not.toContain(value);
    }
    expect(shape).toMatchObject({
      operation: SABRE_FULFILL_PATH,
      formOfPayment: ['INVOICE'],
      fulfillments: 2,
      ancillaries: 2,
      withCommission: true,
      withTargetPcc: true,
      withPrinters: true,
      acceptPriceChanges: false,
    });
  });
});

const BACKSLASH = String.fromCharCode(92);

/** El request de CASH del fichero oficial, leído del expediente y no copiado a mano. */
function officialCashRequest(): Record<string, unknown> {
  const text = readFileSync(
    join(
      findRepoRoot(),
      'docs',
      'sabre',
      'evidence',
      'specs',
      'help',
      'booking-management-api-v1',
      'help-documentation-fulfill-flight-tickets-examples.txt',
    ),
    'utf8',
  );
  const section = text.indexOf('Traditional ATPCO booking fulfillment with CASH form of payment');
  const start = text.indexOf('{', text.indexOf('Necessary printers', section));
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
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
    }
  }
  throw new Error('bloque JSON sin cerrar en el ejemplo de CASH');
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
