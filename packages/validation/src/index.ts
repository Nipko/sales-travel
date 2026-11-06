import { z } from 'zod';

export { z };

// Identificadores comunes
export const TenantIdSchema = z.string().uuid();
export const CurrencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/);
export const CountryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/);
export const LanguageCodeSchema = z.enum(['es', 'pt', 'en']);

// Países ISO 3166-1: el CRM guarda alfa-3 y los proveedores piden alfa-2.
export { ISO_3166_ALPHA3_TO_ALPHA2, isIsoCountryAlpha2, toIsoCountryAlpha2 } from './iso-3166';

// El nombre visible de una persona: lo usan el perfil (PATCH /me) y el canje de la invitación.
export {
  PERSON_NAME_MAX,
  PERSON_NAME_MESSAGES,
  PersonNameSchema,
  normalizePersonName,
  personNameProblem,
} from './person-name';
