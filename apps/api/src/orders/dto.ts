import { isIsoCountryAlpha2, z } from '@sales-travel/validation';
import {
  FlightSearchCriteriaSchema,
  TRAVELER_DOCUMENT_TYPES,
  TRAVELER_SPECIAL_SERVICE_CODES,
} from '@sales-travel/domain';
import { OfferSchema } from '@sales-travel/canonical';

/** Objetos JSON de pasajeros que se persisten verbatim después de validar el sobre. */
const jsonObject = z.record(z.unknown());

/** Nueve pasajeros con asiento, por hasta dieciséis aviones (tramos y cambios de equipo). */
const SEATS_MAX = 9 * 16;

/**
 * Un asiento elegido al reservar (SAB-16), en los ejes del mapa de asientos. `strict` y sin
 * `offerRef`: la oferta del asiento la pone el servidor desde el mapa que vuelve a leer justo antes
 * de reservar, nunca el navegador. Tampoco hay precio: sólo se reservan asientos sin cargo, y eso
 * también lo decide el mapa.
 */
export const SeatSelectionSchema = z
  .object({
    passengerIndex: z.number().int().min(0).max(8),
    segmentRef: z.number().int().min(0).max(15),
    legIndex: z.number().int().min(0).max(1).default(0),
    row: z.number().int().min(1).max(999),
    column: z.string().regex(/^[A-Z]$/),
  })
  .strict();

// La Offer sí cruza una frontera de seguridad: de ella salen tenant, proveedor, precio e ids
// opacos que se reenvían a Sabre. Por eso se valida completa contra el contrato canónico; aceptar
// un record arbitrario aquí permitiría saltarse todos esos invariantes antes de la revalidación.
// Passenger todavía no tiene un schema compartido en domain, de modo que conserva la validación
// acotada del sobre y el ACL valida los campos específicos del proveedor.
export const CreateOrderSchema = z
  .object({
    offer: OfferSchema,
    searchCriteria: FlightSearchCriteriaSchema,
    passengers: z.array(jsonObject).min(1).max(9),
    contactInfo: z
      .object({
        email: z.string().trim().email().max(200).optional(),
        phone: z.string().trim().max(40).optional(),
      })
      .passthrough(),
    quotationId: z.string().uuid().optional(),
    seats: z.array(SeatSelectionSchema).min(1).max(SEATS_MAX).optional(),
  })
  // No existe cobro/emisión en createOrder. Rechazar `payment` evita que un cliente crea que una
  // tarjeta enviada y silenciosamente descartada fue procesada.
  .strict();
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export const ReshopOrderSchema = z.object({
  paidOrderId: z.string().trim().min(1).max(200),
  bnplOrderId: z.string().trim().min(1).max(200),
  ticketDocIds: z.array(z.string().trim().min(1).max(200)).max(50),
});
export type ReshopOrderInput = z.infer<typeof ReshopOrderSchema>;

export const PayOrderSchema = z.object({
  payment: z.record(z.unknown()),
});
export type PayOrderInput = z.infer<typeof PayOrderSchema>;

/**
 * Pedir la emisión de una reserva. El total y la moneda son los que el vendedor tenía en pantalla
 * al confirmar: si la orden ya dice otra cosa, no se emite (409). Sin forma de pago: la decide la
 * cuenta del proveedor (CASH, ON_ACCOUNT o INVOICE) y nunca es una tarjeta (D1). `strict` por lo
 * mismo que `CreateOrderSchema`: un `payment` que se descarta en silencio parece cobrado.
 */
export const IssueOrderSchema = z
  .object({
    expectedTotalMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type IssueOrderInput = z.infer<typeof IssueOrderSchema>;

/**
 * Agregar maletas y servicios a una reserva confirmada (SAB-20). Sólo QUÉ y para QUIÉN: el precio lo
 * pone el servidor con el catálogo que vuelve a leer. `expectedTotalMinor` es lo que el vendedor vio
 * que suman los servicios elegidos: si el catálogo dice otra cosa, no se agrega nada (409).
 */
export const AddServicesSchema = z
  .object({
    selections: z
      .array(
        z
          .object({
            serviceOfferItemId: z.string().min(1).max(200),
            passengerIndexes: z
              .array(z.number().int().min(0).max(8))
              .min(1)
              .max(9)
              .refine((ids) => new Set(ids).size === ids.length, 'passengerIndexes repetidos'),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine(
        (list) => new Set(list.map((s) => s.serviceOfferItemId)).size === list.length,
        'serviceOfferItemId repetido',
      ),
    expectedTotalMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type AddServicesInput = z.infer<typeof AddServicesSchema>;

/**
 * Quitar servicios agregados antes de emitir: las líneas de la orden (ids nuestros, nunca del
 * proveedor) y lo que el vendedor vio que suman.
 */
export const RemoveServicesSchema = z
  .object({
    lineIds: z
      .array(z.string().uuid())
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, 'lineIds repetidos'),
    expectedTotalMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type RemoveServicesInput = z.infer<typeof RemoveServicesSchema>;

// ---------------------------------------------------------------------------------------------
// Datos de los pasajeros de una reserva hecha (SAB-25)
// ---------------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` que existe en el calendario (`2034-02-30` no). */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Hoy en UTC, `YYYY-MM-DD`. Las fechas de documento no tienen hora. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearsFromToday(years: number): string {
  const date = new Date(`${todayUtc()}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

/** Letras y dígitos en mayúsculas: «ab-123.456» y «AB 123456» son el mismo documento. */
function normalizedCode(min: number, max: number) {
  const shape = new RegExp(`^[A-Z0-9]{${String(min)},${String(max)}}$`);
  return z
    .string()
    .max(40)
    .transform((value) => value.toUpperCase().replace(/[\s.\-/]/g, ''))
    .pipe(z.string().regex(shape));
}

/** País ISO 3166-1 alfa-2 de la lista oficial (no basta con dos letras). */
const IsoCountrySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine(isIsoCountryAlpha2, 'país ISO 3166-1 alfa-2');

/**
 * El documento corregido. Vencido no sirve para viajar (y la aerolínea lo rechaza: `INVALID_VALUE`
 * «The expiry date of the identity document cannot be in the past»); a más de 20 años es un error de
 * tipeo. El titular no se teclea: es el pasajero de la reserva.
 */
const IdentityDocumentChangeSchema = z
  .object({
    type: z.enum(TRAVELER_DOCUMENT_TYPES),
    number: normalizedCode(4, 20),
    issuingCountry: IsoCountrySchema,
    nationality: IsoCountrySchema,
    expiryDate: z
      .string()
      .refine(isCalendarDate, 'fecha YYYY-MM-DD')
      .refine((value) => value > todayUtc(), 'documento vencido')
      .refine((value) => value <= yearsFromToday(20), 'vencimiento a más de 20 años'),
    birthDate: z
      .string()
      .refine(isCalendarDate, 'fecha YYYY-MM-DD')
      .refine((value) => value < todayUtc(), 'nacimiento en el futuro')
      .refine((value) => value >= yearsFromToday(-120), 'nacimiento hace más de 120 años')
      .optional(),
  })
  .strict();

/** El viajero frecuente: la aerolínea del programa (IATA) y el número. */
const LoyaltyChangeSchema = z
  .object({
    carrierCode: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{2}$/)),
    number: normalizedCode(4, 25),
  })
  .strict();

/**
 * Corregir los datos de los pasajeros de una reserva confirmada o emitida (SAB-25). Por pasajero
 * (`index`, base cero) y sólo lo que cambia: el documento, el viajero frecuente y el conjunto de
 * servicios especiales de una lista CERRADA de códigos —nunca texto libre, que sería un mensaje
 * libre a la aerolínea—. Un campo de más corta el pedido.
 */
export const ModifyTravelersSchema = z
  .object({
    travelers: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(8),
            identityDocument: IdentityDocumentChangeSchema.optional(),
            loyalty: LoyaltyChangeSchema.optional(),
            specialServices: z
              .array(z.enum(TRAVELER_SPECIAL_SERVICE_CODES))
              .max(TRAVELER_SPECIAL_SERVICE_CODES.length)
              .refine((codes) => new Set(codes).size === codes.length, 'servicios repetidos')
              .optional(),
          })
          .strict()
          .refine(
            (change) =>
              change.identityDocument !== undefined ||
              change.loyalty !== undefined ||
              change.specialServices !== undefined,
            'un pasajero sin cambios',
          ),
      )
      .min(1)
      .max(9)
      .refine(
        (list) => new Set(list.map((change) => change.index)).size === list.length,
        'un pasajero repetido',
      ),
  })
  .strict();
export type ModifyTravelersInput = z.infer<typeof ModifyTravelersSchema>;

/**
 * ¿El total guardado de la orden es el que el vendedor vio? `orders.total_amount` es BIGINT (0023)
 * y `pg` entrega BIGINT como TEXTO (`'34012'`), aunque `OrderRow` lo declare `number`: comparado
 * con `!==` contra el número del cuerpo, toda emisión salía con «el total cambió». Se compara el
 * valor entero, venga como número o como texto; cualquier otra forma no coincide.
 */
export function isSameMinorAmount(stored: unknown, expected: number): boolean {
  if (!Number.isSafeInteger(expected)) return false;
  if (typeof stored === 'number') return stored === expected;
  if (typeof stored === 'bigint') return stored === BigInt(expected);
  if (typeof stored === 'string' && /^-?\d{1,19}$/.test(stored)) {
    return BigInt(stored) === BigInt(expected);
  }
  return false;
}
