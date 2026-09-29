import { z } from '@sales-travel/validation';
import { ASSIGNABLE_ROLES } from '../auth/roles.js';
import { CREATABLE_TENANT_TYPES } from './tenant-admin.policy.js';

/**
 * Los roles que se asignan por API: los de `ASSIGNABLE_ROLES` (auth/roles.ts), la fuente única.
 * Ni `superadmin` ni `platform_admin` (retirado, D7 B) pasan este borde. La usan createUser,
 * changeRole y las invitaciones.
 */
export const AssignableRoleSchema = z.enum(ASSIGNABLE_ROLES, {
  errorMap: () => ({ message: `rol no asignable: usá uno de ${ASSIGNABLE_ROLES.join(', ')}` }),
});

export const ChangeRoleSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  role: AssignableRoleSchema,
});
export type ChangeRoleDto = z.infer<typeof ChangeRoleSchema>;

export const CreateUserSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(1).max(120),
  password: z.string().min(12).max(128),
  tenantId: z.string().uuid(),
  role: AssignableRoleSchema,
});
export type CreateUserDto = z.infer<typeof CreateUserSchema>;

export const InviteUserSchema = z.object({
  email: z.string().email().toLowerCase(),
  tenantId: z.string().uuid(),
  role: AssignableRoleSchema,
});
export type InviteUserDto = z.infer<typeof InviteUserSchema>;

export const AcceptInvitationSchema = z.object({
  token: z.string().min(10).max(512),
  name: z.string().min(1).max(120),
  password: z.string().min(12).max(128),
});
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationSchema>;

export const SetMembershipStatusSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  status: z.enum(['active', 'suspended']),
});
export type SetMembershipStatusDto = z.infer<typeof SetMembershipStatusSchema>;

export const SetUserStatusSchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(['active', 'suspended']),
});
export type SetUserStatusDto = z.infer<typeof SetUserStatusSchema>;

/** El `id` de la ruta. En minúsculas, como lo devuelve Postgres y como queda en la auditoría. */
export const TenantIdParamSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/**
 * Un campo opcional del formulario: vacío, sólo espacios o `null` es "no enviado". El panel manda
 * '' en los datos del admin inicial que no se llenan, y eso daba un 400 al crear una agencia sin
 * admin.
 */
function optionalField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) =>
      value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    schema.optional(),
  );
}

const CreatableTenantTypeSchema = z.enum(CREATABLE_TENANT_TYPES, {
  errorMap: () => ({
    message: 'tipo inválido: consolidator, agency o subagency (la plataforma no se crea por API)',
  }),
});

/**
 * Alta de un nodo de la red. El tipo lo decide el padre (D4 A): el cliente sólo lo manda para
 * pedir un consolidador, y si manda otro tiene que coincidir con el derivado. Sin padre, el del
 * superadmin cuelga de la plataforma; el de cualquier otro admin se rechaza.
 */
export const CreateTenantSchema = z
  .object({
    name: z.string().min(2).max(120),
    slug: z
      .string()
      .min(2)
      .max(50)
      .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
    countryCode: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/),
    defaultCurrency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/),
    defaultLanguage: optionalField(z.enum(['es', 'pt', 'en'])),
    parentTenantId: optionalField(
      z
        .string()
        .uuid()
        .transform((v) => v.toLowerCase()),
    ),
    tenantType: optionalField(CreatableTenantTypeSchema),
    /** Sucursal de Planetour: sólo el superadmin, y sólo bajo la plataforma. */
    isBranch: optionalField(z.boolean()),
    adminEmail: optionalField(z.string().trim().email().toLowerCase()),
    adminName: optionalField(z.string().trim().min(1).max(120)),
    adminPassword: optionalField(z.string().min(12).max(128)),
  })
  .superRefine((value, ctx) => {
    if (
      value.adminEmail === undefined &&
      (value.adminName !== undefined || value.adminPassword !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adminEmail'],
        message: 'indicá el email del admin, o dejá vacíos todos sus datos',
      });
    }
  });
export type CreateTenantDto = z.infer<typeof CreateTenantSchema>;

/**
 * Corrección de un nodo por el superadmin: estado, marca de sucursal y tipo. El tipo sólo cambia
 * dentro de D4 (lo valida la base con los hijos incluidos); la plataforma no se crea ni se toca
 * así. El padre no se cambia acá: eso es mover el nodo con su subárbol.
 */
export const UpdateTenantSchema = z
  .object({
    status: z.enum(['active', 'suspended']).optional(),
    isBranch: z.boolean().optional(),
    tenantType: CreatableTenantTypeSchema.optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.isBranch !== undefined || v.tenantType !== undefined, {
    message: 'indicá qué cambiar: status, isBranch o tenantType',
  });
export type UpdateTenantDto = z.infer<typeof UpdateTenantSchema>;

/** Mover un nodo con su subárbol (D6 A). El nuevo padre es obligatorio: sólo la plataforma es raíz. */
export const MoveTenantSchema = z
  .object({
    parentTenantId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
  })
  .strict();
export type MoveTenantDto = z.infer<typeof MoveTenantSchema>;
