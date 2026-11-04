import { z } from '@sales-travel/validation';

export const UuidParamSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

const ProviderCode = z.string().regex(/^[a-z0-9-]{1,64}$/, 'código de proveedor inválido');
/** `''` = el proveedor mismo. */
const MethodCode = z.string().regex(/^[a-z0-9_]{0,64}$/, 'código de forma de pago inválido');

const ItemSchema = z
  .object({ provider: ProviderCode, method: MethodCode.default(''), enabled: z.boolean() })
  .strict();

const NameSchema = z.string().trim().min(2).max(80);
const DescriptionSchema = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === '' ? null : v))
  .nullable();

export const CreateProfileSchema = z
  .object({
    name: NameSchema,
    description: DescriptionSchema.optional(),
    items: z.array(ItemSchema).max(200),
  })
  .strict();
export type CreateProfileDto = z.infer<typeof CreateProfileSchema>;

export const UpdateProfileSchema = z
  .object({
    name: NameSchema.optional(),
    description: DescriptionSchema.optional(),
    items: z.array(ItemSchema).max(200).optional(),
  })
  .strict();
export type UpdateProfileDto = z.infer<typeof UpdateProfileSchema>;

export const DuplicateProfileSchema = z.object({ name: NameSchema }).strict();
export type DuplicateProfileDto = z.infer<typeof DuplicateProfileSchema>;

export const SetDefaultSchema = z.object({ isDefault: z.boolean() }).strict();
export type SetDefaultDto = z.infer<typeof SetDefaultSchema>;

/** `null` = quitar el perfil: el nodo vuelve a heredar. */
export const AssignProfileSchema = z.object({ profileId: UuidParamSchema.nullable() }).strict();
export type AssignProfileDto = z.infer<typeof AssignProfileSchema>;

/**
 * Una regla a mano. `tenantId: null` = global. `enabled: null` = quitar la regla (vuelve a decidir
 * el perfil o la herencia).
 */
export const SetRuleSchema = z
  .object({
    tenantId: UuidParamSchema.nullable(),
    provider: ProviderCode,
    method: MethodCode.default(''),
    enabled: z.boolean().nullable(),
    reason: z
      .string()
      .trim()
      .max(500)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .strict();
export type SetRuleDto = z.infer<typeof SetRuleSchema>;
