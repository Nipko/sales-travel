import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { como, nodo, sql, type Api } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Tanda 37 (docs/qa/01 §5 TRV, CHK y POS), por HTTP:
 *
 * - TRV-04 (las condicionales): mandar el enlace de restablecer a un ADMIN pide el 2FA reciente (a un
 *   vendedor, no: EQU-09); quitar a un admin del nodo ya lo cubre EQU-08.
 * - TRV-05: un superadmin con membresía de vendedor en una agencia sigue sin poder vender.
 * - CHK-18: el proveedor ocupado (perilla OCUPADO del falso) → 429 «no se envió a la aerolínea», sin
 *   reserva, y el reintento con otra clave sale.
 * - POS-07: una cancelación que falló antes de llegar al proveedor se reintenta desde su operación y
 *   cancela; una sin verificar no se reenvía.
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.describe.configure({ mode: 'serial' });

interface ErrorApi {
  message: string;
  reason?: string;
  retryForbidden?: boolean;
}
const idDe = async (email: string) =>
  (await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0]!.id;

const salida = new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10);
const searchCriteria = {
  origin: 'BOG',
  destination: 'MDE',
  departureDate: salida,
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: 'COP',
};

async function reservar(
  api: Api,
  apellido: string,
): Promise<{ status: number; text: string; body: ErrorApi & { order?: { id: string } } }> {
  const b = await api.post<{ offers: { provider: { name: string; offerRef: string } }[] }>(
    '/search/flights',
    searchCriteria,
  );
  const offer = b.body.offers.find(
    (o) => o.provider.name === 'fake-flights' && o.provider.offerRef.startsWith('FAKE-FIJO'),
  );
  return api.pedir('POST', '/orders', {
    headers: { 'idempotency-key': randomUUID() },
    body: {
      offer,
      searchCriteria,
      passengers: [
        {
          paxId: 'ADT_1',
          paxType: 'ADT',
          givenName: 'Tanda',
          surname: apellido,
          birthdate: '1990-05-15',
          gender: 'F',
          citizenshipCountryCode: 'CO',
          identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
        },
      ],
      contactInfo: { email: `qa37-${apellido.toLowerCase()}@e2e.test`, phone: '3001234567' },
    },
  });
}

test('TRV-04 enlace de restablecer a un admin pide el 2FA reciente', async () => {
  const jefe = await como('agencyAdminA');
  const equipo = await nodo('e2e-agencia-a');
  const admin = await idDe(PERSONAS.adminA.email);
  await sql('DELETE FROM password_reset_tokens WHERE user_id = $1', [admin]);
  await sql(
    `UPDATE sessions SET mfa_verified_at = now() - interval '2 hours'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [await idDe(PERSONAS.agencyAdminA.email)],
  );
  const ruta = `/tenants/${equipo}/members/${admin}/send-password-reset`;
  const viejo = await jefe.post<ErrorApi>(ruta, {});
  expect(viejo.status, viejo.text).toBe(403);
  expect(viejo.body.reason).toBe('MFA_RECENT_REQUIRED');
  await jefe.stepUp();
  const ok = await jefe.post(ruta, {});
  expect(ok.status, ok.text).toBe(200);
});

test('TRV-05 un superadmin con membresía de vendedor sigue sin vender', async () => {
  const nodoA = await nodo('e2e-agencia-a');
  const sa = await como('superadmin');
  const yo = await idDe(PERSONAS.superadmin.email);
  await sql(
    `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'vendedor')
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'vendedor', status = 'active'`,
    [nodoA, yo],
  );
  try {
    for (const [metodo, ruta, body] of [
      ['POST', '/search/flights', searchCriteria],
      ['POST', '/orders', {}],
      ['POST', '/quotations', {}],
    ] as const) {
      const r = await sa.pedir<ErrorApi>(metodo, ruta, { body, headers: { 'x-tenant-id': nodoA } });
      expect(r.status, `${ruta}: ${r.text}`).toBe(403);
      expect(r.body.reason).toBe('PLATFORM_ROLE_CANNOT_SELL');
    }
  } finally {
    await sql('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [nodoA, yo]);
  }
});

test('CHK-18 proveedor ocupado → 429 reintentable, sin reserva', async () => {
  const vendedor = await como('vendedorA');
  const ocupado = await reservar(vendedor, 'OCUPADO');
  expect(ocupado.status, ocupado.text).toBe(429);
  expect(ocupado.body.message).toBe(
    'La reserva no se envió a la aerolínea: el proveedor está atendiendo otras consultas de tu red. La cotización sigue disponible; intenta nuevamente en unos segundos.',
  );
  expect(
    ocupado.body.retryForbidden ?? false,
    'reintentable: la marca sólo viaja cuando es true',
  ).toBe(false);
  const [fila] = await sql<{ status: string; pnr: string | null }>(
    `SELECT status, provider_booking_ref AS pnr FROM orders WHERE contact_info ->> 'email' = 'qa37-ocupado@e2e.test'
      ORDER BY created_at DESC LIMIT 1`,
  );
  expect(fila?.status, 'el intento queda fallido y sin PNR').toBe('failed');
  expect(fila?.pnr).toBeNull();
  const despues = await reservar(vendedor, 'Reintento');
  expect(despues.status, despues.text).toBeLessThan(300);
});

test('POS-07 reintentar la cancelación que no llegó al proveedor; la sin verificar no', async () => {
  const vendedor = await como('vendedorA');
  const nodoA = await nodo('e2e-agencia-a');
  const nueva = async (resultado: Record<string, unknown>) => {
    const r = await reservar(vendedor, 'Cancelar');
    expect(r.status, r.text).toBeLessThan(300);
    const orderId = r.body.order!.id;
    const [op] = await sql<{ id: string }>(
      `INSERT INTO order_operations (tenant_id, order_id, type, status, attempts, last_error, result)
       VALUES ($1, $2, 'cancel', 'failed', 1, 'fake-flights no está respondiendo', $3::jsonb)
       RETURNING id`,
      [nodoA, orderId, JSON.stringify(resultado)],
    );
    return { orderId, opId: op!.id };
  };

  const fallida = await nueva({
    outcome: 'FAILED',
    retryable: true,
    reconciliationRequired: false,
    reason: 'pre-write-transient',
  });
  const ops = await vendedor.get<{ operations: { id: string; retryable: boolean }[] }>(
    `/orders/${fallida.orderId}/operations`,
  );
  expect(ops.body.operations.find((o) => o.id === fallida.opId)).toMatchObject({ retryable: true });
  const reintento = await vendedor.post(
    `/orders/${fallida.orderId}/operations/${fallida.opId}/retry`,
    {},
  );
  expect(reintento.status, reintento.text).toBeLessThan(300);
  await expect(async () => {
    const [o] = await sql<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      fallida.orderId,
    ]);
    expect(o?.status).toBe('cancelled');
  }).toPass({ timeout: 20_000 });

  const dudosa = await nueva({
    outcome: 'UNVERIFIED',
    retryable: false,
    reconciliationRequired: true,
    reason: 'write-unverified',
  });
  const prohibido = await vendedor.post<ErrorApi>(
    `/orders/${dudosa.orderId}/operations/${dudosa.opId}/retry`,
    {},
  );
  expect(prohibido.status).toBe(409);
  expect(prohibido.body.message).toBe(
    'La cancelación quedó sin verificar. Hay que conciliarla con el proveedor; está prohibido reenviar el write.',
  );
});
