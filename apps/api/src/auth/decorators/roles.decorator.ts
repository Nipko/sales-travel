import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../database/database.types.js';

export const ROLES_KEY = 'requiredRoles';

/**
 * Restringe un endpoint (o un controller entero) a los roles indicados.
 *
 * El rol efectivo es el que el usuario tiene EN EL TENANT ACTIVO del request, no en
 * cualquier nodo: un tenant_admin de la agencia A entra como `vendedor` a la agencia B
 * si esa es su membership allí.
 *
 * @example
 *   @Roles('tenant_admin', 'agency_admin')
 *   @Post('usuarios')
 *   crear() { ... }
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
