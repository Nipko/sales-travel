import { z } from '@sales-travel/validation';

/** Objetos JSON que se persisten verbatim (offer/searchCriteria provider-shaped): passthrough. */
const jsonObject = z.record(z.unknown());

// La oferta y los pasajeros tienen forma del proveedor (canonical Offer/Passenger). Validamos el
// SOBRE (que sean objetos/arrays con límites de cordura) sin re-derivar el modelo canónico, para
// no rechazar ofertas válidas. La integridad fina la garantiza el ACL/mapper aguas abajo.
export const CreateOrderSchema = z.object({
  offer: jsonObject,
  searchCriteria: jsonObject,
  passengers: z.array(jsonObject).min(1).max(9),
  contactInfo: z
    .object({
      email: z.string().trim().email().max(200).optional(),
      phone: z.string().trim().max(40).optional(),
    })
    .passthrough(),
  quotationId: z.string().uuid().optional(),
});
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
