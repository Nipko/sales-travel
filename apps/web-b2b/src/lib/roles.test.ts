import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLES,
  AGENCY_ADMIN_ROLES,
  MFA_REQUIRED_ROLES,
  PLATFORM_ROLES,
  ROLE_RANK,
} from './roles';

/** Las listas de la web son las del API (apps/api/src/auth/roles.ts), leídas del código. */
const API = readFileSync(
  fileURLToPath(new URL('../../../api/src/auth/roles.ts', import.meta.url)),
  'utf8',
);

function apiList(name: string): string[] {
  const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`).exec(API)?.[1] ?? '';
  return [...body.replace(/\/\/.*$/gm, '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
}

describe('los roles de la web, espejo del API', () => {
  it.each([
    ['PLATFORM_ROLES', PLATFORM_ROLES],
    ['ADMIN_ROLES', ADMIN_ROLES],
    ['AGENCY_ADMIN_ROLES', AGENCY_ADMIN_ROLES],
    ['MFA_REQUIRED_ROLES', MFA_REQUIRED_ROLES],
  ] as const)('%s', (name, web) => {
    const api = apiList(name);
    expect(api.length, `no se leyó ${name} del API`).toBeGreaterThan(0);
    expect([...web]).toEqual(api);
  });

  it('ROLE_RANK', () => {
    const body = /export const ROLE_RANK[^=]*= \{([\s\S]*?)\}/.exec(API)?.[1] ?? '';
    const api = Object.fromEntries(
      [...body.matchAll(/(\w+): (\d+)/g)].map((m) => [m[1] ?? '', Number(m[2])]),
    );
    expect(ROLE_RANK).toEqual(api);
  });

  it('platform_admin, retirado, no administra (H7)', () => {
    expect(ADMIN_ROLES).not.toContain('platform_admin');
  });
});
