import { z } from '@sales-travel/validation';
import { FlightSearchCriteriaSchema } from '@sales-travel/domain';
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
