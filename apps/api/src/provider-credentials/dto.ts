import { z } from '@sales-travel/validation';

/**
 * Upsert de credenciales BYOC. `credentials`/`config` se persisten verbatim (passthrough) porque
 * su forma depende del proveedor; sólo exigimos que sean objetos y que credentials no esté vacío.
 * NUNCA loguear `credentials`.
 */
export const UpsertProviderAccountSchema = z.object({
  tenantId: z.string().uuid(),
  providerCode: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'providerCode must be lowercase alphanumeric with hyphens'),
  label: z.string().trim().min(1).max(60).optional(),
  credentials: z.record(z.unknown()).refine((o) => Object.keys(o).length > 0, {
    message: 'credentials must not be empty',
  }),
  config: z.record(z.unknown()).optional(),
  isInheritable: z.boolean().optional(),
  status: z.enum(['active', 'sandbox', 'disabled']).optional(),
});
export type UpsertProviderAccountInput = z.infer<typeof UpsertProviderAccountSchema>;
