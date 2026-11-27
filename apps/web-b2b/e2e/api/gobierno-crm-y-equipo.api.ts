import { expect, test } from '@playwright/test';
import { como, nodo, sql, type Api } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Cuarta tanda (docs/qa/01):
 * - SUP-13: perfiles de gobierno (crear, editar, duplicar, predeterminado, archivar), sin ningún test
 *   hasta ahora.
 * - CLI-04 / CLI-05 / CLI-08: upsert de viajeros por documento, búsqueda y traspaso de cartera.
 * - EQU-03 / SQL-01: invitar o cambiar el rol por encima del propio o fuera de la red.
 *
 * Los perfiles de prueba se archivan al final; los viajeros quedan en las agencias de prueba con el
 * apellido «QA …».
 */

const sufijo = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function conStepUp<T>(api: Api, pedir: () => Promise<T & { status: number; text: string }>) {
  const r = await pedir();
  if (r.status === 403 && r.text.includes('MFA_RECENT_REQUIRED')) {
    await api.stepUp();
    return pedir();
  }
  return r;
}

async function userId(email: string): Promise<string> {
  const [u] = await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!u) throw new Error(`no existe ${email}`);
  return u.id;
}

test('SUP-13 perfiles de gobierno: validación, nombres únicos, predeterminado y archivo', async () => {
  const sa = await como('superadmin');
  const catalogo = await sa.get<{ code: string; paymentMethods: { code: string }[] }[]>(
    '/admin/governance/catalog',
  );
  expect(catalogo.status, catalogo.text).toBe(200);
  const prov = catalogo.body[0];
  if (!prov) throw new Error('catálogo de gobierno vacío');
  const item = { provider: prov.code, method: '', enabled: true };
  const nombre = `QA gobierno ${sufijo()}`;
  const crear = (body: unknown) =>
    conStepUp(sa, () => sa.post<{ id?: string }>('/admin/governance/profiles', body));

  const malas: string[] = [];
  const invalidos: [string, unknown, number][] = [
    ['nombre de 1 letra', { name: 'Q', items: [item] }, 400],
    ['nombre de 81', { name: 'Q'.repeat(81), items: [item] }, 400],
    [
      'proveedor que no existe',
      { name: `${nombre} x`, items: [{ ...item, provider: 'no-existe' }] },
      400,
    ],
    ['ítem repetido', { name: `${nombre} y`, items: [item, item] }, 400],
    ['201 ítems', { name: `${nombre} z`, items: Array.from({ length: 201 }, () => item) }, 400],
    ['campo extra', { name: `${nombre} w`, items: [item], hack: true }, 400],
  ];
  for (const [caso, body, esperado] of invalidos) {
    const r = await crear(body);
    if (r.status !== esperado) malas.push(`${caso} → ${r.status} ${r.text.slice(0, 80)}`);
  }

  const creados: string[] = [];
  try {
    const ok = await crear({ name: nombre, items: [item] });
    expect(ok.status, ok.text).toBeLessThan(300);
    const id = ok.body.id!;
    creados.push(id);

    const repetido = await crear({ name: nombre.toUpperCase(), items: [] });
    if (repetido.status !== 409)
      malas.push(`nombre repetido (otra capitalización) → ${repetido.status}`);

    const dup = await conStepUp(sa, () =>
      sa.post<{ id?: string; items?: unknown[] }>(`/admin/governance/profiles/${id}/duplicate`, {
        name: `${nombre} copia`,
      }),
    );
    if (dup.status >= 300) malas.push(`duplicar → ${dup.status} ${dup.text.slice(0, 80)}`);
    else {
      creados.push(dup.body.id!);
      if ((dup.body.items ?? []).length !== 1) malas.push('la copia no trae los ítems');
    }

    const nodoA = await nodo('e2e-agencia-a');
    const [previo] = await sql<{ profile_id: string }>(
      'SELECT profile_id FROM tenant_governance_profiles WHERE tenant_id = $1',
      [nodoA],
    );
    const asignar = (profileId: string | null) =>
      conStepUp(sa, () => sa.put(`/admin/governance/tenants/${nodoA}/profile`, { profileId }));
    const a = await asignar(id);
    if (a.status >= 300) malas.push(`asignar → ${a.status} ${a.text.slice(0, 80)}`);
    const archivarEnUso = await conStepUp(sa, () =>
      sa.post(`/admin/governance/profiles/${id}/archive`, {}),
    );
    if (archivarEnUso.status !== 409)
      malas.push(`archivar un perfil en uso → ${archivarEnUso.status}`);
    await asignar(previo?.profile_id ?? null);

    const def = await conStepUp(sa, () =>
      sa.put(`/admin/governance/profiles/${id}/default`, { isDefault: true }),
    );
    if (def.status >= 300) malas.push(`predeterminado → ${def.status}`);
    // Archivar el predeterminado está permitido: la base le quita la marca en el mismo UPDATE.
    // Lo que no puede pasar es que quede archivado Y predeterminado.
    const arch = await conStepUp(sa, () => sa.post(`/admin/governance/profiles/${id}/archive`, {}));
    if (arch.status >= 300) malas.push(`archivar → ${arch.status} ${arch.text.slice(0, 80)}`);
    else {
      const [p] = await sql<{ is_default_for_new_nodes: boolean }>(
        'SELECT is_default_for_new_nodes FROM governance_profiles WHERE id = $1',
        [id],
      );
      if (p?.is_default_for_new_nodes) malas.push('quedó archivado y predeterminado');
      creados.shift();
      const editar = await conStepUp(sa, () =>
        sa.put(`/admin/governance/profiles/${id}`, { name: `${nombre} editado` }),
      );
      if (editar.status !== 409) malas.push(`editar un perfil archivado → ${editar.status}`);
      const asignarArchivado = await asignar(id);
      if (asignarArchivado.status !== 409)
        malas.push(`asignar un perfil archivado → ${asignarArchivado.status}`);
    }
  } finally {
    for (const id of creados)
      await conStepUp(sa, () => sa.post(`/admin/governance/profiles/${id}/archive`, {}));
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});

const viajero = (doc: string, extra: Record<string, unknown> = {}) => ({
  customerType: 'person',
  firstName: 'Qa',
  lastName: 'Upsert',
  documentType: 'PASAPORTE',
  documentNumber: doc,
  documentIssuingCountry: 'CO',
  birthdate: '1990-05-05',
  gender: 'F',
  nationality: 'CO',
  ...extra,
});

test('CLI-04 el upsert por documento no duplica al viajero', async () => {
  const a = await como('vendedorA');
  const doc = `QA${sufijo()}`.toUpperCase();
  const r1 = await a.post<{ customer: { id: string }; created: boolean }>(
    '/customers/upsert',
    viajero(doc),
  );
  expect(r1.status, r1.text).toBeLessThan(300);
  const r2 = await a.post<{ customer: { id: string }; created: boolean }>(
    '/customers/upsert',
    viajero(` ${doc.toLowerCase()} `, { email: 'qa-upsert@e2e.test' }),
  );
  expect(r2.status, r2.text).toBeLessThan(300);
  // El documento va cifrado (0018): se cuenta por su blind index, en la agencia de A.
  const filas = await sql(
    `SELECT c.id FROM customers c, customers ref
      WHERE ref.id = $1 AND c.tenant_id = ref.tenant_id
        AND c.document_type = ref.document_type
        AND c.document_number_hash = ref.document_number_hash`,
    [r1.body.customer.id],
  );
  const malas: string[] = [];
  if (r1.body.created !== true) malas.push('el primero no dice created');
  if (r2.body.created !== false) malas.push('el segundo dice created');
  if (r2.body.customer.id !== r1.body.customer.id) malas.push('devolvió otro viajero');
  if (filas.length !== 1) malas.push(`quedaron ${filas.length} filas con el documento`);

  // Otra agencia con el mismo documento tiene SU viajero: el upsert no cruza agencias.
  const b = await como('vendedorB');
  const rb = await b.post<{ customer: { id: string } }>('/customers/upsert', viajero(doc));
  if (rb.body?.customer?.id === r1.body.customer.id)
    malas.push('la agencia B recibió el viajero de A');
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('CLI-05 búsqueda de viajeros: límites del q y del limit', async () => {
  const a = await como('vendedorA');
  const malas: string[] = [];
  const casos: [string, string, number][] = [
    ['q de 1 letra', '/customers/search?q=a', 400],
    ['q de 121', `/customers/search?q=${'a'.repeat(121)}`, 400],
    ['limit 0', '/customers/search?q=qa&limit=0', 400],
    ['limit 26', '/customers/search?q=qa&limit=26', 400],
    ['limit no numérico', '/customers/search?q=qa&limit=x', 400],
    ['válida', '/customers/search?q=qa&limit=25', 200],
  ];
  for (const [nombre, ruta, esperado] of casos) {
    const r = await a.get(ruta);
    if (r.status !== esperado) malas.push(`${nombre} → ${r.status} ${r.text.slice(0, 60)}`);
  }
  const b = await como('vendedorB');
  const deB = await b.get<{ customers: { lastName: string }[] }>('/customers/search?q=Upsert');
  const ajenos = await sql<{ id: string }>(
    `SELECT c.id FROM customers c JOIN tenants t ON t.id = c.tenant_id
      WHERE t.slug = 'e2e-agencia-a' AND c.last_name = 'Upsert'`,
  );
  const ids = JSON.stringify(deB.body);
  if (ajenos.some((x) => ids.includes(x.id))) malas.push('B encuentra viajeros de A');
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('CLI-08 el traspaso de cartera no saca oportunidades de la agencia', async () => {
  const admin = await como('adminA');
  const vendedorA = await userId(PERSONAS.vendedorA.email);
  const vendedorB = await userId(PERSONAS.vendedorB.email);
  const a = await como('vendedorA');
  const c = await a.post<{ customer: { id: string } }>('/customers', viajero(`QA${sufijo()}`));
  const op = await a.post<{ opportunity: { id: string } }>('/crm/opportunities', {
    customerId: c.body.customer.id,
    assignedUserId: vendedorA,
    title: 'QA cartera',
  });
  expect(op.status, op.text).toBeLessThan(300);

  const malas: string[] = [];
  const mismo = await admin.post('/crm/tasks/reassign', {
    fromUserId: vendedorA,
    toUserId: vendedorA,
  });
  if (mismo.status !== 400) malas.push(`origen = destino → ${mismo.status}`);
  const ajeno = await admin.post('/crm/tasks/reassign', {
    fromUserId: vendedorA,
    toUserId: vendedorB,
  });
  if (ajeno.status !== 400)
    malas.push(`a un vendedor de otra agencia → ${ajeno.status} ${ajeno.text.slice(0, 80)}`);
  const [fila] = await sql<{ assigned_user_id: string }>(
    'SELECT assigned_user_id FROM crm_opportunities WHERE id = $1',
    [op.body.opportunity.id],
  );
  if (fila?.assigned_user_id !== vendedorA) {
    malas.push('la oportunidad quedó asignada a un vendedor de otra agencia');
    await sql('UPDATE crm_opportunities SET assigned_user_id = $2 WHERE assigned_user_id = $1', [
      vendedorB,
      vendedorA,
    ]);
  }
  const vendedor = await a.post('/crm/tasks/reassign', {
    fromUserId: vendedorA,
    toUserId: vendedorA,
  });
  if (vendedor.status !== 403) malas.push(`un vendedor traspasa cartera → ${vendedor.status}`);
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('EQU-03 / SQL-01 nadie invita ni asciende por encima de su rol ni fuera de su red', async () => {
  const admin = await como('adminA');
  const nodoA = await nodo('e2e-agencia-a');
  const nodoB = await nodo('e2e-agencia-b');
  const vendedorA = await userId(PERSONAS.vendedorA.email);
  const [rolAntes] = await sql<{ role: string }>(
    'SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2',
    [vendedorA, nodoA],
  );
  const correo = () => `qa-invita-${sufijo()}@e2e.test`;
  const malas: string[] = [];
  const casos: [string, () => Promise<{ status: number; text: string }>, number[]][] = [
    [
      'invitar como superadmin',
      () => admin.post('/invitations', { email: correo(), tenantId: nodoA, role: 'superadmin' }),
      [400],
    ],
    [
      'invitar como consolidador',
      () =>
        admin.post('/invitations', {
          email: correo(),
          tenantId: nodoA,
          role: 'consolidator_admin',
        }),
      [403],
    ],
    [
      'invitar a otra agencia',
      () => admin.post('/invitations', { email: correo(), tenantId: nodoB, role: 'vendedor' }),
      [403],
    ],
    [
      'ascender a consolidador',
      () =>
        admin.patch('/admin/memberships/role', {
          userId: vendedorA,
          tenantId: nodoA,
          role: 'consolidator_admin',
        }),
      [403],
    ],
    [
      'ascender a superadmin',
      () =>
        admin.patch('/admin/memberships/role', {
          userId: vendedorA,
          tenantId: nodoA,
          role: 'superadmin',
        }),
      [400],
    ],
  ];
  try {
    for (const [nombre, pedir, esperados] of casos) {
      const r = await pedir();
      if (!esperados.includes(r.status))
        malas.push(`${nombre} → ${r.status} ${r.text.slice(0, 80)}`);
    }
    const vendedor = await como('vendedorA');
    const r = await vendedor.post('/invitations', {
      email: correo(),
      tenantId: nodoA,
      role: 'vendedor',
    });
    if (r.status !== 403) malas.push(`un vendedor invita → ${r.status}`);
  } finally {
    await sql('UPDATE memberships SET role = $3 WHERE user_id = $1 AND tenant_id = $2', [
      vendedorA,
      nodoA,
      rolAntes?.role ?? 'vendedor',
    ]);
    await sql("DELETE FROM user_invitations WHERE email LIKE 'qa-invita-%@e2e.test'").catch(
      () => undefined,
    );
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});

test('CLI-06 una oportunidad asignada la ven su vendedor y el admin; el vendedor no asigna a otros (QA-H-39)', async () => {
  const admin = await como('adminA');
  const vendedor = await como('vendedorA');
  const vendedorA = await userId(PERSONAS.vendedorA.email);
  const adminA = await userId(PERSONAS.adminA.email);
  const c = await vendedor.post<{ customer: { id: string } }>(
    '/customers',
    viajero(`QA${sufijo()}`),
  );
  const malas: string[] = [];

  const propia = await vendedor.post<{ opportunity: { id: string } }>('/crm/opportunities', {
    customerId: c.body.customer.id,
    assignedUserId: vendedorA,
    title: 'QA asignada a sí mismo',
  });
  if (propia.status !== 201) malas.push(`el vendedor se la asigna → ${propia.status}`);
  const delAdmin = await admin.post<{ opportunity: { id: string } }>('/crm/opportunities', {
    customerId: c.body.customer.id,
    assignedUserId: vendedorA,
    title: 'QA asignada por el admin',
  });
  if (delAdmin.status !== 201) malas.push(`el admin la asigna → ${delAdmin.status}`);

  const ids = [propia.body?.opportunity?.id, delAdmin.body?.opportunity?.id].filter(Boolean);
  const listaAdmin = (await admin.get('/crm/opportunities')).text;
  const listaVendedor = (await vendedor.get('/crm/opportunities')).text;
  for (const id of ids) {
    if (!listaAdmin.includes(id!)) malas.push(`el admin no ve ${id}`);
    if (!listaVendedor.includes(id!)) malas.push(`el vendedor no ve ${id}`);
    const una = await vendedor.patch(`/crm/opportunities/${id}`, { stage: 'QUALIFIED_LEAD' });
    if (una.status !== 200) malas.push(`el vendedor mueve de etapa ${id} → ${una.status}`);
  }

  const aOtro = await vendedor.post('/crm/opportunities', {
    customerId: c.body.customer.id,
    assignedUserId: adminA,
    title: 'QA vendedor asigna a otro',
  });
  if (aOtro.status !== 403) malas.push(`el vendedor asigna a otro → ${aOtro.status}`);
  expect(malas, malas.join(' | ')).toEqual([]);
});
