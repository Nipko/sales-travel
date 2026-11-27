import { expect, test } from '@playwright/test';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { como, nodo, sql, type Api } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Tanda 19 (docs/qa/01 §5 RED, BYO y AGE), por HTTP y con nodos nuevos en cada corrida (no tocan los
 * del seed):
 *
 * - RED-05: el correo del admin inicial manda la invitación (llega a Mailpit); si el correo del nodo
 *   falla, el nodo igual se crea y la respuesta lo avisa (`invited_email_failed`); `adminPassword` → 400.
 * - BYO-10: el correo SMTP de un nodo lo heredan sus hijos mientras sea heredable; «Enviar correo de
 *   prueba» sale con el remitente efectivo y llega al admin que lo pidió.
 * - AGE-04: colores hex de 6 dígitos (otro formato → 400), logo sólo https:// y `logoUrl: null` lo quita.
 */

test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
const slug = (s: string) => `qa19-${corrida}-${s}`;

interface Creado {
  tenant: { id: string; slug: string; name: string };
  admin?: { email: string; status: string };
}
interface Prueba {
  sent: boolean;
  from?: string;
  reason?: string;
  to: string;
}
interface Resuelta {
  ownerTenantId: string;
  inherited: boolean;
}
interface ErrorApi {
  message: string;
  fields?: { field: string; message: string }[];
}

let api: Api;
let consolidador: string;

async function crear(
  nombre: string,
  extra: Record<string, unknown> & { parentTenantId: string },
): Promise<Creado> {
  const r = await api.post<Creado>('/admin/tenants', {
    name: `QA19 ${nombre} ${corrida}`,
    slug: slug(nombre),
    countryCode: 'CO',
    defaultCurrency: 'COP',
    ...extra,
  });
  expect(r.status, r.text).toBe(201);
  return r.body;
}

/** Cuenta de correo del nodo. `mailpit:1025` es el buzón del stack; otro host hace fallar el envío. */
async function correoDelNodo(
  tenantId: string,
  host: string,
  opts: { heredable: boolean; remitente: string },
): Promise<void> {
  const r = await api.post('/provider-accounts', {
    tenantId,
    providerCode: 'email',
    label: 'default',
    credentials: { user: opts.remitente, password: 'clave-de-prueba' },
    config: { host, port: 1025, secure: false, fromEmail: opts.remitente, fromName: 'QA19' },
    isInheritable: opts.heredable,
    status: 'active',
  });
  expect(r.status, r.text).toBeLessThan(300);
}

test.beforeAll(async () => {
  api = await como('consolidador');
  consolidador = await nodo('e2e-consolidador');
});

test.describe('RED-05 admin inicial del nodo', () => {
  test.beforeEach(async () => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
  });

  test('con correo: el nodo nace y el admin recibe la invitación', async () => {
    const email = `qa19-${corrida}-admin@e2e.test`;
    const desde = new Date(Date.now() - 1_000);
    const creado = await crear('invita', { parentTenantId: consolidador, adminEmail: email });
    expect(creado.admin).toMatchObject({ email, status: 'invited' });

    const correo = await ultimoCorreo(email, { desde, esperaMs: 15_000 });
    expect(correo, 'la invitación llega').toBeDefined();
    expect(correo!.asunto).toBe(`Te invitaron a ${creado.tenant.name}`);
    expect(correo!.enlaces.some((e) => /\/invitacion\?token=/.test(e))).toBe(true);
  });

  test('adminPassword → 400 con su motivo y sin nodo', async () => {
    const r = await api.post<ErrorApi>('/admin/tenants', {
      name: `QA19 clave ${corrida}`,
      slug: slug('clave'),
      countryCode: 'CO',
      defaultCurrency: 'COP',
      parentTenantId: consolidador,
      adminEmail: `qa19-${corrida}-clave@e2e.test`,
      adminPassword: 'Una-Clave-2026!',
    });
    expect(r.status, r.text).toBe(400);
    expect(r.body.fields?.map((f) => f.message).join(' ')).toContain('no se envía adminPassword');
    expect(await sql('SELECT 1 FROM tenants WHERE slug = $1', [slug('clave')])).toHaveLength(0);
  });

  test('si el correo falla, el nodo igual se crea y la respuesta lo avisa', async () => {
    test.setTimeout(90_000);
    const padre = await crear('roto', { parentTenantId: consolidador, tenantType: 'agency' });
    await correoDelNodo(padre.tenant.id, 'smtp.no-existe.invalid', {
      heredable: true,
      remitente: `roto-${corrida}@qa19.test`,
    });
    const email = `qa19-${corrida}-sin-correo@e2e.test`;
    const hijo = await crear('roto-hijo', {
      parentTenantId: padre.tenant.id,
      tenantType: 'subagency',
      adminEmail: email,
    });
    expect(hijo.admin).toMatchObject({ email, status: 'invited_email_failed' });
    const [fila] = await sql<{ parent_tenant_id: string }>(
      'SELECT parent_tenant_id FROM tenants WHERE slug = $1',
      [slug('roto-hijo')],
    );
    expect(fila?.parent_tenant_id).toBe(padre.tenant.id);
    const [inv] = await sql<{ n: string }>(
      'SELECT count(*)::text AS n FROM user_invitations WHERE lower(email) = $1',
      [email],
    );
    expect(inv?.n, 'la invitación queda guardada para reenviarla').toBe('1');
  });
});

test.describe('BYO-10 correo del nodo y su herencia', () => {
  test.beforeEach(async () => {
    test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
  });

  test('el hijo hereda el correo heredable, la prueba sale con ese remitente; sin herencia, el del sistema', async () => {
    const remitente = `ventas-${corrida}@qa19.test`;
    const padre = await crear('correo', { parentTenantId: consolidador, tenantType: 'agency' });
    const hijo = await crear('correo-hijo', {
      parentTenantId: padre.tenant.id,
      tenantType: 'subagency',
    });
    await correoDelNodo(padre.tenant.id, 'mailpit', { heredable: true, remitente });

    const resuelta = await api.get<Resuelta>(
      `/provider-accounts/resolve?tenantId=${hijo.tenant.id}&providerCode=email`,
    );
    expect(resuelta.status, resuelta.text).toBe(200);
    expect(resuelta.body).toMatchObject({ ownerTenantId: padre.tenant.id, inherited: true });

    const yo = PERSONAS.consolidador.email;
    const desde = new Date(Date.now() - 1_000);
    const prueba = await api.post<Prueba>('/mail/test', { tenantId: hijo.tenant.id });
    expect(prueba.status, prueba.text).toBeLessThan(300);
    expect(prueba.body).toMatchObject({ sent: true, to: yo });
    expect(prueba.body.from).toContain(remitente);
    const correo = await ultimoCorreo(yo, { desde, esperaMs: 15_000 });
    expect(correo?.asunto).toBe('Correo de prueba · PlaneTour');

    await correoDelNodo(padre.tenant.id, 'mailpit', { heredable: false, remitente });
    const propia = await api.get<Resuelta>(
      `/provider-accounts/resolve?tenantId=${hijo.tenant.id}&providerCode=email`,
    );
    expect(propia.body.ownerTenantId, 'ya no hereda la del padre').not.toBe(padre.tenant.id);
    const delSistema = await api.post<Prueba>('/mail/test', { tenantId: hijo.tenant.id });
    expect(delSistema.body.sent, delSistema.text).toBe(true);
    expect(delSistema.body.from).not.toContain(remitente);
  });
});

test.describe('AGE-04 marca del nodo', () => {
  test('colores de 6 dígitos, logo https y quitar el logo', async () => {
    const n = await crear('marca', { parentTenantId: consolidador, tenantType: 'agency' });
    const marca = (body: Record<string, unknown>) =>
      api.patch<
        ErrorApi & { primaryColor?: string; accentColor?: string; logoUrl?: string | null }
      >(`/tenants/${n.tenant.id}/branding`, body);

    for (const malo of ['#abc', '#12345g', '1d4ed8', '#1d4ed8ff']) {
      const r = await marca({ primaryColor: malo });
      expect(r.status, `primaryColor ${malo}`).toBe(400);
      expect(r.body.fields?.[0]?.message).toContain('hexadecimal de 6 dígitos');
    }
    const acento = await marca({ accentColor: 'rojo' });
    expect(acento.status).toBe(400);

    const http = await marca({ logoUrl: 'http://cdn.example.com/logo.png' });
    expect(http.status).toBe(400);
    expect(http.body.fields?.[0]?.message).toContain('https://');

    const bien = await marca({
      primaryColor: '#1D4ED8',
      accentColor: '#be123c',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
    expect(bien.status, bien.text).toBe(200);
    expect(bien.body.primaryColor?.toLowerCase()).toBe('#1d4ed8');
    expect(bien.body.accentColor).toBe('#be123c');
    expect(bien.body.logoUrl).toBe('https://cdn.example.com/logo.png');

    const sinLogo = await marca({ logoUrl: null });
    expect(sinLogo.status, sinLogo.text).toBe(200);
    expect(sinLogo.body.logoUrl ?? null).toBeNull();
    expect(sinLogo.body.primaryColor?.toLowerCase(), 'quitar el logo no toca los colores').toBe(
      '#1d4ed8',
    );
  });
});
