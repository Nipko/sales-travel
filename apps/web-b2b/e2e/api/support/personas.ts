/**
 * Una persona por rol para el arnés HTTP (INF-1/INF-2). Son usuarios PROPIOS del arnés (`api-*@e2e.test`,
 * sembrados en e2e/env/seed.sql): no comparten sesión, MFA ni puestos con los del E2E del panel, así
 * que las dos suites corren en cualquier orden sin pisarse.
 *
 * `ip`: dirección de documentación (RFC 5737) que el arnés manda como IP del cliente cuando conoce el
 * secreto interno del panel: cada persona tiene su propio cupo de rate limit, como en la vida real.
 */
export const API_PASSWORD = 'E2e-Prueba-2026!';

export interface Persona {
  email: string;
  tenant: string;
  role: string;
  /** El rol exige MFA: el arnés lo activa por API la primera vez. */
  mfa: boolean;
  ip: string;
}

export const PERSONAS = {
  superadmin: {
    email: 'api-superadmin@e2e.test',
    tenant: 'platform',
    role: 'superadmin',
    mfa: true,
    ip: '198.51.100.10',
  },
  supervisado: {
    email: 'api-supervisado@e2e.test',
    tenant: 'platform',
    role: 'superadmin',
    mfa: true,
    ip: '198.51.100.11',
  },
  consolidador: {
    email: 'api-consolidador@e2e.test',
    tenant: 'e2e-consolidador',
    role: 'consolidator_admin',
    mfa: true,
    ip: '198.51.100.20',
  },
  adminA: {
    email: 'api-admin-a@e2e.test',
    tenant: 'e2e-agencia-a',
    role: 'admin',
    mfa: true,
    ip: '198.51.100.30',
  },
  agencyAdminA: {
    email: 'api-agency-admin-a@e2e.test',
    tenant: 'e2e-agencia-a',
    role: 'agency_admin',
    mfa: true,
    ip: '198.51.100.31',
  },
  tenantAdminA: {
    email: 'api-tenant-admin-a@e2e.test',
    tenant: 'e2e-agencia-a',
    role: 'tenant_admin',
    mfa: true,
    ip: '198.51.100.32',
  },
  vendedorA: {
    email: 'api-vendedor-a@e2e.test',
    tenant: 'e2e-agencia-a',
    role: 'vendedor',
    mfa: false,
    ip: '198.51.100.33',
  },
  clienteA: {
    email: 'api-cliente-a@e2e.test',
    tenant: 'e2e-agencia-a',
    role: 'cliente_final',
    mfa: false,
    ip: '198.51.100.34',
  },
  sinMfa: {
    email: 'api-sin-mfa@e2e.test',
    tenant: 'e2e-agencia-a',
    role: 'admin',
    mfa: false,
    ip: '198.51.100.35',
  },
  vendedorSub: {
    email: 'api-vendedor-sub@e2e.test',
    tenant: 'e2e-subagencia',
    role: 'vendedor',
    mfa: false,
    ip: '198.51.100.40',
  },
  adminB: {
    email: 'api-admin-b@e2e.test',
    tenant: 'e2e-agencia-b',
    role: 'admin',
    mfa: true,
    ip: '198.51.100.50',
  },
  vendedorB: {
    email: 'api-vendedor-b@e2e.test',
    tenant: 'e2e-agencia-b',
    role: 'vendedor',
    mfa: false,
    ip: '198.51.100.51',
  },
  // EQU-06/07/08: el equipo de e2e-agencia-equipo. Sólo los usa equipo.api.ts, que los degrada,
  // suspende y quita; el seed los deja como al principio en cada corrida.
  jefeEquipo: {
    email: 'api-equipo-jefe@e2e.test',
    tenant: 'e2e-agencia-equipo',
    role: 'agency_admin',
    mfa: true,
    ip: '198.51.100.80',
  },
  adminEquipo: {
    email: 'api-equipo-admin@e2e.test',
    tenant: 'e2e-agencia-equipo',
    role: 'admin',
    mfa: true,
    ip: '198.51.100.81',
  },
  vendedorEquipo: {
    email: 'api-equipo-vendedor@e2e.test',
    tenant: 'e2e-agencia-equipo',
    role: 'vendedor',
    mfa: false,
    ip: '198.51.100.82',
  },
  // EQU-09/10/11/13: el miembro al que se le hace soporte (enlaces, bloqueo, puesto, cambio forzado).
  soporteEquipo: {
    email: 'api-equipo-soporte@e2e.test',
    tenant: 'e2e-agencia-equipo',
    role: 'vendedor',
    mfa: false,
    ip: '198.51.100.83',
  },
} as const satisfies Record<string, Persona>;

export type PersonaKey = keyof typeof PERSONAS;
