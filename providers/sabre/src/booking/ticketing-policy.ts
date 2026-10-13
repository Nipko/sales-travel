import type { Itinerary, Offer } from '@sales-travel/canonical';
import { z } from 'zod';
import { SABRE_FLIGHT_CHECK_RAW_KEYS } from '../flight-check/response.mapper';
import type { SabreAgencyInput } from './create.request.builder';

/**
 * La política de emisión con que sale una reserva (`createBooking.agency`), decidida por la cuenta
 * y calculada contra la oferta que se reserva.
 *
 * Es la base para emitir: el carril VERIFICADO de punta a punta sin tarjeta es reservar con
 * `payment.formsOfPayment: [{ type: 'CASH' }]` **más** `agency.ticketingPolicy:
 * 'TICKETING_TIME_LIMIT'` con su `ticketingTimeLimitPolicy`, y emitir después con `CASH`
 * (docs/sabre/04 §7.6, tabla del veredicto). Sin política, la reserva queda sin plazo de emisión
 * declarado y nadie en la oficina sabe hasta cuándo puede emitir.
 *
 * Dos políticas y no las cuatro del contrato (`TicketingPolicyEnum`, `:8742`):
 *
 *  - **`TICKETING_TIME_LIMIT`** (por defecto) — emite la misma oficina que reserva, antes del plazo.
 *    El plazo sale del proveedor (revalidación) menos un margen, en la hora de la oficina.
 *  - **`FUTURE_TICKETING`** — la reserva queda para que emita el PCC de emisión de la cuenta
 *    (`futureTicketingPolicy.ticketingPcc`, `:4767-4800`): el gancho del consolidador que reserva
 *    en una oficina y emite en otra. Sin PCC de emisión no hay a quién dejársela, y cae a la
 *    primera con un aviso.
 *
 * `TODAY` y `ALREADY_TICKETED` no se ofrecen: el primero promete una emisión en el día que la
 * plataforma todavía no hace, y el segundo describe un PNR que ya tiene billete.
 *
 * Cómo interpreta Sabre la zona de `ticketingDate`/`ticketingTime` sólo se confirma en CERT
 * (SAB-12). Mientras tanto se envían en la hora local del PCC —la que el agente ve en Sabre Red—
 * y el margen por defecto absorbe el error de zona más probable.
 */

/** Las políticas que una cuenta puede elegir. Subconjunto de `TicketingPolicyEnum`. */
export const SABRE_BOOKING_TICKETING_POLICIES = [
  'TICKETING_TIME_LIMIT',
  'FUTURE_TICKETING',
] as const;

export type SabreBookingTicketingPolicy = (typeof SABRE_BOOKING_TICKETING_POLICIES)[number];

/**
 * Formas de pago con que se EMITE (`fulfillFlightTickets`). Ninguna es tarjeta: D1 prohíbe mandar
 * PAN o CVV, y el cobro al cliente va por el checkout del PSP. `CASH` es el carril verificado;
 * `ON_ACCOUNT` e `INVOICE` existen en `FulfillFormOfPaymentTypeEnum` y quedan a elección de la
 * cuenta. La reserva sigue saliendo con `CASH`, que es lo verificado en `createBooking`.
 */
export const SABRE_TICKETING_FORMS_OF_PAYMENT = ['CASH', 'ON_ACCOUNT', 'INVOICE'] as const;

export type SabreTicketingFormOfPayment = (typeof SABRE_TICKETING_FORMS_OF_PAYMENT)[number];

/** Margen máximo antes del plazo del proveedor: tres días cubren cualquier plazo razonable. */
export const SABRE_TICKETING_LEAD_HOURS_MAX = 72;

/** Dos horas: absorben un error de zona de una hora y dejan tiempo para emitir en la oficina. */
export const SABRE_DEFAULT_TICKETING_LEAD_HOURS = 2;

/** La zona de la primera oficina de la red. Sólo es el valor por defecto de la cuenta. */
export const SABRE_DEFAULT_PCC_TIME_ZONE = 'America/Bogota';

/**
 * Sin plazo del proveedor, la reserva pide emitir en 24 horas. No se le resta el margen: el margen
 * existe para no llegar tarde al plazo de la aerolínea, y aquí no hay uno contra el que medirlo.
 */
export const SABRE_TICKETING_FALLBACK_WINDOW_HOURS = 24;

/**
 * De dónde salió el plazo que se pidió:
 *
 *  - `PROVIDER` — el plazo de la revalidación menos el margen de la cuenta;
 *  - `PROVIDER_NO_MARGIN` — el margen no cabía (el plazo vence antes de que pase): se pide el plazo
 *    del proveedor tal cual, porque pedir uno anterior a ahora vencería la reserva al crearla;
 *  - `FALLBACK_WINDOW` — la oferta no trae plazo legible con zona: ahora + 24 h.
 */
export const SABRE_TICKETING_DEADLINE_SOURCES = [
  'PROVIDER',
  'PROVIDER_NO_MARGIN',
  'FALLBACK_WINDOW',
] as const;

export type SabreTicketingDeadlineSource = (typeof SABRE_TICKETING_DEADLINE_SOURCES)[number];

/** Por qué no se aplicó la política que la cuenta pidió. Vocabulario cerrado. */
export const SABRE_TICKETING_POLICY_FALLBACKS = ['NO_TICKETING_PCC'] as const;

export type SabreTicketingPolicyFallback = (typeof SABRE_TICKETING_POLICY_FALLBACKS)[number];

/**
 * El plazo de pago de una oferta NDC revalidada, tal como lo deja `offers/price` en
 * `provider.raw` (`buildProviderRaw` de `price/response.mapper.ts`). El de Flight Check vive en
 * {@link SABRE_FLIGHT_CHECK_RAW_KEYS}.paymentTimeLimit.
 */
export const SABRE_NDC_PAYMENT_TIME_LIMIT_RAW_KEY = 'paymentTimeLimitDateTime';

/**
 * ¿`value` es una zona IANA que el runtime sabe convertir?
 *
 * Se pregunta a `Intl` y no a una lista nuestra: una zona que el motor no conoce no se puede usar
 * para calcular la hora, y una que conoce sí, aunque no sea de la región.
 */
export function isSabrePccTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Lo que la cuenta decide sobre la emisión. Todos los campos tienen valor por defecto. */
export const SabreTicketingSettingsSchema = z
  .object({
    policy: z.enum(SABRE_BOOKING_TICKETING_POLICIES).default('TICKETING_TIME_LIMIT'),
    leadHours: z
      .number()
      .int()
      .min(0)
      .max(SABRE_TICKETING_LEAD_HOURS_MAX)
      .default(SABRE_DEFAULT_TICKETING_LEAD_HOURS),
    formOfPayment: z.enum(SABRE_TICKETING_FORMS_OF_PAYMENT).default('CASH'),
    pccTimeZone: z
      .string()
      .refine(isSabrePccTimeZone, 'no es una zona horaria IANA')
      .default(SABRE_DEFAULT_PCC_TIME_ZONE),
  })
  .strict();

export type SabreTicketingSettings = z.output<typeof SabreTicketingSettingsSchema>;
export type SabreTicketingSettingsInput = z.input<typeof SabreTicketingSettingsSchema>;

/** La decisión que se tomó, en vocabulario cerrado: es lo que citan el log, el evento y la orden. */
export interface SabreTicketingDecision {
  /** La política que viajó en `agency.ticketingPolicy`. */
  readonly policy: SabreBookingTicketingPolicy;
  /** La que pidió la cuenta. Difiere de {@link policy} sólo con {@link fallback}. */
  readonly requestedPolicy: SabreBookingTicketingPolicy;
  readonly fallback?: SabreTicketingPolicyFallback;
  /** Sólo con `TICKETING_TIME_LIMIT`: el plazo pedido, en la hora de {@link pccTimeZone}. */
  readonly deadline?: {
    readonly date: string;
    readonly time: string;
    readonly pccTimeZone: string;
    readonly source: SabreTicketingDeadlineSource;
  };
}

export interface SabreTicketingPlan {
  /** Los campos de emisión del bloque `agency`, listos para el builder. */
  readonly agency: Pick<
    SabreAgencyInput,
    'ticketingPolicy' | 'futureTicketingPolicy' | 'ticketingTimeLimitPolicy'
  >;
  readonly decision: SabreTicketingDecision;
}

/** Error de entrada: el plazo no se pudo calcular. Lo traduce a «no salió» quien lo llama. */
export class SabreTicketingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SabreTicketingPolicyError';
  }
}

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const AIRLINE_CODE = /^[A-Z0-9]{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
const HOUR_MS = 60 * 60 * 1000;

/**
 * La política de emisión de una reserva, sin tocar la red.
 *
 * `ticketingPcc` es el de la cuenta (`SabreConfig.ticketingPcc`); `now`, el reloj de quien
 * reserva, inyectado para que el cálculo se pueda probar.
 */
export function planSabreTicketingPolicy(input: {
  readonly offer: Offer;
  readonly settings: SabreTicketingSettings;
  readonly ticketingPcc?: string;
  readonly now: Date;
}): SabreTicketingPlan {
  const { offer, settings, now } = input;
  const ticketingPcc = input.ticketingPcc?.trim();

  if (settings.policy === 'FUTURE_TICKETING' && ticketingPcc !== undefined && ticketingPcc !== '') {
    return {
      agency: {
        ticketingPolicy: 'FUTURE_TICKETING',
        futureTicketingPolicy: { ticketingPcc },
      },
      decision: { policy: 'FUTURE_TICKETING', requestedPolicy: 'FUTURE_TICKETING' },
    };
  }

  const deadline = ticketingDeadlineFor(offer, settings, now);
  const airlineCode = ticketingAirlineOf(offer);
  return {
    agency: {
      ticketingPolicy: 'TICKETING_TIME_LIMIT',
      ticketingTimeLimitPolicy: {
        ...(airlineCode === null ? {} : { airlineCode }),
        ticketingDate: deadline.date,
        ticketingTime: deadline.time,
      },
    },
    decision: {
      policy: 'TICKETING_TIME_LIMIT',
      requestedPolicy: settings.policy,
      ...(settings.policy === 'FUTURE_TICKETING' ? { fallback: 'NO_TICKETING_PCC' as const } : {}),
      deadline,
    },
  };
}

/**
 * El plazo de pago que dio la revalidación, como instante.
 *
 * Sólo vale un instante con zona explícita: Flight Check lo guarda normalizado a UTC y NDC lo
 * declara `date-time`. Una hora sin zona —como el `lastTicketDate`/`lastTicketTime` de BFM— no se
 * convierte: inventarle la zona sería pedir otra hora como plazo, así que cuenta como «sin plazo».
 */
function providerDeadlineOf(offer: Offer): number | null {
  const raw = offer.provider.raw ?? {};
  for (const key of [
    SABRE_FLIGHT_CHECK_RAW_KEYS.paymentTimeLimit,
    SABRE_NDC_PAYMENT_TIME_LIMIT_RAW_KEY,
  ]) {
    const value = raw[key];
    if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) continue;
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return at;
  }
  return null;
}

function ticketingDeadlineFor(
  offer: Offer,
  settings: SabreTicketingSettings,
  now: Date,
): NonNullable<SabreTicketingDecision['deadline']> {
  const provider = providerDeadlineOf(offer);
  let at: number;
  let source: SabreTicketingDeadlineSource;
  if (provider === null) {
    at = now.getTime() + SABRE_TICKETING_FALLBACK_WINDOW_HOURS * HOUR_MS;
    source = 'FALLBACK_WINDOW';
  } else {
    const withMargin = provider - settings.leadHours * HOUR_MS;
    if (withMargin > now.getTime()) {
      at = withMargin;
      source = 'PROVIDER';
    } else {
      at = provider;
      source = 'PROVIDER_NO_MARGIN';
    }
  }
  return { ...wallClockIn(at, settings.pccTimeZone), pccTimeZone: settings.pccTimeZone, source };
}

/**
 * Un instante en la hora local de una zona, como `YYYY-MM-DD` y `HH:MM`.
 *
 * Los segundos se TRUNCAN, nunca se redondean: redondear hacia arriba pediría un plazo posterior
 * al calculado, y el plazo calculado es el último aceptable.
 */
function wallClockIn(at: number, timeZone: string): { date: string; time: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
  } catch {
    throw new SabreTicketingPolicyError('pccTimeZone no es una zona horaria IANA conocida');
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const time = `${part('hour')}:${part('minute')}`;
  if (!ISO_DATE.test(date) || !HH_MM.test(time)) {
    throw new SabreTicketingPolicyError(
      'el plazo de emisión no se pudo expresar como fecha y hora de la oficina',
    );
  }
  return { date, time };
}

/**
 * La aerolínea del plazo: la validadora de la tarifa y, sin ella, la comercializadora del primer
 * tramo («the first airline in the air booking», `TicketingTimeLimitPolicy`, `:4890-4893`). Sin
 * ninguna de las dos el campo se omite, que el contrato admite.
 */
function ticketingAirlineOf(offer: Offer): string | null {
  const validating = (offer.provider.raw ?? {})['validatingCarrierCode'];
  if (typeof validating === 'string' && AIRLINE_CODE.test(validating.toUpperCase())) {
    return validating.toUpperCase();
  }
  const itineraries: readonly Itinerary[] = offer.itineraries ?? [];
  const first = itineraries[0]?.segments[0]?.carrier.toUpperCase();
  return first !== undefined && AIRLINE_CODE.test(first) ? first : null;
}
