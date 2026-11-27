import { z } from '@sales-travel/validation';
import { BillingSchema } from './billing.js';

/** Objeto JSON arbitrario que se persiste verbatim: passthrough para NO perder claves anidadas. */
const jsonObject = z.record(z.unknown());

const dateTimeString = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid datetime' });

export const CreateQuotationSchema = z.object({
  searchCriteria: jsonObject,
  selectedOffer: jsonObject,
  customerName: z.string().trim().max(200).optional(),
  customerEmail: z.string().trim().email().max(200).optional(),
  customerPhone: z.string().trim().max(40).optional(),
  notes: z.string().max(4000).optional(),
  expiresAt: dateTimeString,
});
export type CreateQuotationInput = z.infer<typeof CreateQuotationSchema>;

export const QuotationStatusSchema = z.enum(['draft', 'sent', 'accepted', 'expired', 'cancelled']);

/** Datos de cliente editables en la cotización (todos opcionales/anulables). */
export const UpdateQuotationCustomerSchema = z.object({
  customerName: z.string().trim().max(200).nullish(),
  customerEmail: z.string().trim().email().max(200).nullish(),
  customerPhone: z.string().trim().max(40).nullish(),
  notes: z.string().max(4000).nullish(),
  /** 0091: a nombre de quién se factura. Ausente = no se toca; `null` = se borra. */
  billing: BillingSchema.nullish(),
});
export type UpdateQuotationCustomerInput = z.infer<typeof UpdateQuotationCustomerSchema>;

/**
 * Cuántas filas trae un listado: las más nuevas primero, 100 de entrada y «Ver más» pide más
 * (QA-H-15). Un tope y no un cursor: el panel relee la lista después de cada acción y así no pierde
 * lo que ya había cargado. Más allá de 1000 hace falta buscar en el servidor.
 */
export const ListLimitQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(1000).default(100) })
  .strict();
export type ListLimitQuery = z.infer<typeof ListLimitQuerySchema>;
