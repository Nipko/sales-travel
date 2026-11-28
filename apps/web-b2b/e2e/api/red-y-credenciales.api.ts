import { expect, test } from '@playwright/test';
import { como, nodo, sql, type Api } from './support/cliente';

/**
 * Tanda 26 (docs/qa/01 §5 RED y BYO), por HTTP con el consolidador y nodos nuevos en cada corrida:
 *
 * - RED-02: sólo los tipos válidos bajo cada padre (TENANT_PARENT_TYPE); consolidadores y sucursales
 *   sólo los crea el superadmin (TENANT_SUPERADMIN_ONLY).
 * - RED-03: slug repetido → 409 TENANT_SLUG_TAKEN; slug con mayúsculas o espacios y nombre fuera de
 *   2–120 → 400 en su campo, en castellano.
 * - BYO-02: las credenciales no vuelven nunca (ni en la lista ni en resolve) y se guardan cifradas.
 * - BYO-03: keepCredentials conserva el cifrado tal cual; con credenciales nuevas cambia; keep + credenciales
 *   → 400; keep en una cuenta nueva → 400. El evento ProviderCredentialsUpdated dice si cambiaron.
 * - RED-12: la auditoría de la red filtra por categoría, pagina con `before` y no muestra otra red.
 */

test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
interface ErrorApi {
  message: string;
  reason?: string;
  fields?: { field: string; message: string }[];
}

let api: Api;
let consolidador = '';
let agencia = '';

const crear = (body: Record<string, unknown>) =>
  api.post<ErrorApi & { tenant?: { id: string } }>('/admin/tenants', {
    countryCode: 'CO',
    defaultCurrency: 'COP',
    ...body,
  });

test.beforeAll(async () => {
  api = await como('consolidador');
  consolidador = await nodo('e2e-consolidador');
  const r = await crear({
    name: `QA26 Agencia ${corrida}`,
    slug: `qa26-${corrida}`,
    parentTenantId: consolidador,
    tenantType: 'agency',
  });
  expect(r.status, r.text).toBe(201);
  agencia = r.body.tenant!.id;
});

test('RED-02 tipos válidos bajo cada padre', async () => {
  const subBajoConsolidador = await crear({
    name: 'QA26 sub mal',
    slug: `qa26-${corrida}-x1`,
    parentTenantId: consolidador,
    tenantType: 'subagency',
  });
  expect(subBajoConsolidador.status).toBe(409);
  expect(subBajoConsolidador.body.reason).toBe('TENANT_PARENT_TYPE');

  const bajoSub = await crear({
    name: 'QA26 bajo sub',
    slug: `qa26-${corrida}-x2`,
    parentTenantId: await nodo('e2e-subagencia'),
  });
  expect(bajoSub.status, 'una sub-agencia no tiene hijos').toBe(409);
  expect(bajoSub.body.reason).toBe('TENANT_PARENT_TYPE');

  for (const extra of [{ tenantType: 'consolidator' }, { isBranch: true }]) {
    const r = await crear({
      name: 'QA26 sólo superadmin',
      slug: `qa26-${corrida}-x3`,
      parentTenantId: consolidador,
      ...extra,
    });
    expect(r.status, JSON.stringify(extra)).toBe(403);
    expect(r.body.reason).toBe('TENANT_SUPERADMIN_ONLY');
  }

  const sub = await crear({
    name: `QA26 Sub ${corrida}`,
    slug: `qa26-${corrida}-sub`,
    parentTenantId: agencia,
  });
  expect(sub.status, 'bajo una agencia cuelga una sub-agencia').toBe(201);
});

test('RED-03 slug repetido, slug mal escrito y nombre fuera de 2–120', async () => {
  const repetido = await crear({
    name: 'QA26 repetido',
    slug: 'e2e-agencia-a',
    parentTenantId: consolidador,
  });
  expect(repetido.status).toBe(409);
  expect(repetido.body.reason).toBe('TENANT_SLUG_TAKEN');
  expect(repetido.body.message).toBe('Ese slug ya lo usa otro nodo de la red.');

  for (const [caso, body, campo, mensaje] of [
    ['slug con mayúsculas', { slug: 'QA26-Mayus' }, 'slug', 'el slug va en minúsculas'],
    ['slug con espacios', { slug: 'qa26 con espacio' }, 'slug', 'el slug va en minúsculas'],
    ['nombre de 1', { name: 'Q' }, 'name', 'al menos 2 caracteres'],
    ['nombre de 121', { name: 'Q'.repeat(121) }, 'name', 'hasta 120 caracteres'],
    ['nombre sólo espacios', { name: '    ' }, 'name', 'al menos 2 caracteres'],
  ] as const) {
    const base: Record<string, unknown> = {
      name: 'QA26 válido',
      slug: `qa26-${corrida}-v`,
      parentTenantId: consolidador,
    };
    const r = await crear(Object.assign(base, body));
    expect(r.status, caso).toBe(400);
    const f = r.body.fields?.find((x) => x.field === campo);
    expect(f?.message, caso).toContain(mensaje);
  }
});

test('BYO-02 / BYO-03 credenciales cifradas, nunca devueltas; keepCredentials las conserva', async () => {
  const guardar = (body: Record<string, unknown>) =>
    api.post<ErrorApi>('/provider-accounts', {
      tenantId: agencia,
      providerCode: 'latam-ndc',
      label: 'qa26',
      config: {},
      isInheritable: false,
      ...body,
    });
  const cifrado = async () =>
    (
      await sql<{ hex: string }>(
        `SELECT encode(credentials_enc, 'hex') AS hex FROM provider_accounts
          WHERE tenant_id = $1 AND provider_code = 'latam-ndc' AND label = 'qa26'`,
        [agencia],
      )
    )[0]?.hex;
  const ultimoCambio = async () =>
    (
      await sql<{ changed: boolean }>(
        `SELECT (payload ->> 'credentialsChanged')::boolean AS changed FROM domain_events
          WHERE tenant_id = $1 AND event_type = 'ProviderCredentialsUpdated'
          ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [agencia],
      )
    )[0]?.changed;
  const SECRETO = `secreto-qa26-${corrida}`;

  const nueva = await guardar({ keepCredentials: true, status: 'sandbox' });
  expect(nueva.status, 'keep en una cuenta nueva').toBe(400);
  expect(nueva.text).toContain('No hay credenciales guardadas que conservar');

  const alta = await guardar({
    credentials: { apiKey: `key-${corrida}`, apiSecret: SECRETO },
    status: 'sandbox',
  });
  expect(alta.status, alta.text).toBeLessThan(300);
  const primero = await cifrado();
  expect(primero).toBeTruthy();
  expect(Buffer.from(primero!, 'hex').toString('latin1')).not.toContain(SECRETO);

  const lista = await api.get(`/provider-accounts?tenantId=${agencia}`);
  expect(lista.status).toBe(200);
  expect(lista.text).not.toContain(SECRETO);
  expect(lista.text).not.toContain('"credentials"');
  const resuelta = await api.get(
    `/provider-accounts/resolve?tenantId=${agencia}&providerCode=latam-ndc`,
  );
  expect(resuelta.text).not.toContain(SECRETO);
  expect(resuelta.text).not.toContain('"credentials"');

  const ambas = await guardar({
    keepCredentials: true,
    credentials: { apiKey: 'otra' },
    status: 'sandbox',
  });
  expect(ambas.status).toBe(400);
  expect(ambas.body.fields?.[0]?.message).toContain(
    'Con keepCredentials no se mandan credenciales',
  );

  const conservar = await guardar({ keepCredentials: true, status: 'disabled' });
  expect(conservar.status, conservar.text).toBeLessThan(300);
  expect(await cifrado(), 'keepCredentials no toca el cifrado').toBe(primero);
  expect(await ultimoCambio()).toBe(false);

  const cambiar = await guardar({
    credentials: { apiKey: `key2-${corrida}`, apiSecret: `${SECRETO}-2` },
    status: 'sandbox',
  });
  expect(cambiar.status, cambiar.text).toBeLessThan(300);
  expect(await cifrado()).not.toBe(primero);
  expect(await ultimoCambio()).toBe(true);
});

test('RED-12 auditoría de la red: categoría, páginas y otra red', async () => {
  const audit = (qs: string) =>
    api.get<
      ErrorApi & { events?: { id: string; eventType: string }[]; nextBefore?: string | null }
    >(`/tenants/network/audit?tenantId=${agencia}${qs}`);
  const credenciales = await audit('&category=credentials');
  expect(credenciales.status, credenciales.text).toBe(200);
  const tipos = new Set(credenciales.body.events?.map((e) => e.eventType));
  expect([...tipos]).toEqual(['ProviderCredentialsUpdated']);

  const red = await audit('&category=network');
  expect(red.body.events?.every((e) => /^(Tenant|tenant\.)/.test(e.eventType))).toBe(true);
  expect(red.body.events?.length, 'la sub-agencia creada').toBeGreaterThan(0);

  const mala = await audit('&category=ventas');
  expect(mala.status).toBe(400);
  expect(mala.text).toContain('categoría inválida');

  const p1 = await audit('&limit=1');
  expect(p1.body.events).toHaveLength(1);
  expect(p1.body.nextBefore).toBeTruthy();
  const p2 = await audit(`&limit=1&before=${encodeURIComponent(p1.body.nextBefore!)}`);
  expect(p2.body.events?.[0]?.id).not.toBe(p1.body.events?.[0]?.id);

  const ajena = await como('adminB');
  const otra = await ajena.get<ErrorApi>(`/tenants/network/audit?tenantId=${agencia}`);
  expect(otra.status, 'admin de otra red').toBe(403);
});
