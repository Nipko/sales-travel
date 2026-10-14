import { z } from 'zod';
import {
  SABRE_PCC_PATTERN,
  resolveBookingSource,
  type SabreBookingSource,
} from '../booking/get.request.builder';
import {
  SABRE_TICKETING_FORMS_OF_PAYMENT,
  type SabreTicketingFormOfPayment,
} from '../booking/ticketing-policy';
import { sabreBodyDigest } from '../canonical-json';
import { indexValue, sabreIndexIn } from '../indices';

/**
 * Builder de `fulfillFlightTickets`: la emisión de tiquetes y EMD (RF-13, docs/sabre/06 §2).
 *
 * `POST /v1/trip/orders/fulfillFlightTickets` — `booking-management-v1.yml:140`, cuerpo
 * `FulfillTicketsRequest` (`:912-1020`). Cada campo cita su línea.
 *
 * ## Sin tarjeta, por tipo (D1)
 *
 * La forma de pago es la de la cuenta: `CASH`, `ON_ACCOUNT` o `INVOICE`
 * (`FulfillFormOfPaymentTypeEnum`, `:8659-8674`). `PAYMENTCARD` y `VIRTUAL_CARD` no caben en el
 * tipo de entrada, y los campos de tarjeta del contrato (`FulfillFormOfPayment`, `:7473-7530`, y el
 * `payer` de `FulfillmentDetails`, `:7462`) se declaran `?: never`: no compilan ni con un valor de un
 * tipo más ancho. El esquema es `strict`, así que tampoco pasan en tiempo de ejecución por un `as`.
 *
 * ## Precio estricto, siempre
 *
 * Los cuatro defaults del contrato son los contrarios a lo que queremos y por eso viajan SIEMPRE,
 * aunque no los pida nadie:
 *
 *  - `acceptPriceChanges: false` — el default es `true` (`:1005-1009`): emitir aunque el precio suba
 *    entre la reserva y la emisión. Con `false`, un cambio de precio es `PRICE_MISMATCH` («No new
 *    tickets have been issued») y no un aviso sobre un tiquete ya emitido a otro precio.
 *  - `priceQuoteExpirationMethod: 'Quit'` y `backDatePriceQuoteMethod: 'Quit'` — el default
 *    `Reprice` (`:8617-8625`) vuelve a cotizar por su cuenta.
 *  - `commitTicketToBookingWaitTime: 3000` — el default es `0` (`:991-999`): sin espera no hay
 *    comprobación de que el tiquete quedó grabado en la reserva (`tickets[].isCommitted`). 3000 es
 *    el ejemplo del propio contrato.
 *  - `receivedFrom: 'PLANETOUR'` — firma fija del cambio en el historial de la reserva. Nunca el
 *    nombre de una persona: viaja al historial y vuelve en el eco.
 *
 * ## Lo que NO se manda
 *
 *  - `errorHandlingPolicy`. El enum de fulfill (`FulfillErrorPolicyEnum`, `:8637-8647`) no tiene un
 *    «detener ante cualquier error»: sólo `ALLOW_PARTIAL_FULFILLMENT` —que además es el default— y
 *    `HALT_ON_INVALID_MINIMUM_CONNECTING_TIME_ERROR`. No se pide la emisión parcial; que el
 *    proveedor la haga igual por defecto es la razón de que el mapper trate `PARTIAL_FULFILLMENT`
 *    como `NEEDS_HUMAN`.
 *  - `notificationEmail`. El correo del proveedor al pasajero no respeta la marca de contenido de
 *    pruebas: la confirmación al cliente la manda la plataforma, que sí la respeta.
 *  - `travelers`. Sólo sirve para asociar nombres con `travelerIndices` (`:978-985`, `:7700-7710`), que no se
 *    usan: mandar nombres que el proveedor ya tiene es multiplicar copias de datos personales.
 *  - `ticketingQualifiers.priceQuoteRecordIds`. Como en el ejemplo oficial de emisión con `CASH`, se
 *    emite lo que la reserva tiene cotizado (`help-documentation-fulfill-flight-tickets-examples.txt`).
 *
 * ## Idempotencia
 *
 * `fulfillFlightTickets` está en `SABRE_NON_IDEMPOTENT_PATHS`: el cliente HTTP nunca la reintenta.
 * {@link sabreFulfillIdempotencyKey} es el `sha256` del cuerpo canónico, el mismo criterio que
 * `sabreCancelIdempotencyKey`: el cuerpo no lleva relojes ni UUIDs, así que el mismo pedido da la
 * misma clave en cualquier proceso.
 */

/** `booking-management-v1.yml:140`, con `basePath: /v1/trip/orders` (`:15`). */
export const SABRE_FULFILL_PATH = '/v1/trip/orders/fulfillFlightTickets';

/** Firma del cambio en el historial de la reserva (`receivedFrom`, `:958-962`). */
export const SABRE_FULFILL_RECEIVED_FROM = 'PLANETOUR';

/** `commitTicketToBookingWaitTime` (`:991-999`, 0-10000 ms). El ejemplo del contrato. */
export const SABRE_FULFILL_COMMIT_WAIT_MS = 3000;

/** `PriceQuoteHandlingMethodEnum` (`:8617-8625`): no recotizar por nuestra cuenta. */
export const SABRE_FULFILL_PRICE_QUOTE_METHOD = 'Quit';

/** `TicketingQualifiers.commissionPercentage` — `^[0-9]{1,2}(\.[0-9]{1,2})?$` (`:7687-7691`). */
export const SABRE_FULFILL_COMMISSION_PATTERN = /^[0-9]{1,2}(\.[0-9]{1,2})?$/;
export const SABRE_FULFILL_COMMISSION_MAX = 99.99;

/**
 * El localizador que se emite. El contrato dice `^[A-Z0-9]{6,}$` (`:931-936`); el techo de 14 es
 * nuestro y sale del propio contrato: un PNR de Sabre son 6 caracteres y un id de orden NDC
 * (`Booking.bookingId`, `:1057-1063`) es `^[A-Z0-9]{6,14}$`. Un valor más largo no es ninguna de
 * las dos cosas, y con el techo no cabe un número de tarjeta de 16 dígitos.
 */
export const SABRE_FULFILL_CONFIRMATION_ID_PATTERN = /^[A-Z0-9]{6,14}$/;

/** `FulfillmentDetails.ancillaryIds[]` — `^[A-Z0-9]+$`, de 1 a 99 (`:7443-7453`). */
const ANCILLARY_ID_PATTERN = /^[A-Z0-9]+$/;
const ANCILLARY_IDS_MAX = 99;

/** `TicketingQualifiers.validatingAirlineCode` — `^[A-Z0-9]{2}$` (`:7724-7729`). */
const VALIDATING_AIRLINE_PATTERN = /^[A-Z0-9]{2}$/;

/**
 * `invoiceDescription` no tiene patrón en el contrato (`:7507-7510`). El rail es nuestro: texto de
 * factura de agencia, corto y sin acentos, que se imprime en el documento.
 */
const INVOICE_DESCRIPTION_PATTERN = /^[A-Za-z0-9 ./-]{1,40}$/;

/**
 * Tirada de dígitos con forma de PAN. Se corta en 9, igual que en `create.request.builder.ts` y
 * `price/request.builder.ts`: ningún campo de texto de este cuerpo la necesita (ni la descripción
 * de factura ni un `itemId` de la reserva) y D1 prohíbe lo único que sí tiene esa forma.
 */
const PAN_LIKE_DIGIT_RUN = /[0-9]{9,}/;

/** `HardcopyPrinter.address` / `TicketPrinter.address` — LNIATA `^[A-Z0-9]{6}$` (`:4616-4620`, `:4631-4635`). */
const LNIATA_PATTERN = /^[A-Z0-9]{6}$/;
/** `TicketPrinter.countryCode` — `^[A-Z1][A-Z1]$` (`:4636-4640`), el país del stock de tiquetes. */
const TICKET_STOCK_COUNTRY_PATTERN = /^[A-Z1][A-Z1]$/;
/** `PrinterAddress.profileNumber` es `int32` sin cota; la nuestra es la de un perfil de oficina. */
const PRINTER_PROFILE_MAX = 9999;

/** Motivo del rechazo, estable, para el log y el `domain_event`. */
export type SabreFulfillRule =
  | 'INPUT_INVALID'
  | 'CONFIRMATION_ID_INVALID'
  | 'FORM_OF_PAYMENT_INVALID'
  | 'COMMISSION_INVALID'
  | 'INVOICE_DESCRIPTION_WITHOUT_INVOICE'
  | 'INVOICE_DESCRIPTION_INVALID'
  | 'ANCILLARY_ID_INVALID'
  | 'VALIDATING_AIRLINE_INVALID'
  | 'TARGET_PCC_INVALID'
  | 'PRINTERS_INVALID';

/**
 * La emisión no se construyó: un dato nuestro que Sabre rechazaría. No sale al cable, no cuenta para
 * el circuit breaker y no se reintenta. El mensaje nombra reglas y rutas, **nunca valores**.
 */
export class SabreFulfillBuildError extends Error {
  /** El contrato neutral con el que `apps/api` distingue «no salió» de «salió y no sé qué pasó». */
  readonly sentToProvider = false as const;

  constructor(
    readonly rule: SabreFulfillRule,
    message: string,
  ) {
    super(`${rule}: ${message}`);
    this.name = 'SabreFulfillBuildError';
  }
}

/**
 * Las impresoras de la emisión ATPCO (`designatePrinters[]`, `:963-969`; `PrinterAddress`,
 * `:4591-4610`). La llamada es sin estado —la sesión se limpia antes y después—, así que la oficina
 * no conserva una impresora designada entre llamadas: sin esto, ATPCO puede responder
 * `PRINTER_NOT_ASSIGNED` («No new tickets have been issued»). O un perfil, o una designación manual:
 * nunca los dos (`INVALID_COMBINATION_PRINTER_PROFILE_AND_MANUAL_DESIGNATION`).
 */
export type SabreFulfillPrinters =
  | {
      readonly profileNumber: number;
      readonly hardcopyAddress?: never;
      readonly ticketAddress?: never;
      readonly ticketCountryCode?: never;
    }
  | {
      readonly profileNumber?: never;
      readonly hardcopyAddress?: string;
      readonly ticketAddress?: string;
      readonly ticketCountryCode?: string;
    };

/**
 * La barrera de compilación de D1 para la emisión: los campos de tarjeta de `FulfillFormOfPayment`
 * (`:7473-7530`), el `payer` de `FulfillmentDetails` (`:7462-7466`) y los de `BasicFormOfPayment`
 * (`:5305-5356`) no existen en la entrada. Borrar estas líneas no simplifica el tipo: desarma la
 * defensa.
 */
interface SabreFulfillCardFree {
  readonly cardNumber?: never;
  readonly cardSecurityCode?: never;
  readonly cardTypeCode?: never;
  readonly expiryDate?: never;
  readonly cardHolder?: never;
  readonly payer?: never;
  readonly manualApprovalCode?: never;
  readonly authentications?: never;
  readonly virtualCardCode?: never;
}

export interface SabreFulfillInput extends SabreFulfillCardFree {
  /** PNR (u orden NDC) que se emite. */
  readonly confirmationId: string;
  readonly formOfPayment: SabreTicketingFormOfPayment;
  /** Sólo con `INVOICE`: el texto de la factura de la agencia. */
  readonly invoiceDescription?: string;
  /**
   * Ancillares de la reserva para emitir como EMD, por `itemId` de `getBooking`. Vacío o ausente:
   * sólo tiquetes. Van en una segunda entrada de `fulfillments[]`, como en el ejemplo oficial.
   */
  readonly ancillaryItemIds?: readonly string[];
  readonly validatingAirlineCode?: string;
  /** Porcentaje de comisión a reclamar: 0 a 99,99 con dos decimales como mucho. */
  readonly commissionPercentage?: number;
  /** PCC de emisión (`targetPcc`, `:953-957`). El contexto no se revierte tras la llamada. */
  readonly targetPcc?: string;
  readonly printers?: SabreFulfillPrinters;
}

/** `FulfillFormOfPayment` sin tarjeta, tal como sale al cable. */
export type SabreFulfillFormOfPaymentWire =
  | { readonly type: 'CASH' }
  | { readonly type: 'ON_ACCOUNT' }
  | { readonly type: 'INVOICE'; readonly invoiceDescription?: string };

/** `FulfillmentDetails` (`:7439-7471`). `primaryFormOfPayment` es 1-based y sale de `indices.ts`. */
export interface SabreFulfillmentWire {
  readonly ancillaryIds?: readonly string[];
  readonly ticketingQualifiers?: {
    readonly commissionPercentage?: string;
    readonly validatingAirlineCode?: string;
  };
  readonly payment: { readonly primaryFormOfPayment: number };
}

/** `PrinterAddress`: un tipo de impresora por objeto (`MULTIPLE_PRINTER_TYPES`). */
export type SabrePrinterAddressWire =
  | { readonly profileNumber: number }
  | { readonly hardcopy: { readonly address: string } }
  | { readonly ticket: { readonly address?: string; readonly countryCode?: string } };

/** Cuerpo de `FulfillTicketsRequest` (`:912-1020`). Sólo campos del contrato. */
export interface SabreFulfillTicketsRequest {
  readonly confirmationId: string;
  readonly bookingSource: SabreBookingSource;
  readonly fulfillments: readonly SabreFulfillmentWire[];
  readonly formsOfPayment: readonly SabreFulfillFormOfPaymentWire[];
  readonly receivedFrom: typeof SABRE_FULFILL_RECEIVED_FROM;
  readonly acceptPriceChanges: false;
  readonly priceQuoteExpirationMethod: typeof SABRE_FULFILL_PRICE_QUOTE_METHOD;
  readonly backDatePriceQuoteMethod: typeof SABRE_FULFILL_PRICE_QUOTE_METHOD;
  readonly commitTicketToBookingWaitTime: number;
  readonly targetPcc?: string;
  readonly designatePrinters?: readonly SabrePrinterAddressWire[];
}

const PrintersSchema = z.union([
  z.object({ profileNumber: z.number().int().min(0).max(PRINTER_PROFILE_MAX) }).strict(),
  z
    .object({
      hardcopyAddress: z.string().regex(LNIATA_PATTERN).optional(),
      ticketAddress: z.string().regex(LNIATA_PATTERN).optional(),
      ticketCountryCode: z.string().regex(TICKET_STOCK_COUNTRY_PATTERN).optional(),
    })
    .strict(),
]);

/**
 * Zod `strict`: una clave que la entrada no declara —`cardNumber` traído por un `as`, un `travelers`
 * con nombres— rechaza el pedido entero en vez de perderse en silencio. Los patrones finos se
 * comprueban después, uno por uno, para dar la regla que se rompió.
 */
const FulfillInputSchema = z
  .object({
    confirmationId: z.string(),
    formOfPayment: z.string(),
    invoiceDescription: z.string().optional(),
    ancillaryItemIds: z.array(z.string()).max(ANCILLARY_IDS_MAX).optional(),
    validatingAirlineCode: z.string().optional(),
    // `unknown` y no `z.number()`: Zod rechaza `NaN` como tipo, y aquí tiene que salir la regla
    // de la comisión, no una entrada genérica inválida.
    commissionPercentage: z.unknown().optional(),
    targetPcc: z.string().optional(),
    printers: z.unknown().optional(),
  })
  .strict();

/**
 * El porcentaje de comisión al texto del contrato, o lanza. Se trabaja en centésimas enteras: el
 * redondeo de coma flotante no puede convertir un `7.5` en `7.499999` ni dejar pasar un tercer
 * decimal.
 */
export function formatSabreCommissionPercentage(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > SABRE_FULFILL_COMMISSION_MAX) {
    throw new SabreFulfillBuildError(
      'COMMISSION_INVALID',
      `commissionPercentage va de 0 a ${String(SABRE_FULFILL_COMMISSION_MAX)} (booking-management-v1.yml:7687-7691)`,
    );
  }
  const hundredths = Math.round(value * 100);
  if (Math.abs(value * 100 - hundredths) > 1e-6) {
    throw new SabreFulfillBuildError(
      'COMMISSION_INVALID',
      'commissionPercentage admite dos decimales como mucho (booking-management-v1.yml:7687-7691)',
    );
  }
  const whole = Math.floor(hundredths / 100);
  const fraction = hundredths % 100;
  const text =
    fraction === 0 ? String(whole) : `${String(whole)}.${String(fraction).padStart(2, '0')}`;
  // Última comprobación contra el patrón literal del contrato: si la aritmética de arriba fallara,
  // el valor no sale.
  if (!SABRE_FULFILL_COMMISSION_PATTERN.test(text)) {
    throw new SabreFulfillBuildError('COMMISSION_INVALID', 'commissionPercentage fuera de patrón');
  }
  return text;
}

function buildFormOfPayment(
  type: SabreTicketingFormOfPayment,
  invoiceDescription: string | undefined,
): SabreFulfillFormOfPaymentWire {
  if (type !== 'INVOICE') {
    if (invoiceDescription !== undefined) {
      throw new SabreFulfillBuildError(
        'INVOICE_DESCRIPTION_WITHOUT_INVOICE',
        'invoiceDescription sólo se usa con INVOICE (booking-management-v1.yml:7507-7510)',
      );
    }
    return { type };
  }
  if (invoiceDescription === undefined) return { type };
  if (
    !INVOICE_DESCRIPTION_PATTERN.test(invoiceDescription) ||
    PAN_LIKE_DIGIT_RUN.test(invoiceDescription)
  ) {
    throw new SabreFulfillBuildError(
      'INVOICE_DESCRIPTION_INVALID',
      'invoiceDescription es texto corto de factura: letras, dígitos, espacio, punto, barra y ' +
        'guion, hasta 40, y sin tiradas de 9 dígitos (D1)',
    );
  }
  return { type, invoiceDescription };
}

function buildAncillaryIds(raw: readonly string[] | undefined): readonly string[] {
  const ids = raw ?? [];
  for (const id of ids) {
    if (!ANCILLARY_ID_PATTERN.test(id) || PAN_LIKE_DIGIT_RUN.test(id)) {
      throw new SabreFulfillBuildError(
        'ANCILLARY_ID_INVALID',
        'ancillaryIds son itemId de la reserva: ^[A-Z0-9]+$ (booking-management-v1.yml:7443-7453) ' +
          'y sin tiradas de 9 dígitos',
      );
    }
  }
  if (new Set(ids).size !== ids.length) {
    // `DUPLICATE_ID` del catálogo de errores: el viaje de ida y vuelta ya se sabe que falla.
    throw new SabreFulfillBuildError('ANCILLARY_ID_INVALID', 'ancillaryIds repetidos');
  }
  // Orden canónico: emitir {17,19} y {19,17} es la misma operación y tiene que dar la misma clave.
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function buildPrinters(raw: unknown): readonly SabrePrinterAddressWire[] | undefined {
  if (raw === undefined) return undefined;
  const parsed = PrintersSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreFulfillBuildError(
      'PRINTERS_INVALID',
      'printers es un perfil (profileNumber) o una designación manual con LNIATA ^[A-Z0-9]{6}$ y ' +
        'país de stock ^[A-Z1][A-Z1]$ (booking-management-v1.yml:4591-4640), nunca los dos',
    );
  }
  const printers = parsed.data;
  if ('profileNumber' in printers) return [{ profileNumber: printers.profileNumber }];
  const wire: SabrePrinterAddressWire[] = [];
  if (printers.hardcopyAddress !== undefined) {
    wire.push({ hardcopy: { address: printers.hardcopyAddress } });
  }
  if (printers.ticketAddress !== undefined || printers.ticketCountryCode !== undefined) {
    wire.push({
      ticket: {
        ...(printers.ticketAddress === undefined ? {} : { address: printers.ticketAddress }),
        ...(printers.ticketCountryCode === undefined
          ? {}
          : { countryCode: printers.ticketCountryCode }),
      },
    });
  }
  if (wire.length === 0) {
    // `NO_PRINTER_TYPE`: un objeto de impresora vacío.
    throw new SabreFulfillBuildError('PRINTERS_INVALID', 'printers sin ninguna impresora');
  }
  return wire;
}

/**
 * Construye el cuerpo de `fulfillFlightTickets`, o lanza explicando qué regla se rompió.
 *
 * Una sola forma de pago, en la posición 0 del catálogo, y referenciada como `1` a través de
 * `indices.ts`: un `primaryFormOfPayment: 0` escrito a mano es `PAYMENT_INDEX_OUT_OF_BOUNDS` en el
 * mejor caso.
 */
export function buildSabreFulfillRequest(input: SabreFulfillInput): SabreFulfillTicketsRequest {
  const parsed = FulfillInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new SabreFulfillBuildError(
      'INPUT_INVALID',
      `entrada de emisión inválida (${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
        .join(', ')})`,
    );
  }
  const data = parsed.data;

  if (!SABRE_FULFILL_CONFIRMATION_ID_PATTERN.test(data.confirmationId)) {
    throw new SabreFulfillBuildError(
      'CONFIRMATION_ID_INVALID',
      'se espera un PNR o un id de orden: ^[A-Z0-9]{6,14}$ (booking-management-v1.yml:931-936, :1057-1063)',
    );
  }

  const formOfPaymentType = SABRE_TICKETING_FORMS_OF_PAYMENT.find(
    (allowed) => allowed === data.formOfPayment,
  );
  if (formOfPaymentType === undefined) {
    throw new SabreFulfillBuildError(
      'FORM_OF_PAYMENT_INVALID',
      'la emisión sólo admite CASH, ON_ACCOUNT o INVOICE: nunca tarjeta (D1)',
    );
  }
  const formsOfPayment = [buildFormOfPayment(formOfPaymentType, data.invoiceDescription)];
  const primaryFormOfPayment = indexValue(sabreIndexIn(formsOfPayment, 0));

  const qualifiers: { commissionPercentage?: string; validatingAirlineCode?: string } = {};
  if (data.commissionPercentage !== undefined) {
    if (typeof data.commissionPercentage !== 'number') {
      throw new SabreFulfillBuildError('COMMISSION_INVALID', 'commissionPercentage es un número');
    }
    qualifiers.commissionPercentage = formatSabreCommissionPercentage(data.commissionPercentage);
  }
  if (data.validatingAirlineCode !== undefined) {
    if (!VALIDATING_AIRLINE_PATTERN.test(data.validatingAirlineCode)) {
      throw new SabreFulfillBuildError(
        'VALIDATING_AIRLINE_INVALID',
        'validatingAirlineCode es IATA de dos caracteres (booking-management-v1.yml:7724-7729)',
      );
    }
    qualifiers.validatingAirlineCode = data.validatingAirlineCode;
  }

  const ticketFulfillment: SabreFulfillmentWire = {
    ...(Object.keys(qualifiers).length === 0 ? {} : { ticketingQualifiers: qualifiers }),
    payment: { primaryFormOfPayment },
  };
  const ancillaryIds = buildAncillaryIds(data.ancillaryItemIds);
  const fulfillments: SabreFulfillmentWire[] = [ticketFulfillment];
  if (ancillaryIds.length > 0) {
    fulfillments.push({ ancillaryIds, payment: { primaryFormOfPayment } });
  }

  let targetPcc: string | undefined;
  if (data.targetPcc !== undefined) {
    if (!SABRE_PCC_PATTERN.test(data.targetPcc)) {
      throw new SabreFulfillBuildError(
        'TARGET_PCC_INVALID',
        'se espera ^[A-Z0-9]{3,4}$ (booking-management-v1.yml:953-957)',
      );
    }
    targetPcc = data.targetPcc;
  }
  const designatePrinters = buildPrinters(data.printers);

  return {
    confirmationId: data.confirmationId,
    bookingSource: resolveBookingSource(data.confirmationId),
    fulfillments,
    formsOfPayment,
    receivedFrom: SABRE_FULFILL_RECEIVED_FROM,
    acceptPriceChanges: false,
    priceQuoteExpirationMethod: SABRE_FULFILL_PRICE_QUOTE_METHOD,
    backDatePriceQuoteMethod: SABRE_FULFILL_PRICE_QUOTE_METHOD,
    commitTicketToBookingWaitTime: SABRE_FULFILL_COMMIT_WAIT_MS,
    ...(targetPcc === undefined ? {} : { targetPcc }),
    ...(designatePrinters === undefined ? {} : { designatePrinters }),
  };
}

/** Clave de idempotencia del saga: `sha256` del cuerpo canónico. Ver la cabecera del módulo. */
export function sabreFulfillIdempotencyKey(request: SabreFulfillTicketsRequest): string {
  return sabreBodyDigest(request);
}

/** Línea de log estructurado. Nombra la forma de la emisión, **nunca los identificadores**. */
export function describeSabreFulfillRequest(
  request: SabreFulfillTicketsRequest,
): Record<string, unknown> {
  const ticketing = request.fulfillments[0]?.ticketingQualifiers;
  return {
    operation: SABRE_FULFILL_PATH,
    bookingSource: request.bookingSource,
    formOfPayment: request.formsOfPayment.map((fop) => fop.type),
    fulfillments: request.fulfillments.length,
    ancillaries: request.fulfillments.reduce(
      (sum, fulfillment) => sum + (fulfillment.ancillaryIds?.length ?? 0),
      0,
    ),
    withCommission: ticketing?.commissionPercentage !== undefined,
    withValidatingAirline: ticketing?.validatingAirlineCode !== undefined,
    withTargetPcc: request.targetPcc !== undefined,
    withPrinters: request.designatePrinters !== undefined,
    acceptPriceChanges: request.acceptPriceChanges,
    priceQuoteExpirationMethod: request.priceQuoteExpirationMethod,
    backDatePriceQuoteMethod: request.backDatePriceQuoteMethod,
    commitTicketToBookingWaitTime: request.commitTicketToBookingWaitTime,
  };
}
