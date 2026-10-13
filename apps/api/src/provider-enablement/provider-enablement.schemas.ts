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

/** Los vencimientos que ofrece el panel para un apagado de emergencia: 1 h, 4 h y 24 h. */
export const KILL_SWITCH_EXPIRY_MINUTES = [60, 240, 1440] as const;

/**
 * Motivo obligatorio de un apagado de emergencia o de cerrar un circuito: entre 5 y 500 caracteres
 * útiles. Quien lo lea después (en la auditoría o en el panel) tiene que entender por qué.
 */
const RequiredReasonSchema = z.string().trim().min(5).max(500);

/**
 * Apagar un proveedor para toda la plataforma: `sales` (búsquedas, pre-reservas y reservas nuevas)
 * o `all` (también la post-venta), con motivo y un vencimiento de la lista o `null` (sin
 * vencimiento). `expiresInMinutes` es obligatorio: sin vencimiento también es una decisión.
 */
export const SetKillSwitchSchema = z
  .object({
    level: z.enum(['all', 'sales']),
    reason: RequiredReasonSchema,
    expiresInMinutes: z
      .union([
        z.literal(KILL_SWITCH_EXPIRY_MINUTES[0]),
        z.literal(KILL_SWITCH_EXPIRY_MINUTES[1]),
        z.literal(KILL_SWITCH_EXPIRY_MINUTES[2]),
      ])
      .nullable(),
  })
  .strict();

export type SetKillSwitchDto = z.infer<typeof SetKillSwitchSchema>;

/** Levantar el apagado del panel, con un motivo opcional. */
export const ClearKillSwitchSchema = z
  .object({
    reason: ReasonSchema.nullable().optional(),
  })
  .strict();

export type ClearKillSwitchDto = z.infer<typeof ClearKillSwitchSchema>;

/** Cerrar a mano el circuito de un proveedor, con motivo. */
export const ResetCircuitSchema = z
  .object({
    reason: RequiredReasonSchema,
  })
  .strict();

export type ResetCircuitDto = z.infer<typeof ResetCircuitSchema>;
