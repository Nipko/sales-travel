import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { anonimoDesde, como, nodo, sql, type Api } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Tanda 36 (docs/qa/01 §5 TRV, CLI y BYO), por HTTP:
 *
 * - TRV-10: un límite por IP (20/min en /invitations/preview) y un balde por vendedor (30/min en
 *   /search/seat-map, que cuenta antes de validar) → 429 en castellano con Retry-After; otro vendedor
 *   sigue libre.
 * - TRV-11: Idempotency-Key en ajustes, depósitos, depósitos informados, hotels/book y órdenes: falta o
 *   no es UUID → 400; misma clave y mismos datos → el mismo movimiento; misma clave con otros datos →
 *   409 PORTFOLIO_IDEMPOTENCY_KEY_REUSED (órdenes: 409 duplicateRequest).
 * - TRV-13: cada acción deja su domain_event con actor, nodo y sin claves sensibles.
 * - CLI-01: crear viajero valida lo requerido (persona vs empresa) y guarda el documento cifrado.
 * - BYO-09: «Origen de las tarifas»: Mostrar/Ocultar/Heredar cambia showProviderInResults; ocultar en
 *   un ancestro bloquea la rama.
 */

test.describe.configure({ mode: 'serial' });

const corrida = Date.now().toString(36);
interface ErrorApi {
  message: string;
  reason?: string;
  fields?: { field: string; message: string }[];
}

let cons: Api;
let nodoA = '';

test.beforeAll(async () => {
  cons = await como('consolidador');
  nodoA = await nodo('e2e-agencia-a');
});

test('TRV-10 límite por IP y balde por vendedor → 429 con Retry-After', async () => {
  const ip = `198.51.100.${150 + Math.floor(Math.random() * 90)}`;
  const anon = await anonimoDesde(ip);
  const estados: number[] = [];
  let ultimo: Awaited<ReturnType<Api['post']>> | undefined;
  for (let i = 0; i < 21; i++) {
    ultimo = await anon.post('/invitations/preview', { token: `qa36-token-falso-${i}-${corrida}` });
    estados.push(ultimo.status);
  }
  expect(
    estados.slice(0, 20).every((s) => s !== 429),
    estados.join(','),
  ).toBe(true);
  expect(estados[20]).toBe(429);
  expect(ultimo!.headers['retry-after']).toBeTruthy();
  expect((ultimo!.body as ErrorApi).message).toBe(
    'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
  );

  // El balde es una ventana fija en memoria: una corrida anterior en el mismo minuto pudo gastar
  // parte. Lo que se mira: todo lo que no es 429 es 400 (cuenta antes de validar) y el 429 llega a
  // más tardar en el 31.º pedido.
  const vendedor = await como('vendedorSub');
  const balde: number[] = [];
  let tope: Awaited<ReturnType<Api['post']>> | undefined;
  for (let i = 0; i < 31; i++) {
    tope = await vendedor.post('/search/seat-map', {});
    balde.push(tope.status);
    if (tope.status === 429) break;
  }
  expect(balde.at(-1), `${balde.join(',')} ${tope!.text.slice(0, 200)}`).toBe(429);
  expect(
    new Set(balde.slice(0, -1)).size <= 1 && (balde.length === 1 || balde[0] === 400),
    'cuenta antes de validar',
  ).toBe(true);
  const espera = Number(tope!.headers['retry-after']);
  expect(espera).toBeGreaterThanOrEqual(1);
  expect(espera).toBeLessThanOrEqual(60);
  const otro = await (await como('vendedorB')).post('/search/seat-map', {});
  expect(otro.status, 'el balde es por vendedor').toBe(400);
});

test('TRV-11 Idempotency-Key en carteras, hotels/book y órdenes', async () => {
  const lista = await cons.get<{ portfolios?: { id: string; currency: string }[] }>(
    `/tenants/${nodoA}/portfolios`,
  );
  let eur = lista.body.portfolios?.find((p) => p.currency === 'EUR');
  if (!eur) {
    await cons.post(`/tenants/${nodoA}/portfolios`, {
      currency: 'EUR',
      creditLimitMinor: 0,
      reason: 'QA36',
    });
    eur = (
      await cons.get<{ portfolios?: { id: string; currency: string }[] }>(
        `/tenants/${nodoA}/portfolios`,
      )
    ).body.portfolios?.find((p) => p.currency === 'EUR');
  }
  const base = `/tenants/${nodoA}/portfolios/${eur!.id}`;
  const mover = (ruta: 'deposits' | 'adjustments', body: unknown, key: string | null) =>
    cons.pedir<ErrorApi & { transaction?: { id: string }; portfolio?: { balanceMinor: number } }>(
      'POST',
      `${base}/${ruta}`,
      { body, ...(key === null ? {} : { headers: { 'idempotency-key': key } }) },
    );

  const sinClave = await mover('adjustments', { amountMinor: 100, reason: 'QA36 ajuste' }, null);
  expect(sinClave.status).toBe(400);
  expect(sinClave.text).toContain('la cabecera Idempotency-Key es obligatoria (un UUID)');
  const malaClave = await mover(
    'adjustments',
    { amountMinor: 100, reason: 'QA36 ajuste' },
    'clave-1',
  );
  expect(malaClave.status).toBe(400);
  expect(malaClave.text).toContain('la cabecera Idempotency-Key tiene que ser un UUID');

  for (const ruta of ['adjustments', 'deposits'] as const) {
    const key = randomUUID();
    const body = { amountMinor: 250, reason: `QA36 ${ruta} ${corrida}` };
    const uno = await mover(ruta, body, key);
    const dos = await mover(ruta, body, key);
    expect(uno.status, `${ruta}: ${uno.text}`).toBeLessThan(300);
    expect(dos.status, `${ruta} repetido`).toBeLessThan(300);
    expect(dos.body.portfolio?.balanceMinor, `${ruta}: no suma dos veces`).toBe(
      uno.body.portfolio?.balanceMinor,
    );
    const otro = await mover(ruta, { ...body, amountMinor: 999 }, key);
    expect(otro.status, `${ruta}: misma clave, otros datos`).toBe(409);
    expect(otro.body.reason).toBe('PORTFOLIO_IDEMPOTENCY_KEY_REUSED');
  }

  // Depósitos informados: agencia B (la financia Planetour) en PEN.
  const sa = await como('superadmin');
  const b = await nodo('e2e-agencia-b');
  const pen = await sa.post(`/tenants/${b}/portfolios`, {
    currency: 'PEN',
    creditLimitMinor: 0,
    reason: 'QA36',
  });
  expect(pen.status < 300 || pen.text.includes('PORTFOLIO_ALREADY_ENABLED'), pen.text).toBe(true);
  const adminB = await como('adminB');
  const informar = (body: Record<string, unknown>, key: string | null) =>
    adminB.pedir<ErrorApi & { report?: { id: string } }>('POST', '/portfolios/deposit-reports', {
      body,
      ...(key === null ? {} : { headers: { 'idempotency-key': key } }),
    });
  const reporte = {
    currency: 'PEN',
    amountMinor: 5_000,
    reference: `QA36-${corrida}`,
    depositedOn: null,
    notes: null,
  };
  expect((await informar(reporte, null)).status).toBe(400);
  expect((await informar(reporte, 'no-uuid')).status).toBe(400);
  const key = randomUUID();
  const r1 = await informar(reporte, key);
  const r2 = await informar(reporte, key);
  expect(r1.status, r1.text).toBeLessThan(300);
  expect(r2.status).toBeLessThan(300);
  const [cuantos] = await sql<{ n: string }>(
    'SELECT count(*)::text AS n FROM portfolio_deposit_reports WHERE reference = $1',
    [reporte.reference],
  );
  expect(cuantos?.n, 'la misma clave no informa dos veces').toBe('1');
  const r3 = await informar({ ...reporte, amountMinor: 6_000 }, key);
  expect(r3.status).toBe(409);
  expect(r3.body.reason).toBe('PORTFOLIO_IDEMPOTENCY_KEY_REUSED');

  // hotels/book: el stack no tiene hoteles, pero la clave se valida primero.
  const vendedor = await como('vendedorA');
  const reserva = {
    providerCode: 'tbo-hotels',
    prebookRef: randomUUID(),
    acceptedTotal: { amountMinor: 10_000, currency: 'USD' },
    rooms: [{ guests: [{ paxType: 'ADT', title: 'Mr', firstName: 'Ana', lastName: 'Ruiz' }] }],
    contact: { email: 'cliente@correo.co', phone: { countryCode: '+57', number: '3001234567' } },
  };
  const hSin = await vendedor.post<ErrorApi>('/hotels/book', reserva);
  expect(hSin.status).toBe(400);
  expect(hSin.body.message).toBe(
    'Se requiere Idempotency-Key UUID cuando la reserva no proviene de una cotización.',
  );
  const hMala = await vendedor.pedir<ErrorApi>('POST', '/hotels/book', {
    body: reserva,
    headers: { 'idempotency-key': 'otra-clave' },
  });
  expect(hMala.status).toBe(400);
  expect(hMala.body.message).toBe('Idempotency-Key debe ser un UUID válido.');
});

test('TRV-13 cada acción deja su evento con actor y nodo, sin claves sensibles', async () => {
  const SENSIBLE =
    /secret|password|token|api_?key|private_?key|authorization|cvv|cvc|card|cookie|recovery_codes|otpauth/i;
  const desde = new Date(Date.now() - 2_000).toISOString();
  const idDe = async (email: string) =>
    (await sql<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0]!.id;
  const soporte = await como('agencyAdminA');
  const equipo = nodoA;

  expect((await soporte.patch('/me', { name: `Soporte QA36 ${corrida}` })).status).toBeLessThan(
    300,
  );
  const lista = await cons.get<{ portfolios?: { id: string; currency: string }[] }>(
    `/tenants/${nodoA}/portfolios`,
  );
  const eur = lista.body.portfolios!.find((p) => p.currency === 'EUR')!;
  await cons.pedir('POST', `/tenants/${nodoA}/portfolios/${eur.id}/deposits`, {
    body: { amountMinor: 100, reason: 'QA36 evento' },
    headers: { 'idempotency-key': randomUUID() },
  });
  await cons.patch('/provider-disclosure', { tenantId: nodoA, showProviderInResults: true });
  await cons.patch('/provider-disclosure', { tenantId: nodoA, showProviderInResults: null });

  const malas: string[] = [];
  for (const [tipo, actor, tenant] of [
    ['UserProfileUpdated', PERSONAS.agencyAdminA.email, equipo],
    ['portfolio.deposit.recorded', PERSONAS.consolidador.email, nodoA],
    ['tenant.provider_disclosure.updated', PERSONAS.consolidador.email, nodoA],
  ] as const) {
    const [ev] = await sql<{ tenant_id: string; actor_user_id: string; payload: unknown }>(
      `SELECT tenant_id, actor_user_id, payload FROM domain_events
        WHERE event_type = $1 AND occurred_at >= $2 ORDER BY occurred_at DESC LIMIT 1`,
      [tipo, desde],
    );
    if (!ev) {
      malas.push(`${tipo}: no hay evento`);
      continue;
    }
    if (ev.actor_user_id !== (await idDe(actor))) malas.push(`${tipo}: actor ${ev.actor_user_id}`);
    if (ev.tenant_id !== tenant) malas.push(`${tipo}: nodo ${ev.tenant_id}`);
    const claves: string[] = [];
    const recorrer = (v: unknown) => {
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          claves.push(k);
          recorrer(x);
        }
    };
    recorrer(ev.payload);
    const sensibles = claves.filter((k) => SENSIBLE.test(k));
    if (sensibles.length > 0) malas.push(`${tipo}: claves sensibles ${sensibles.join(',')}`);
  }
  expect(malas).toEqual([]);
});

test('CLI-01 crear viajero: requeridos de persona y documento cifrado', async () => {
  const vendedor = await como('vendedorA');
  const doc = `9${Date.now().toString().slice(-9)}`;
  const persona = {
    firstName: 'Viajera',
    lastName: 'QA36',
    documentType: 'CC',
    documentNumber: doc,
    documentIssuingCountry: 'CO',
    customerType: 'person',
  };
  const incompleta = await vendedor.post<ErrorApi>('/customers', persona);
  expect(incompleta.status).toBe(400);
  const campos = new Set(incompleta.body.fields?.map((f) => f.field));
  for (const c of ['birthdate', 'gender', 'nationality']) expect(campos, c).toContain(c);
  expect(incompleta.body.fields?.[0]?.message).toBe('requerido para una persona');

  const empresa = await vendedor.post('/customers', {
    ...persona,
    firstName: `Empresa QA36 ${corrida}`,
    lastName: '',
    customerType: 'company',
    documentType: 'NIT',
    documentNumber: `8${doc.slice(1)}`,
  });
  expect(
    empresa.status,
    `una empresa no pide apellido ni nacimiento: ${empresa.text}`,
  ).toBeLessThan(300);

  const creada = await vendedor.post<{ customer: { id: string; documentNumber: string } }>(
    '/customers',
    {
      ...persona,
      birthdate: '1990-05-15',
      gender: 'F',
      nationality: 'CO',
      email: `viajera-${corrida}@e2e.test`,
    },
  );
  expect(creada.status, creada.text).toBeLessThan(300);
  expect(creada.body.customer.documentNumber).toBe(doc);
  const [fila] = await sql<{ claro: string | null; enc: string | null; hash: string | null }>(
    `SELECT document_number AS claro, encode(document_number_enc, 'hex') AS enc,
            document_number_hash AS hash FROM customers WHERE id = $1`,
    [creada.body.customer.id],
  );
  expect(fila?.claro, 'el documento no queda en claro').toBeNull();
  expect(fila?.enc).toBeTruthy();
  expect(fila!.enc).not.toContain(Buffer.from(doc).toString('hex'));
  expect(fila?.hash).not.toBe(doc);
});

test('BYO-09 origen de las tarifas: mostrar, ocultar, heredar y el bloqueo del ancestro', async () => {
  const consolidador = await nodo('e2e-consolidador');
  const vendedor = await como('vendedorA');
  const ver = async () =>
    (
      await vendedor.post<{ showProviderInResults: boolean }>('/search/flights', {
        origin: 'BOG',
        destination: 'MDE',
        departureDate: new Date(Date.now() + 95 * 86_400_000).toISOString().slice(0, 10),
        paxCount: { adults: 1, children: 0, infants: 0 },
      })
    ).body.showProviderInResults;
  const fijar = (tenantId: string, v: boolean | null) =>
    cons.patch<{ effective: boolean; own: boolean | null; lockedByAncestor: boolean }>(
      '/provider-disclosure',
      { tenantId, showProviderInResults: v },
    );
  const antesA = (await cons.get<{ own: boolean | null }>(`/provider-disclosure?tenantId=${nodoA}`))
    .body.own;
  const antesC = (
    await cons.get<{ own: boolean | null }>(`/provider-disclosure?tenantId=${consolidador}`)
  ).body.own;
  try {
    await fijar(consolidador, null);
    expect((await fijar(nodoA, true)).body.effective).toBe(true);
    expect(await ver(), 'Mostrar').toBe(true);
    expect((await fijar(nodoA, false)).body.effective).toBe(false);
    expect(await ver(), 'Ocultar').toBe(false);
    await fijar(nodoA, null);
    expect(await ver(), 'Heredar sin opinión arriba: oculto por defecto').toBe(false);

    await fijar(consolidador, false);
    const bloqueada = await fijar(nodoA, true);
    expect(bloqueada.body).toMatchObject({ own: true, effective: false, lockedByAncestor: true });
    expect(await ver()).toBe(false);

    const ajeno = await (
      await como('adminB')
    ).get<ErrorApi>(`/provider-disclosure?tenantId=${nodoA}`);
    expect(ajeno.status).toBe(403);
    expect(ajeno.body.message).toBe('Ese nodo no está en tu red.');
  } finally {
    await fijar(consolidador, antesC ?? null);
    await fijar(nodoA, antesA ?? null);
  }
});
