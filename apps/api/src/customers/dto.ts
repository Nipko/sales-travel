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
const CustomerBaseSchema = z.object({
  /** 0091: persona o empresa. Una empresa no tiene nacimiento, género ni nacionalidad. */
  customerType: z.enum(['person', 'company']).default('person'),
  firstName: z.string().trim().min(1).max(120),
  /** En una empresa va vacío: la razón social entera va en `firstName`. */
  lastName: z.string().trim().max(120),
  address: z.string().trim().max(300).nullish(),
  city: z.string().trim().max(120).nullish(),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/)
    .nullish(),
  email: z.string().trim().email().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
  documentType: z.string().trim().min(1).max(30),
  documentNumber: z.string().trim().min(1).max(60),
  documentIssuingCountry: z.string().trim().min(2).max(60),
  birthdate: dateString.nullish(),
  gender: z.string().trim().min(1).max(20).nullish(),
  nationality: z.string().trim().min(2).max(60).nullish(),
  passportExpiry: dateString.nullish(),
  preferences: z.record(z.unknown()).optional(),
});

/** Una persona sigue exigiendo apellido, nacimiento, género y nacionalidad (datos del billete). */
export const CreateCustomerSchema = CustomerBaseSchema.superRefine((v, ctx) => {
  if (v.customerType !== 'person') return;
  for (const field of ['lastName', 'birthdate', 'gender', 'nationality'] as const) {
    if (!v[field])
      ctx.addIssue({ code: 'custom', path: [field], message: 'requerido para una persona' });
  }
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

/** Update: todos los campos opcionales (PATCH parcial). */
export const UpdateCustomerSchema = CustomerBaseSchema.partial();

/** Búsqueda de clientes registrados: nombre, email o número de documento exacto. */
export const SearchCustomersSchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
