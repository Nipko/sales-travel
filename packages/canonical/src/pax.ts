import { CountryCodeSchema, z } from '@sales-travel/validation';

export const PaxTypeSchema = z.enum(['ADT', 'CHD', 'INF']);
export type PaxType = z.infer<typeof PaxTypeSchema>;

export const GenderSchema = z.enum(['M', 'F', 'X']);
export type Gender = z.infer<typeof GenderSchema>;

export const DocumentTypeSchema = z.enum(['passport', 'id_card', 'driver_license']);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const TravelDocumentSchema = z.object({
  type: DocumentTypeSchema,
  number: z.string().min(1).max(40),
  issuingCountry: CountryCodeSchema,
  expiryDate: z.string().date().optional(),
});
export type TravelDocument = z.infer<typeof TravelDocumentSchema>;

/**
 * Pasajero individual. ADT = adult, CHD = child, INF = infant.
 * `dateOfBirth` es opcional al cotizar (solo se usa el `paxType`),
 * pero obligatorio al reservar (lo valida el caller).
 */
export const PaxSchema = z.object({
  paxType: PaxTypeSchema,
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  gender: GenderSchema.optional(),
  dateOfBirth: z.string().date().optional(),
  nationality: CountryCodeSchema.optional(),
  document: TravelDocumentSchema.optional(),
  email: z.string().email().optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9 ()-]{6,30}$/)
    .optional(),
});
export type Pax = z.infer<typeof PaxSchema>;

/** Conteo de pasajeros para una búsqueda (sin datos personales). */
export const PaxCountSchema = z
  .object({
    adults: z.number().int().min(1).max(9),
    children: z.number().int().min(0).max(9).default(0),
    infants: z.number().int().min(0).max(9).default(0),
  })
  .refine((v) => v.infants <= v.adults, {
    message: 'infants must not exceed adults (1 lap infant per adult)',
    path: ['infants'],
  });
export type PaxCount = z.infer<typeof PaxCountSchema>;
