import { z } from '@sales-travel/validation';
import type { Role } from '../database/database.types.js';

/**
 * Roles que un admin puede asignar a otro usuario vía API.
 *
 * Excluye deliberadamente `superadmin` y `platform_admin`: son roles de plataforma que
 * otorgan acceso global (ver NetworkService.isSuperadmin, que busca el rol en CUALQUIER
 * nodo), así que asignarlos desde un endpoint de red permitiría a cualquier admin de
 * agencia escalar a control total. Sólo se conceden por migración/operación manual.
 *
 * Fuente única: la usan tanto createUser como changeRole.
 */
export const ASSIGNABLE_ROLES = [
  'consolidator_admin',
  'tenant_admin',
  'agency_admin',
  'admin',
  'vendedor',
  'cliente_final',
] as const satisfies readonly Role[];

export const AssignableRoleSchema = z.enum(ASSIGNABLE_ROLES);

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

export const CreateTenantSchema = z.object({
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
  defaultLanguage: z.enum(['es', 'pt', 'en']).optional(),
  // Modelo consolidador (B2B2B): si se indica padre, el tenant cuelga de él en la jerarquía.
  parentTenantId: z.string().uuid().optional(),
  tenantType: z.enum(['platform', 'consolidator', 'agency', 'subagency']).optional(),
  adminEmail: z.string().email().toLowerCase().optional(),
  adminName: z.string().min(1).max(120).optional(),
  adminPassword: z.string().min(12).max(128).optional(),
});
export type CreateTenantDto = z.infer<typeof CreateTenantSchema>;
