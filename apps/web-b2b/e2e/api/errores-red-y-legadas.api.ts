import { expect, request, test } from '@playwright/test';
import { E2E } from '../support/env';
import { como, nodo, sql, type Api } from './support/cliente';

/**
 * Tanda 31 (docs/qa/01 §5 TRV, RED, BYO y EQU), por HTTP:
 *
 * - TRV-09: Zod → 400 {statusCode, error, message, fields}; un JSON roto → 400 MALFORMED_BODY en
 *   castellano; ruta inexistente → 404. El 500 sin stack lo cubre all-exceptions.filter.test.ts.
 * - RED-06: el admin del consolidador ve su subárbol y nada de afuera (agencia B cuelga de la
 *   plataforma): usuarios, ventas, auditoría y carteras ajenas → 403 en castellano.
 * - BYO-04: la herencia de cuentas (AgentCars, en nodos nuevos): sin cuenta → 404 en castellano; la del
 *   padre heredable y activa; deshabilitada no cuenta; la propia activa gana; la propia en sandbox no.
 * - EQU-17: una cuenta «legada» (contraseña elegida por un admin antes del 2026-10-14) aparece en la
 *   lista; forzar el cambio pide step-up, valida 1–50 cuentas y una segunda vez se omite.
 */

test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
interface ErrorApi {
  statusCode?: number;
  error?: string;
  message: string;
  reason?: string;
  fields?: { field: string; message: string }[];
}

let cons: Api;

test.beforeAll(async () => {
  cons = await como('consolidador');
});

test('TRV-09 forma de los errores: Zod, JSON roto y ruta inexistente', async () => {
  const zod = await cons.post<ErrorApi>('/admin/tenants', { name: 'Q', slug: 'Mal Slug' });
  expect(zod.status).toBe(400);
  expect(zod.body).toMatchObject({ statusCode: 400 });
  expect(zod.body.error).toBeTruthy();
  expect(zod.body.message).toMatch(/^Revisa los datos ingresados — /);
  expect(zod.body.fields?.length).toBeGreaterThan(0);
  expect(zod.text).not.toMatch(/at .+\.(ts|js):\d+/);

  const ctx = await request.newContext({ baseURL: `${E2E.apiUrl}/api/` });
  try {
    const roto = await ctx.post('auth/forgot-password', {
      headers: { 'content-type': 'application/json' },
      data: '{"email": "a@b.co",',
    });
    expect(roto.status()).toBe(400);
    expect(await roto.json()).toMatchObject({
      statusCode: 400,
      reason: 'MALFORMED_BODY',
      message: 'No pudimos leer los datos enviados.',
    });

    const nada = await ctx.get(`qa31-no-existe-${corrida}`);
    expect(nada.status()).toBe(404);
    expect(((await nada.json()) as ErrorApi).statusCode).toBe(404);
  } finally {
    await ctx.dispose();
  }
});

test('RED-06 el consolidador sólo ve y gestiona su subárbol', async () => {
  const red = await cons.get<{ tenants: { slug: string }[] }>('/tenants/network');
  expect(red.status).toBe(200);
  const slugs = red.body.tenants.map((t) => t.slug);
  expect(slugs).toEqual(
    expect.arrayContaining(['e2e-consolidador', 'e2e-agencia-a', 'e2e-subagencia']),
  );
  for (const ajeno of ['e2e-agencia-b', 'e2e-agencia-suspendida', 'platform']) {
    expect(slugs, ajeno).not.toContain(ajeno);
  }

  const b = await nodo('e2e-agencia-b');
  const usuarios = await cons.get<ErrorApi>(`/tenants/network/users?tenantId=${b}`);
  expect(usuarios.status).toBe(403);
  expect(usuarios.body.message).toBe('No administras este nodo.');

  const ventas = await cons.get<ErrorApi>(`/tenants/network/sales?tenantId=${b}`);
  expect(ventas.status).toBe(403);
  expect(ventas.body.message).toBe('No puedes ver la red de ese nodo.');

  const sinNodo = await cons.get<ErrorApi>('/tenants/network/sales');
  expect(sinNodo.status).toBe(403);
  expect(sinNodo.body.message).toBe('Falta el nodo (tenantId).');

  const auditoria = await cons.get<ErrorApi>(`/tenants/network/audit?tenantId=${b}`);
  expect(auditoria.status).toBe(403);
  expect(auditoria.body.reason).toBe('TENANT_NOT_MANAGED');

  const carteras = await cons.get<ErrorApi>(`/tenants/${b}/portfolios`);
  expect(carteras.status).toBe(403);
  expect(carteras.body.reason).toBe('PORTFOLIO_FINANCIER_REQUIRED');

  const cuentas = await cons.get<ErrorApi>(`/provider-accounts?tenantId=${b}`);
  expect(cuentas.status).toBe(403);
  expect(cuentas.body.message).toBe('No administras este nodo.');
});

test('BYO-04 herencia de la cuenta de proveedor', async () => {
  const crear = async (nombre: string, parentTenantId: string) => {
    const r = await cons.post<{ tenant: { id: string } }>('/admin/tenants', {
      name: `QA31 ${nombre} ${corrida}`,
      slug: `qa31-${corrida}-${nombre}`,
      countryCode: 'CO',
      defaultCurrency: 'COP',
      parentTenantId,
    });
    expect(r.status, r.text).toBe(201);
    return r.body.tenant.id;
  };
  const padre = await crear('padre', await nodo('e2e-consolidador'));
  const hijo = await crear('hijo', padre);
  const cuenta = (tenantId: string, extra: Record<string, unknown>) =>
    cons.post('/provider-accounts', {
      tenantId,
      providerCode: 'agent-cars',
      label: 'default',
      credentials: { accessToken: `token-${corrida}` },
      config: {},
      ...extra,
    });
  const resolver = () =>
    cons.get<ErrorApi & { ownerTenantId?: string; inherited?: boolean }>(
      `/provider-accounts/resolve?tenantId=${hijo}&providerCode=agent-cars`,
    );

  const nada = await resolver();
  expect(nada.status, nada.text).toBe(404);
  expect(nada.body.message).toBe(
    'Ni este nodo ni los de arriba tienen una cuenta activa de agent-cars que se pueda usar.',
  );

  expect((await cuenta(padre, { status: 'active', isInheritable: true })).status).toBeLessThan(300);
  expect((await resolver()).body).toMatchObject({ ownerTenantId: padre, inherited: true });

  expect(
    (
      await cuenta(padre, {
        keepCredentials: true,
        credentials: undefined,
        status: 'disabled',
        isInheritable: true,
      })
    ).status,
  ).toBeLessThan(300);
  expect((await resolver()).status, 'una cuenta deshabilitada no se hereda').toBe(404);

  expect(
    (
      await cuenta(padre, {
        keepCredentials: true,
        credentials: undefined,
        status: 'active',
        isInheritable: true,
      })
    ).status,
  ).toBeLessThan(300);
  expect((await cuenta(hijo, { status: 'active', isInheritable: false })).status).toBeLessThan(300);
  expect((await resolver()).body, 'la propia activa gana').toMatchObject({
    ownerTenantId: hijo,
    inherited: false,
  });

  expect(
    (
      await cuenta(hijo, {
        keepCredentials: true,
        credentials: undefined,
        status: 'sandbox',
        isInheritable: false,
      })
    ).status,
  ).toBeLessThan(300);
  expect(
    (await resolver()).body,
    'la propia en sandbox no cuenta: vuelve a la del padre',
  ).toMatchObject({
    ownerTenantId: padre,
    inherited: true,
  });
});

test('EQU-17 contraseñas elegidas por un admin: lista, step-up, 1–50 y omitida la segunda vez', async () => {
  const email = `qa31-legada-${corrida}@e2e.test`;
  const [u] = await sql<{ id: string }>(
    `WITH u AS (
       INSERT INTO users (email, name, password_hash, email_verified_at, created_at, password_changed_at)
       VALUES ($1, 'Cuenta Legada QA31', crypt('Clave-Legada-2026!', gen_salt('bf', 4)), now(),
               '2026-09-01T12:00:00Z', NULL)
       RETURNING id, created_at)
     INSERT INTO memberships (tenant_id, user_id, role, invited_by, created_at)
     SELECT t.id, u.id, 'vendedor', a.id, u.created_at
       FROM u, tenants t, users a
      WHERE t.slug = 'e2e-agencia-b' AND a.email = 'api-admin-b@e2e.test'
     RETURNING user_id AS id`,
    [email],
  );
  expect(u?.id).toBeTruthy();

  const sa = await como('superadmin');
  const lista = await sa.get<{ users: { id: string; email: string }[] }>('/admin/legacy-passwords');
  expect(lista.status, lista.text).toBe(200);
  expect(lista.body.users.map((x) => x.email)).toContain(email);

  const forzar = (userIds: string[]) =>
    sa.post<ErrorApi & { results?: { userId: string; status: string; reason?: string }[] }>(
      '/admin/legacy-passwords/require-reset',
      { userIds },
    );
  const vacio = await forzar([]);
  const muchas = await forzar(Array.from({ length: 51 }, () => u!.id));
  await sa.stepUp();
  const vacio2 = vacio.status === 403 ? await forzar([]) : vacio;
  expect(vacio2.status).toBe(400);
  expect(vacio2.text).toContain('elige al menos una cuenta');
  const muchas2 =
    muchas.status === 403 ? await forzar(Array.from({ length: 51 }, () => u!.id)) : muchas;
  expect(muchas2.status).toBe(400);
  expect(muchas2.text).toContain('como mucho 50 cuentas por pedido');

  const una = await forzar([u!.id]);
  expect(una.status, una.text).toBe(200);
  expect(una.body.results?.[0]?.status).toMatch(/^(sent|email_failed)$/);
  const [fila] = await sql<{ pendiente: boolean }>(
    'SELECT password_reset_required_at IS NOT NULL AS pendiente FROM users WHERE id = $1',
    [u!.id],
  );
  expect(fila?.pendiente).toBe(true);

  const otra = await forzar([u!.id]);
  expect(otra.body.results?.[0]).toMatchObject({ status: 'skipped' });
});
