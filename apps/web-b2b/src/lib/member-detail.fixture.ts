/**
 * Una ficha como la manda el API (MemberDetailService), para los tests de la ficha. Sólo la importan
 * tests: no es código del panel.
 */

export const NOW = Date.parse('2026-10-13T15:00:00Z');
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;
export const NODE = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
export const SUB = '1c7f7b63-8b58-4d9f-8b4c-2b3c4d5e6f70';
export const USER = '99999999-8888-4777-8666-555555555555';
export const SESSION = '11111111-2222-4333-8444-555555555555';
export const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function apiDetail(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: {
      id: USER,
      email: 'ana@agencia.co',
      name: 'Ana Pérez',
      status: 'active',
      createdAt: iso(NOW - 40 * DAY),
      emailVerified: true,
      lastLoginAt: iso(NOW - 3 * 60 * MIN),
      passwordChangedAt: iso(NOW - 2 * DAY),
      passwordResetRequired: false,
    },
    security: {
      mfaEnabled: true,
      mfaEnabledAt: '2026-06-12T10:00:00.000Z',
      recoveryCodesLeft: 8,
      trustedDevices: 2,
      lockedUntil: null,
      failedLoginAttempts: 0,
    },
    memberships: [
      {
        tenantId: NODE,
        tenantName: 'Agencia Norte',
        tenantType: 'agency',
        role: 'tenant_admin',
        status: 'active',
        createdAt: iso(NOW - 40 * DAY),
      },
      {
        tenantId: SUB,
        tenantName: 'Sucursal Sur',
        tenantType: 'subagency',
        role: 'vendedor',
        status: 'suspended',
        createdAt: iso(NOW - 10 * DAY),
      },
    ],
    sessions: [
      {
        id: SESSION,
        tenantId: NODE,
        tenantName: 'Agencia Norte',
        issuedAt: iso(NOW - 60 * MIN),
        lastSeenAt: iso(NOW - 3 * MIN),
        expiresAt: iso(NOW + DAY),
        ip: '203.0.113.7',
        userAgent: CHROME_WINDOWS,
        mfaVerified: true,
        seatTenantId: NODE,
        current: false,
      },
    ],
    invitedBy: { email: 'jefa@agencia.co', at: iso(NOW - 40 * DAY) },
    invitationsSent: {
      pending: 1,
      items: [
        {
          id: 'inv-1',
          email: 'nuevo@gmail.com',
          role: 'vendedor',
          tenantName: 'Agencia Norte',
          expiresAt: iso(NOW + 5 * DAY + 60 * MIN),
        },
      ],
    },
    ...patch,
  };
}
