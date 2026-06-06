import { z } from '@sales-travel/validation';

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
});
export type UpdateQuotationCustomerInput = z.infer<typeof UpdateQuotationCustomerSchema>;
