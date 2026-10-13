import { z } from '@sales-travel/validation';
import { FlightSearchCriteriaSchema } from '@sales-travel/domain';
import { OfferSchema } from '@sales-travel/canonical';

/** Objetos JSON de pasajeros que se persisten verbatim después de validar el sobre. */
const jsonObject = z.record(z.unknown());

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
