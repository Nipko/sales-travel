import { z } from '@sales-travel/validation';

/** Fecha en string parseable (acepta 'YYYY-MM-DD' o ISO completo). Se conserva como string. */
const dateString = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid date' });

// Campos geográficos/documentales libres: el cliente envía formas variadas ('COL', 'PASAPORTE'),
// así que validamos integridad (longitud, no vacío) sin imponer un formato ISO estricto.
export const CreateCustomerSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
  documentType: z.string().trim().min(1).max(30),
  documentNumber: z.string().trim().min(1).max(60),
  documentIssuingCountry: z.string().trim().min(2).max(60),
  birthdate: dateString,
  gender: z.string().trim().min(1).max(20),
  nationality: z.string().trim().min(2).max(60),
  passportExpiry: dateString.nullish(),
  preferences: z.record(z.unknown()).optional(),
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

/** Update: todos los campos opcionales (PATCH parcial). */
export const UpdateCustomerSchema = CreateCustomerSchema.partial();
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
