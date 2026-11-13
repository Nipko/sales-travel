import { z } from '@sales-travel/validation';

/** El borde de Plataforma → Superadmins y de las solicitudes de cambio. Sin I/O. */

export const Uuid = z.string().uuid({ message: 'el id no es válido' });

/** El porqué de un cambio: opcional, pero si viene, que diga algo. Nunca PII. */
const Reason = z
  .string()
  .trim()
  .min(3, { message: 'el motivo tiene que tener al menos 3 caracteres' })
  .max(500, { message: 'el motivo puede tener hasta 500 caracteres' })
  .nullable()
  .optional()
  .transform((v) => v ?? null);

export const GrantPlatformAdminSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, { message: 'el correo es demasiado largo' })
      .email({ message: 'escribe el correo completo de la cuenta' }),
    supervised: z.boolean({ required_error: 'di si es supervisado o pleno' }),
    reason: Reason,
    /**
     * Sin cuenta con ese correo: crearla y enviarle el correo para que elija su contraseña. Tiene que
     * pedirse a propósito (la pantalla lo pregunta): sin esto, un correo mal escrito crearía una
     * cuenta superadmin para un buzón ajeno.
     */
    createAccount: z.boolean().optional().default(false),
    /** El nombre de la persona, sólo al crear la cuenta. */
    name: z.string().trim().min(2).max(120).optional(),
  })
  .strict();
export type GrantPlatformAdminDto = z.infer<typeof GrantPlatformAdminSchema>;

export const SetSupervisionSchema = z
  .object({
    supervised: z.boolean({ required_error: 'di si es supervisado o pleno' }),
    reason: Reason,
  })
  .strict();
export type SetSupervisionDto = z.infer<typeof SetSupervisionSchema>;

export const RevokePlatformAdminSchema = z.object({ reason: Reason }).strict();
export type RevokePlatformAdminDto = z.infer<typeof RevokePlatformAdminSchema>;

/** Lo que se guarda en la solicitud de cada cambio de superadmins, para aplicarlo al aprobar. */
export const GrantInputSchema = GrantPlatformAdminSchema;
export const SupervisionInputSchema = SetSupervisionSchema.extend({ userId: Uuid }).strict();
export const RevokeInputSchema = RevokePlatformAdminSchema.extend({ userId: Uuid }).strict();

export const DecisionSchema = z
  .object({
    note: z
      .string()
      .trim()
      .min(1, { message: 'la nota no puede ir vacía' })
      .max(500, { message: 'la nota puede tener hasta 500 caracteres' })
      .nullable()
      .optional()
      .transform((v) => v ?? null),
  })
  .strict();
export type DecisionDto = z.infer<typeof DecisionSchema>;

export const CHANGE_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'failed',
] as const;

export const ChangeRequestListQuerySchema = z
  .object({
    status: z
      .enum(CHANGE_REQUEST_STATUSES, {
        errorMap: () => ({ message: `estado inválido: usa ${CHANGE_REQUEST_STATUSES.join(', ')}` }),
      })
      .optional(),
  })
  .strict();
export type ChangeRequestListQuery = z.infer<typeof ChangeRequestListQuerySchema>;
