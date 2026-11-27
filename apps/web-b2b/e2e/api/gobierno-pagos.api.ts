import { expect, test } from '@playwright/test';
import { como, nodo, sql, type Api } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Tanda 9 (docs/qa/01 §5 SUP): SUP-14, el gobierno de formas de pago de punta a punta. Lo que el
 * superadmin decide (regla a mano en un nodo, perfil asignado a otro) cambia la matriz efectiva y
 * lo que el vendedor puede usar en una reserva: las opciones de pago y la ruta que cobra.
 *
 * Sólo se prueba el lado que NIEGA: una forma apagada responde 403 antes de llamar al proveedor. El
 * lado que permite le pegaría a LATAM con una reserva inventada.
 *
 * Las reglas y el perfil de prueba se deshacen al final; las órdenes inventadas quedan canceladas.
 */

const PROV = 'latam-ndc';
const sufijo = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function conStepUp<T>(api: Api, pedir: () => Promise<T & { status: number; text: string }>) {
  const r = await pedir();
  if (r.status === 403 && r.text.includes('MFA_RECENT_REQUIRED')) {
    await api.stepUp();
    return pedir();
  }
  return r;
}

/** Una reserva LATAM confirmada y sin pagar, inventada en la base para el vendedor del nodo. */
async function ordenSinPagar(tenantId: string, email: string): Promise<string> {
  const [o] = await sql<{ id: string }>(
    `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer, passengers,
                         contact_info, total_amount, currency, order_number, status,
                         provider_order_id)
     SELECT $1, u.id, $2, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 100000, 'USD',
            (SELECT coalesce(max(order_number), 0) + 1 FROM orders WHERE tenant_id = $1),
            'confirmed', $3
       FROM users u WHERE u.email = $4
     RETURNING id`,
    [tenantId, PROV, `QA-SUP14-${sufijo()}`, email],
  );
  if (!o) throw new Error(`no se pudo crear la orden para ${email}`);
  return o.id;
}

type Celda = {
  provider: string;
  method: string;
  enabled: boolean;
  origin: { kind: string };
  originTenantName: string | null;
};

test('SUP-14 una regla en el nodo y un perfil en otro gobiernan lo que el vendedor puede cobrar', async () => {
  const sa = await como('superadmin');
  const vendA = await como('vendedorA');
  const vendSub = await como('vendedorSub');
  const vendB = await como('vendedorB');
  const [nodoA, nodoSub, nodoB] = [
    await nodo('e2e-agencia-a'),
    await nodo('e2e-subagencia'),
    await nodo('e2e-agencia-b'),
  ];
  const ordenA = await ordenSinPagar(nodoA, PERSONAS.vendedorA.email);
  const ordenSub = await ordenSinPagar(nodoSub, PERSONAS.vendedorSub.email);
  const ordenB = await ordenSinPagar(nodoB, PERSONAS.vendedorB.email);

  const opciones = async (api: Api, orden: string) => {
    const r = await api.get<{ methods: { code: string }[] }>(`/orders/${orden}/payment-options`);
    expect(r.status, r.text).toBe(200);
    return r.body.methods.map((m) => m.code).sort();
  };
  const matriz = async (tenantId: string) => {
    const r = await sa.get<{ profile: { name: string } | null; effective: Celda[] }>(
      `/admin/governance/tenants/${tenantId}`,
    );
    expect(r.status, r.text).toBe(200);
    return r.body;
  };
  const celda = (cells: Celda[], method: string) =>
    cells.find((c) => c.provider === PROV && c.method === method);
  const regla = (tenantId: string | null, method: string, enabled: boolean | null) =>
    conStepUp(sa, () =>
      sa.put('/admin/governance/rules', {
        tenantId,
        provider: PROV,
        method,
        enabled,
        ...(enabled === null ? {} : { reason: 'QA SUP-14' }),
      }),
    );

  // Lo de partida: lo que la plataforma deja usar a los tres nodos, igual.
  const antesA = await opciones(vendA, ordenA);
  const antesB = await opciones(vendB, ordenB);
  expect(await opciones(vendSub, ordenSub)).toEqual(antesA);
  const metodo = antesA[0];
  test.skip(
    metodo === undefined,
    'la plataforma no habilita ninguna forma de pago de LATAM para cobrar una orden',
  );
  const [perfilPrevioB] = await sql<{ profile_id: string }>(
    'SELECT profile_id FROM tenant_governance_profiles WHERE tenant_id = $1',
    [nodoB],
  );
  let perfil: string | undefined;

  try {
    // 1. Regla a mano en la agencia A: la apaga para A y su sub-agencia; B no se entera.
    const r = await regla(nodoA, metodo!, false);
    expect(r.status, r.text).toBeLessThan(300);

    expect(await opciones(vendA, ordenA)).not.toContain(metodo);
    expect(await opciones(vendSub, ordenSub)).not.toContain(metodo);
    expect(await opciones(vendB, ordenB)).toEqual(antesB);
    expect(celda((await matriz(nodoA)).effective, metodo!)).toMatchObject({ enabled: false });
    expect(celda((await matriz(nodoSub)).effective, metodo!)).toMatchObject({
      enabled: false,
      originTenantName: 'Agencia E2E A',
    });

    // 2. Un perfil asignado a B apaga lo mismo allí.
    const p = await conStepUp(sa, () =>
      sa.post<{ id: string }>('/admin/governance/profiles', {
        name: `QA SUP-14 ${sufijo()}`,
        items: [
          { provider: PROV, method: '', enabled: true },
          { provider: PROV, method: metodo, enabled: false },
        ],
      }),
    );
    expect(p.status, p.text).toBeLessThan(300);
    perfil = p.body.id;
    const asignar = await conStepUp(sa, () =>
      sa.put(`/admin/governance/tenants/${nodoB}/profile`, { profileId: perfil }),
    );
    expect(asignar.status, asignar.text).toBeLessThan(300);
    expect(await opciones(vendB, ordenB)).not.toContain(metodo);
    const mB = await matriz(nodoB);
    expect(mB.profile?.name).toMatch(/^QA SUP-14/);
    expect(celda(mB.effective, metodo!)).toMatchObject({ enabled: false });

    // 3. Lo apagado no se cobra: 403 con el nombre de la forma de pago, antes del proveedor.
    const cobro =
      metodo === 'payment_link'
        ? await vendA.post(`/orders/${ordenA}/payment-link`, { email: 'pagador@example.test' })
        : await vendA.post(`/orders/${ordenA}/pay`, {
            payment: { type: { card: 'Credit Card', cash: 'Cash', gov: 'GOV' }[metodo!] },
          });
    expect(cobro.status, cobro.text).toBe(403);
    expect(cobro.text).toMatch(/no está habilitada para tu agencia/);
    // 4. Deshecho, todo vuelve a lo de partida.
    await regla(nodoA, metodo!, null);
    expect(await opciones(vendA, ordenA)).toEqual(antesA);
  } finally {
    await regla(nodoA, metodo!, null);
    await conStepUp(sa, () =>
      sa.put(`/admin/governance/tenants/${nodoB}/profile`, {
        profileId: perfilPrevioB?.profile_id ?? null,
      }),
    );
    if (perfil) {
      await conStepUp(sa, () => sa.post(`/admin/governance/profiles/${perfil}/archive`, {}));
    }
    await sql(`UPDATE orders SET status = 'cancelled' WHERE id = ANY($1::uuid[])`, [
      [ordenA, ordenSub, ordenB],
    ]);
  }
});
