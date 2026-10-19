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

/**
 * Años cumplidos en `date` de quien nació en `birthdate` (los dos `YYYY-MM-DD`), o `null` si
 * alguno no tiene esa forma. Sin `Date`: un `new Date('2017-09-15')` es medianoche UTC y en
 * Colombia es el 14, o sea un día —y a veces un año— menos.
 */
export function ageOnDate(birthdate: string, date: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthdate);
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (b === null || d === null) return null;
  const years = Number(d[1]) - Number(b[1]);
  return `${d[2]}-${d[3]}` >= `${b[2]}-${b[3]}` ? years : years - 1;
}

/** Edad de niño que cotiza con tarifa de niño: de 2 a 11 años cumplidos. */
export const CHILD_AGE_MIN = 2;
export const CHILD_AGE_MAX = 11;

/** Conteo de pasajeros para una búsqueda (sin datos personales). */
export const PaxCountSchema = z
  .object({
    adults: z.number().int().min(1).max(9),
    children: z.number().int().min(0).max(9).default(0),
    infants: z.number().int().min(0).max(9).default(0),
    /**
     * Edad de cada niño el día del viaje, una por niño. OPCIONAL: sin ella se cotiza un niño
     * genérico. Con ella la tarifa puede cambiar —en CERT, un niño de 8 años salió 42,80 USD más
     * caro que el genérico por impuestos (docs/sabre/16)—, y por eso los sitios de venta la piden.
     */
    childAges: z.array(z.number().int().min(CHILD_AGE_MIN).max(CHILD_AGE_MAX)).max(9).optional(),
    /**
     * Cuántos de los `infants` viajan en su propio asiento (el resto, en brazos). Un infante con
     * asiento paga como un niño. Ausente = todos en brazos.
     */
    infantsWithSeat: z.number().int().min(0).max(9).optional(),
  })
  .refine((v) => v.infants <= v.adults, {
    message: 'infants must not exceed adults (1 lap infant per adult)',
    path: ['infants'],
  })
  .refine((v) => v.childAges === undefined || v.childAges.length === v.children, {
    message: 'childAges must have one age per child',
    path: ['childAges'],
  })
  .refine((v) => (v.infantsWithSeat ?? 0) <= v.infants, {
    message: 'infantsWithSeat must not exceed infants',
    path: ['infantsWithSeat'],
  });
export type PaxCount = z.infer<typeof PaxCountSchema>;
