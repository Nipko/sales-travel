import { z } from '@sales-travel/validation';

/** El código de un proveedor de los registries: el mismo formato que el CHECK de 0048. */
export const ProviderCodeParamSchema = z.string().regex(/^[a-z0-9-]{1,64}$/, 'código inválido');

/**
 * En minúsculas, como lo devuelve Postgres: el mismo tenant en mayúsculas no encontraba su propio
 * ajuste en la vista del panel y dejaba otro `aggregate_id` en la auditoría.
 */
export const TenantIdParamSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/**
 * Motivo opcional. Vacío o sólo espacios es "sin motivo" (`null`), no un motivo en blanco que
 * después nadie entiende en la auditoría. Tope de 500, como el CHECK de la columna.
 */
const ReasonSchema = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === '' ? null : v));

/**
 * Fijar un ajuste (global o de un tenant). Quitarlo —volver a heredar— es el DELETE de la misma
 * ruta y no un `enabled: null`: son dos acciones distintas en el panel y en la auditoría.
 */
export const SetProviderEnablementSchema = z
  .object({
    enabled: z.boolean(),
    reason: ReasonSchema.nullable().optional(),
  })
  .strict();

export type SetProviderEnablementDto = z.infer<typeof SetProviderEnablementSchema>;
