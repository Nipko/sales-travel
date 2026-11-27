import { expect, test } from '@playwright/test';
import { E2E } from '../support/env';
import { anonimo, como, nodo, olvidar, sql } from './support/cliente';
import { API_PASSWORD, PERSONAS } from './support/personas';

/**
 * Tercera tanda (docs/qa/01): módulos que la API expone y que no tenían ninguna prueba de borde.
 *
 * - CLI-09 / COT-05 / PAQ-04: lo de la agencia B no se ve ni se toca desde la A, ni se puede
 *   referenciar (un id de cliente ajeno en una oportunidad, tarea o paquete).
 * - CLI-07 / PAQ-04: entradas inválidas dan 400, no 500.
 * - AGE-06: subida de logo con contenido malo; BYO-07: el supervisado no carga credenciales.
 * - RED-10 / RED-13: reglas y ventas de red de otro nodo.
 * - TRV-14 / ACC-34 / NFR-05: headers, logout y tamaño del cuerpo.
 *
 * Lo que se crea queda en las agencias de prueba con títulos «QA …»; nada llega a un proveedor.
 */

const sufijo = () => Date.now().toString(36);

async function clienteDe(key: 'vendedorA' | 'vendedorB'): Promise<string> {
  const api = await como(key);
  const r = await api.post<{ customer?: { id: string } }>('/customers', {
    customerType: 'person',
    firstName: 'Qa',
    lastName: `Aislamiento ${key}`,
    documentType: 'CC',
    documentNumber: `QA${sufijo()}`,
    documentIssuingCountry: 'CO',
    birthdate: '1990-01-01',
    gender: 'M',
    nationality: 'CO',
  });
  const id = r.body?.customer?.id;
  if (!id) throw new Error(`no pude crear el cliente de ${key}: ${r.status} ${r.text}`);
  return id;
}

const criterios = {
  departureDate: '2027-03-10',
  returnDate: '2027-03-15',
  rooms: [{ adults: 2, childrenAges: [] }],
};

test('CLI-09 el CRM no ve ni referencia clientes de otra agencia', async () => {
  const a = await como('vendedorA');
  const b = await como('vendedorB');
  const clienteB = await clienteDe('vendedorB');
  const malas: string[] = [];

  const opB = await b.post<{ opportunity?: { id: string } }>('/crm/opportunities', {
    customerId: clienteB,
    title: 'QA oportunidad de B',
  });
  const opBId = opB.body?.opportunity?.id;
  if (!opBId) throw new Error(`B no pudo crear su oportunidad: ${opB.status} ${opB.text}`);

  const verOp = await a.get(`/crm/opportunities/${opBId}`);
  if (verOp.status !== 404) malas.push(`A lee la oportunidad de B → ${verOp.status}`);
  const editarOp = await a.patch(`/crm/opportunities/${opBId}`, { title: 'QA tocada por A' });
  if (editarOp.status !== 404) malas.push(`A edita la oportunidad de B → ${editarOp.status}`);
  const interB = await a.get(`/crm/interactions/customer/${clienteB}`);
  if (interB.status === 200 && JSON.stringify(interB.body).includes(clienteB))
    malas.push('A lista interacciones del cliente de B');

  // Referenciar lo ajeno: la FK no mira el tenant, así que el servidor tiene que hacerlo.
  const opConClienteB = await a.post<{ opportunity?: { id: string } }>('/crm/opportunities', {
    customerId: clienteB,
    title: 'QA A con cliente de B',
  });
  if (opConClienteB.status !== 400)
    malas.push(`A crea una oportunidad con el cliente de B → ${opConClienteB.status}`);

  const interConClienteB = await a.post('/crm/interactions', {
    customerId: clienteB,
    channel: 'INTERNAL_NOTE',
    direction: 'INTERNAL',
    summary: 'QA nota de A sobre cliente de B',
  });
  if (interConClienteB.status !== 400)
    malas.push(`A agrega una interacción al cliente de B → ${interConClienteB.status}`);

  const tareaConOpB = await a.post('/crm/tasks', {
    opportunityId: opBId,
    title: 'QA tarea de A sobre oportunidad de B',
    dueAt: '2027-01-01T10:00:00Z',
  });
  if (tareaConOpB.status !== 400)
    malas.push(`A crea una tarea sobre la oportunidad de B → ${tareaConOpB.status}`);

  const vendedorB = await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    PERSONAS.vendedorB.email,
  ]);
  const tareaParaB = await a.post('/crm/tasks', {
    assignedUserId: vendedorB[0]?.id,
    title: 'QA tarea de A asignada a un vendedor de B',
    dueAt: '2027-01-01T10:00:00Z',
  });
  if (tareaParaB.status !== 400)
    malas.push(`A asigna una tarea a un vendedor de B → ${tareaParaB.status}`);

  // Limpieza de lo que haya quedado cruzado (con el usuario admin del E2E).
  await sql(
    `DELETE FROM crm_tasks WHERE title LIKE 'QA tarea de A%';
     DELETE FROM crm_interactions WHERE summary = 'QA nota de A sobre cliente de B';
     DELETE FROM crm_opportunities WHERE title IN ('QA A con cliente de B', 'QA tocada por A')`,
  ).catch(() => undefined);

  expect(malas, malas.join(' | ')).toEqual([]);
});

test('CLI-07 entradas inválidas del CRM dan 400, no 500', async () => {
  const a = await como('vendedorA');
  const malas: string[] = [];
  const casos: [string, () => Promise<{ status: number; text: string }>][] = [
    ['etapa inexistente en el filtro', () => a.get('/crm/opportunities?stage=NO_EXISTE')],
    ['límite no numérico', () => a.get('/crm/tasks?limit=muchas')],
    [
      'vencimiento que no es fecha',
      () => a.post('/crm/tasks', { title: 'QA fecha mala', dueAt: 'mañana temprano' }),
    ],
    [
      'oportunidad con fecha de viaje inválida',
      async () =>
        a.post('/crm/opportunities', {
          customerId: await clienteDe('vendedorA'),
          title: 'QA fecha de viaje mala',
          travelStartDate: 'pronto',
        }),
    ],
  ];
  for (const [nombre, pedir] of casos) {
    const r = await pedir();
    if (r.status >= 500) malas.push(`${nombre} → ${r.status} ${r.text.slice(0, 80)}`);
  }
  await sql(
    `DELETE FROM crm_tasks WHERE title = 'QA fecha mala';
     DELETE FROM crm_opportunities WHERE title = 'QA fecha de viaje mala'`,
  ).catch(() => undefined);
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('COT-05 las cotizaciones de otra agencia no se leen ni se tocan', async () => {
  const a = await como('vendedorA');
  const b = await como('vendedorB');
  const qB = await b.post<{ quotation?: { id: string } }>('/quotations', {
    searchCriteria: { qa: true },
    selectedOffer: { qa: true },
    customerName: 'QA cotización de B',
    expiresAt: '2027-01-01T00:00:00Z',
  });
  const id = qB.body?.quotation?.id;
  if (!id) throw new Error(`B no pudo crear su cotización: ${qB.status} ${qB.text}`);

  const malas: string[] = [];
  const ver = await a.get(`/quotations/${id}`);
  if (ver.status !== 404) malas.push(`GET → ${ver.status}`);
  const estado = await a.patch(`/quotations/${id}/status`, { status: 'cancelled' });
  if (estado.status !== 404) malas.push(`PATCH status → ${estado.status}`);
  const cliente = await a.patch(`/quotations/${id}/customer`, { customerName: 'QA tocada por A' });
  if (cliente.status !== 404) malas.push(`PATCH customer → ${cliente.status}`);
  const lista = await a.get('/quotations');
  if (lista.text.includes(id)) malas.push('aparece en la lista de A');

  const [fila] = await sql<{ status: string; customer_name: string }>(
    'SELECT status, customer_name FROM quotations WHERE id = $1',
    [id],
  );
  if (fila?.status !== 'draft' || fila.customer_name !== 'QA cotización de B')
    malas.push(`la cotización de B cambió: ${JSON.stringify(fila)}`);
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('PAQ-04 paquetes: validación, aislamiento y referencias ajenas', async () => {
  const a = await como('vendedorA');
  const b = await como('vendedorB');
  const malas: string[] = [];

  const pB = await b.post<{ package?: { id: string } }>('/packages', {
    title: 'QA paquete de B',
    currency: 'COP',
    searchCriteria: criterios,
    items: [
      {
        vertical: 'other',
        providerName: 'manual',
        providerItemId: 'qa-traslado',
        baseFareMinor: 100_000,
        taxesMinor: 0,
      },
    ],
  });
  const idB = pB.body?.package?.id;
  if (!idB) throw new Error(`B no pudo crear su paquete: ${pB.status} ${pB.text}`);
  const detalle = await b.get<{ items?: { id: string }[] }>(`/packages/${idB}`);
  const itemB = detalle.body?.items?.[0]?.id;

  const ver = await a.get(`/packages/${idB}`);
  if (ver.status !== 404) malas.push(`A lee el paquete de B → ${ver.status}`);
  const editar = await a.patch(`/packages/${idB}`, { title: 'QA tocado por A' });
  if (editar.status !== 404) malas.push(`A edita el paquete de B → ${editar.status}`);
  const agregar = await a.post(`/packages/${idB}/items`, {
    vertical: 'other',
    providerName: 'manual',
    providerItemId: 'qa-intruso',
    baseFareMinor: 1,
    taxesMinor: 0,
  });
  if (agregar.status !== 404) malas.push(`A agrega un ítem al paquete de B → ${agregar.status}`);
  if (itemB) {
    const quitar = await a.delete(`/packages/${idB}/items/${itemB}`);
    if (quitar.status !== 404) malas.push(`A quita un ítem del paquete de B → ${quitar.status}`);
  }

  const clienteB = await clienteDe('vendedorB');
  const conClienteB = await a.post('/packages', {
    title: 'QA A con cliente de B',
    currency: 'COP',
    customerId: clienteB,
  });
  if (conClienteB.status !== 400)
    malas.push(`A crea un paquete con el cliente de B → ${conClienteB.status}`);

  const item = {
    vertical: 'other',
    providerName: 'manual',
    providerItemId: 'qa',
    baseFareMinor: 1,
    taxesMinor: 0,
  };
  const invalidos: [string, Record<string, unknown>][] = [
    ['vencimiento que no es fecha', { title: 'QA', currency: 'COP', expiresAt: 'nunca' }],
    [
      'regreso antes de la ida',
      {
        title: 'QA',
        currency: 'COP',
        searchCriteria: { ...criterios, departureDate: '2027-03-15', returnDate: '2027-03-10' },
      },
    ],
    [
      'fecha imposible',
      {
        title: 'QA',
        currency: 'COP',
        searchCriteria: { ...criterios, departureDate: '2027-02-31' },
      },
    ],
    ['13 ítems', { title: 'QA', currency: 'COP', items: Array.from({ length: 13 }, () => item) }],
    ['moneda que no es ISO', { title: 'QA', currency: 'pesos' }],
  ];
  for (const [nombre, body] of invalidos) {
    const r = await a.post('/packages', { ...body, title: `QA inválido: ${nombre}` });
    if (r.status !== 400) malas.push(`${nombre} → ${r.status} ${r.text.slice(0, 80)}`);
  }

  // Minúsculas: se acepta y se guarda normalizada.
  const minus = await a.post<{ package?: { currency: string } }>('/packages', {
    title: 'QA inválido: moneda en minúsculas',
    currency: 'cop',
  });
  if (minus.body?.package?.currency !== 'COP')
    malas.push(`moneda en minúsculas → ${minus.status} ${minus.text.slice(0, 80)}`);

  await sql(
    `DELETE FROM package_quotations WHERE title LIKE 'QA inválido:%' OR title = 'QA A con cliente de B'`,
  ).catch(() => undefined);
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('AGE-06 el logo sólo acepta imágenes reales, sin scripts, y de la propia red', async () => {
  const admin = await como('adminA');
  const adminB = await como('adminB');
  const idA = await nodo('e2e-agencia-a');
  const [antes] = await sql<{ logo_url: string | null }>(
    'SELECT logo_url FROM tenants WHERE id = $1',
    [idA],
  );
  const subir = (api: typeof admin, contenido: Buffer) =>
    api.post(`/tenants/${idA}/brand-assets`, {
      kind: 'logo',
      dataBase64: contenido.toString('base64'),
    });
  const relleno = `<!--${'x'.repeat(600)}-->`;
  const casos: [string, Buffer, number[]][] = [
    ['texto con extensión de imagen', Buffer.from('hola, no soy un png'), [400]],
    [
      'SVG con script después de los primeros 512 bytes',
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg">${relleno}<script>alert(1)</script></svg>`,
      ),
      [400],
    ],
    [
      'SVG con onclick',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)"/></svg>'),
      [400],
    ],
    [
      'SVG con foreignObject',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
      ),
      [400],
    ],
    [
      'SVG con href javascript tardío',
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${relleno}<a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
      ),
      [400],
    ],
    // 300 KB (dentro del máximo de 512 KB) con firma inválida: el servidor tiene que poder leerlo
    // para decir «formato no admitido»; un 413 quiere decir que el cuerpo se corta antes.
    ['300 KB que no son imagen', Buffer.alloc(300 * 1024, 0x41), [400]],
    ['más de 512 KB', Buffer.alloc(600 * 1024, 0x41), [400, 413]],
  ];
  const malas: string[] = [];
  try {
    for (const [nombre, contenido, esperados] of casos) {
      const r = await subir(admin, contenido);
      if (!esperados.includes(r.status))
        malas.push(`${nombre} → ${r.status} ${r.text.slice(0, 80)}`);
      else if (r.status === 413 && nombre.startsWith('300')) malas.push(`${nombre} → 413`);
    }
    const ajeno = await subir(adminB, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    if (ajeno.status !== 403) malas.push(`admin de B sube el logo de A → ${ajeno.status}`);
  } finally {
    await sql('UPDATE tenants SET logo_url = $2 WHERE id = $1', [idA, antes?.logo_url ?? null]);
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('BYO-07 el superadmin supervisado no carga credenciales de proveedor', async () => {
  const api = await como('supervisado');
  const r = await api.post('/provider-accounts', {
    tenantId: await nodo('e2e-agencia-a'),
    providerCode: 'qa-proveedor',
    label: 'qa-byo07',
    credentials: { user: 'qa', password: 'no-es-real' },
    status: 'sandbox',
  });
  const creada = await sql("SELECT id FROM provider_accounts WHERE label = 'qa-byo07'");
  expect(creada, `quedó una cuenta cargada por el supervisado (${r.status})`).toEqual([]);
  expect(r.status, r.text).toBe(403);
  expect(r.text).toContain('SUPERVISED_CANNOT_MANAGE_CREDENTIALS');
});

test('RED-10 un admin no borra reglas de pricing de otro nodo', async () => {
  const adminA = await como('adminA');
  const adminB = await como('adminB');
  const idA = await nodo('e2e-agencia-a');
  const idB = await nodo('e2e-agencia-b');
  // `activities`: ninguna venta del E2E la usa, así que la regla no mueve precios de otras pruebas.
  const creada = await adminA.post<{ id?: string; rule?: { id: string } }>('/pricing/rules', {
    tenantId: idA,
    vertical: 'activities',
    ruleType: 'fixed',
    valueMinor: 1,
  });
  const regla = creada.body?.id ?? creada.body?.rule?.id;
  if (!regla) throw new Error(`no pude crear la regla: ${creada.status} ${creada.text}`);
  const malas: string[] = [];
  try {
    for (const tenantId of [idA, idB]) {
      const r = await adminB.delete(`/pricing/rules/${regla}?tenantId=${tenantId}`);
      if (r.status < 400) malas.push(`admin de B borra con tenantId=${tenantId} → ${r.status}`);
    }
    const sigue = await sql('SELECT id FROM markup_rules WHERE id = $1', [regla]);
    if (sigue.length !== 1) malas.push('la regla de A desapareció');
  } finally {
    await adminA.delete(`/pricing/rules/${regla}?tenantId=${idA}`);
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('RED-13 ventas de la red: sin tenantId 403, UUID malo 400, nodo ajeno 403', async () => {
  const admin = await como('adminA');
  const malas: string[] = [];
  const sin = await admin.get('/tenants/network/sales');
  if (sin.status !== 403) malas.push(`sin tenantId → ${sin.status}`);
  const malo = await admin.get('/tenants/network/sales?tenantId=no-es-uuid');
  if (malo.status !== 400) malas.push(`UUID malo → ${malo.status} ${malo.text.slice(0, 80)}`);
  const ajeno = await admin.get(`/tenants/network/sales?tenantId=${await nodo('e2e-agencia-b')}`);
  if (ajeno.status !== 403) malas.push(`nodo de otra red → ${ajeno.status}`);
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('TRV-14 headers de seguridad en la API y el panel (QA-H-02)', async () => {
  const api = await como('vendedorA');
  const me = await api.get('/me');
  const anon = await anonimo();
  const login = await anon.pedir('GET', `${E2E.webUrl}/login`);
  const malas: string[] = [];
  for (const [donde, h] of [
    ['API /me', me.headers],
    ['panel /login', login.headers],
  ] as const) {
    if ((h['x-frame-options'] ?? '').toUpperCase() !== 'DENY')
      malas.push(`${donde}: X-Frame-Options ${h['x-frame-options'] ?? 'ausente'}`);
    if (!/strict-origin/.test(h['referrer-policy'] ?? ''))
      malas.push(`${donde}: Referrer-Policy ${h['referrer-policy'] ?? 'ausente'}`);
    if (!/frame-ancestors 'none'/.test(h['content-security-policy'] ?? ''))
      malas.push(`${donde}: CSP sin frame-ancestors 'none'`);
  }
  // HSTS del panel lo pone el borde (Caddy, `security_headers`); la Mac entra sin Caddy. La API lo
  // manda ella misma para no depender de por dónde llegue.
  if (!/max-age=\d{8,}/.test(me.headers['strict-transport-security'] ?? ''))
    malas.push(`API /me: HSTS ${me.headers['strict-transport-security'] ?? 'ausente'}`);
  if (!/no-store/.test(me.headers['cache-control'] ?? ''))
    malas.push(`API /me: Cache-Control ${me.headers['cache-control'] ?? 'ausente'}`);
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('ACC-34 logout cierra la sesión en la base: el token viejo da 401', async () => {
  const anon = await anonimo();
  const login = await anon.post<{ token?: string }>('/auth/login', {
    email: PERSONAS.vendedorB.email,
    password: API_PASSWORD,
  });
  const token = login.body?.token;
  if (!token) throw new Error(`login: ${login.status} ${login.text}`);
  const auth = { authorization: `Bearer ${token}` };
  expect((await anon.get('/me', auth)).status).toBe(200);
  const salir = await anon.pedir('POST', '/auth/logout', { body: {}, headers: auth });
  expect(salir.status, salir.text).toBe(200);
  const despues = await anon.get('/me', auth);
  expect(despues.status, despues.text).toBe(401);
  // Este ingreso reemplazó la sesión que el arnés guarda de vendedorB.
  olvidar('vendedorB');
});

test('NFR-05 un cuerpo de 5 MB se rechaza con 413 y la API sigue respondiendo', async () => {
  const anon = await anonimo();
  const grande = JSON.stringify({ email: 'qa@e2e.test', password: 'x'.repeat(5 * 1024 * 1024) });
  const r = await anon.pedir('POST', '/auth/login', { raw: grande });
  expect(r.status, r.text.slice(0, 120)).toBe(413);
  expect((await anon.get('/health')).status).toBeLessThan(500);
  const roto = await anon.pedir('POST', '/auth/login', { raw: '{"email": "qa@e2e.test",' });
  expect(roto.status, `JSON roto → ${roto.status} ${roto.text.slice(0, 80)}`).toBe(400);
});
