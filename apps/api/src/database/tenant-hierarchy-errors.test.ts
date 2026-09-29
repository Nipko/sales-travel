import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  TENANT_HIERARCHY_SQLSTATE,
  TENANT_MOVE_BLOCKED_SQLSTATE,
  TenantHierarchyError,
  TenantHierarchyNotFoundError,
  TenantMoveForbiddenError,
  tenantHierarchyHttpError,
} from './tenant-hierarchy-errors.js';

/** La forma de un error de `pg` (DatabaseError de pg-protocol): lo que el filtro recibe. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('mensaje crudo de la base, con el id 7970ade5 del tenant'), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
}

describe('tenantHierarchyHttpError', () => {
  it.each([
    ['tenant_root_must_be_platform', 'TENANT_ROOT_MUST_BE_PLATFORM'],
    ['tenant_platform_is_root', 'TENANT_PLATFORM_IS_ROOT'],
    ['tenant_branch_type', 'TENANT_BRANCH_TYPE'],
    ['tenant_branch_parent', 'TENANT_BRANCH_PARENT'],
    ['tenant_parent_type', 'TENANT_PARENT_TYPE'],
    ['tenant_children_type', 'TENANT_CHILDREN_TYPE'],
    ['tenant_depth_limit', 'TENANT_DEPTH_LIMIT'],
    ['tenant_move_cycle', 'TENANT_MOVE_CYCLE'],
    ['tenant_move_required', 'TENANT_MOVE_REQUIRED'],
  ])('STH01 con la regla %s → 409 con el motivo %s', (constraint, reason) => {
    const mapped = tenantHierarchyHttpError(pgError(TENANT_HIERARCHY_SQLSTATE, constraint));

    expect(mapped).toBeInstanceOf(TenantHierarchyError);
    expect(mapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(mapped?.reason).toBe(reason);
    // El texto es el de la API, nunca el de la base (que trae ids).
    expect(mapped?.message).not.toContain('7970ade5');
  });

  it.each([
    ['tenant_not_found', 'TENANT_NOT_FOUND'],
    ['tenant_parent_not_found', 'TENANT_PARENT_NOT_FOUND'],
  ])('STH01 con la regla %s → 404', (constraint, reason) => {
    const mapped = tenantHierarchyHttpError(pgError(TENANT_HIERARCHY_SQLSTATE, constraint));

    expect(mapped).toBeInstanceOf(TenantHierarchyNotFoundError);
    expect(mapped?.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(mapped?.reason).toBe(reason);
  });

  it.each([
    ['tenant_move_open_wallet_bookings', 'TENANT_MOVE_OPEN_WALLET_BOOKINGS'],
    ['tenant_move_open_inherited_bookings', 'TENANT_MOVE_OPEN_INHERITED_BOOKINGS'],
  ])('STH02 (%s) → 409 con su motivo', (constraint, reason) => {
    const mapped = tenantHierarchyHttpError(pgError(TENANT_MOVE_BLOCKED_SQLSTATE, constraint));

    expect(mapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(mapped?.reason).toBe(reason);
  });

  it('mover sin ser el superadmin de la plataforma (42501/tenant_move_forbidden) → 403', () => {
    const mapped = tenantHierarchyHttpError(pgError('42501', 'tenant_move_forbidden'));

    expect(mapped).toBeInstanceOf(TenantMoveForbiddenError);
    expect(mapped?.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(mapped?.reason).toBe('TENANT_MOVE_FORBIDDEN');
    expect(mapped?.message).not.toContain('7970ade5');
  });

  it('una regla que la API no conoce sale como 409 genérico, sin publicar el nombre', () => {
    const mapped = tenantHierarchyHttpError(pgError(TENANT_HIERARCHY_SQLSTATE, 'regla_nueva'));

    expect(mapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(mapped?.reason).toBe('TENANT_HIERARCHY_VIOLATION');
    expect(mapped?.message).toBe('La operación no respeta las reglas de la red.');
  });

  it('STH01 sin regla también es un 409 genérico', () => {
    expect(tenantHierarchyHttpError(pgError(TENANT_HIERARCHY_SQLSTATE))?.reason).toBe(
      'TENANT_HIERARCHY_VIOLATION',
    );
  });

  it.each([
    ['23505', 'uq_tenants_single_platform', 'TENANT_SINGLE_PLATFORM'],
    ['23514', 'tenants_platform_is_root', 'TENANT_PLATFORM_IS_ROOT'],
    ['23514', 'tenants_branch_is_agency', 'TENANT_BRANCH_TYPE'],
  ])('el respaldo sin trigger %s/%s dice lo mismo que la regla', (code, constraint, reason) => {
    expect(tenantHierarchyHttpError(pgError(code, constraint))?.reason).toBe(reason);
  });

  it.each([
    ['otra violación de unicidad', pgError('23505', 'tenants_slug_key')],
    ['un CHECK de otra columna', pgError('23514', 'tenants_primary_color_hex')],
    ['una violación de unicidad sin constraint', pgError('23505')],
    ['un error de RLS', pgError('42501')],
    ['un 42501 de otra regla (0025)', pgError('42501', 'otra_regla')],
    ['una regla de movimiento con otro código', pgError('P0001', 'tenant_move_forbidden')],
    ['un error sin código', new Error('boom')],
    ['un código que no es texto', Object.assign(new Error('x'), { code: 42 })],
    ['algo que no es un objeto', 'STH01'],
    ['null', null],
  ])('%s no es un error de la jerarquía', (_caso, error) => {
    expect(tenantHierarchyHttpError(error)).toBeUndefined();
  });
});
