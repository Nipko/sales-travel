import { z } from 'zod';

export { z };

// Identificadores comunes
export const TenantIdSchema = z.string().uuid();
export const UserIdSchema = z.string().uuid();
export const CurrencyCodeSchema = z.string().length(3).regex(/^[A-Z]{3}$/);
export const CountryCodeSchema = z.string().length(2).regex(/^[A-Z]{2}$/);
export const LanguageCodeSchema = z.enum(['es', 'pt', 'en']);

// Paginación
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof PaginationSchema>;
