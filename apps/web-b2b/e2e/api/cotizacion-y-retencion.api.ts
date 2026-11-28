import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { hayBuzon, ultimoCorreo } from '../support/correo';
import { como, nodo, type Api } from './support/cliente';

/**
 * Tanda 30 (docs/qa/01 §5 COT, CAR y CHK), por HTTP con el proveedor falso:
 *
 * - COT-04: enviar la cotización sin email del cliente → 400; con email → llega a Mailpit con «[PRUEBA]».
 * - CAR-12 (mitad H): sólo quien financia el nodo bloquea las tarifas no reembolsables; el motivo pide 3
 *   caracteres; queda heredado y se vuelve a permitir.
 * - CAR-08 / CHK-17 (mitad H): POST /portfolios/hold-booking sobre una reserva del falso sólo retiene su
 *   total (otro monto → 400) y rechaza una cartera suspendida (PORTFOLIO_INACTIVE) sin retener nada.
 *   El falso nunca retiene al reservar (sólo Sabre liquida contra la cartera) y sus ofertas son en COP,
 *   así que «sin saldo» y «moneda sin cartera» por el checkout quedan para Sabre CERT.
 */

test.skip(process.env['E2E_REAL'] === '1', 'el proveedor falso sólo vive en el stack E2E');
test.describe.configure({ mode: 'serial' });

interface ErrorApi {
  message: string;
  reason?: string;
}
interface Oferta {
  provider: { name: string; offerRef: string };
}

let vendedor: Api;
const searchCriteria = {
  origin: 'BOG',
  destination: 'MDE',
  departureDate: new Date(Date.now() + 55 * 86_400_000).toISOString().slice(0, 10),
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: 'COP',
};

async function ofertaFija(): Promise<Oferta> {
  const r = await vendedor.post<{ offers: Oferta[] }>('/search/flights', searchCriteria);
  expect(r.status, r.text).toBeLessThan(300);
  const o = r.body.offers.find(
    (x) => x.provider.name === 'fake-flights' && x.provider.offerRef.startsWith('FAKE-FIJO'),
  );
  expect(o, 'el falso da su tarifa fija').toBeDefined();
  return o!;
}

test.beforeAll(async () => {
  vendedor = await como('vendedorA');
});

test('COT-04 enviar la cotización por correo', async () => {
  test.skip(!(await hayBuzon()), 'este stack no tiene Mailpit (INF-3)');
  const offer = await ofertaFija();
  const creada = await vendedor.post<{ quotation: { id: string; quoteNumber: number } }>(
    '/quotations',
    {
      searchCriteria,
      selectedOffer: offer,
      customerName: 'Cliente QA30',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  );
  expect(creada.status, creada.text).toBeLessThan(300);
  const { id, quoteNumber } = creada.body.quotation;

  const sinEmail = await vendedor.post<ErrorApi>(`/quotations/${id}/send-email`, {});
  expect(sinEmail.status).toBe(400);
  expect(sinEmail.body.message).toBe('La cotización no tiene email de cliente. Guárdalo primero.');

  const email = `qa30-${Date.now().toString(36)}@e2e.test`;
  const guardar = await vendedor.patch(`/quotations/${id}/customer`, { customerEmail: email });
  expect(guardar.status, guardar.text).toBeLessThan(300);
  const desde = new Date(Date.now() - 1_000);
  const envio = await vendedor.post<{ sent: boolean; to: string }>(
    `/quotations/${id}/send-email`,
    {},
  );
  expect(envio.status, envio.text).toBeLessThan(300);
  expect(envio.body).toMatchObject({ sent: true, to: email });
  const correo = await ultimoCorreo(email, { desde, esperaMs: 15_000 });
  expect(correo?.asunto).toMatch(
    new RegExp(`^\\[PRUEBA\\] Tu cotización de vuelo #${quoteNumber} · BOG → MDE$`),
  );
  expect(correo?.texto).toContain('Cotización de prueba');
});

test('CAR-12 bloquear las no reembolsables: sólo el financiador, con motivo, y vuelta a permitir', async () => {
  const cons = await como('consolidador');
  const nodoA = await nodo('e2e-agencia-a');
  const ruta = `/tenants/${nodoA}/booking-permissions`;
  try {
    const corto = await cons.put<ErrorApi>(ruta, { nonRefundableRates: 'blocked', reason: 'no' });
    expect(corto.status).toBe(400);

    const propia = await como('agencyAdminA');
    const noFinancia = await propia.put<ErrorApi>(ruta, {
      nonRefundableRates: 'blocked',
      reason: 'QA30 me bloqueo solo',
    });
    expect(noFinancia.status, 'un nodo no fija sus propios permisos').toBe(403);
    expect(noFinancia.body.reason).toBe('BOOKING_PERMISSIONS_FINANCIER_REQUIRED');

    const bloquear = await cons.put(ruta, {
      nonRefundableRates: 'blocked',
      reason: 'QA30 deuda vencida',
    });
    expect(bloquear.status, bloquear.text).toBeLessThan(300);
    const leido = await cons.get(ruta);
    expect(leido.text).toContain('blocked');

    const sub = await nodo('e2e-subagencia');
    const heredado = await (await como('adminA')).get(`/tenants/${sub}/booking-permissions`);
    expect(heredado.status, heredado.text).toBe(200);
    expect(heredado.text, 'la sub-agencia lo hereda').toContain('blocked');
  } finally {
    const permitir = await cons.put(ruta, {
      nonRefundableRates: 'allowed',
      reason: 'QA30 vuelve a permitir',
    });
    expect(permitir.status, permitir.text).toBeLessThan(300);
  }
});

test('CAR-08 / CHK-17 la retención sólo toma el total de la reserva y rechaza una cartera suspendida', async () => {
  const offer = await ofertaFija();
  const orden = await vendedor.pedir<{ order: { id: string } }>('POST', '/orders', {
    headers: { 'idempotency-key': randomUUID() },
    body: {
      offer,
      searchCriteria,
      passengers: [
        {
          paxId: 'ADT_1',
          paxType: 'ADT',
          givenName: 'Retencion',
          surname: 'Cartera',
          birthdate: '1990-05-15',
          gender: 'F',
          citizenshipCountryCode: 'CO',
          identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
        },
      ],
      contactInfo: { email: 'retencion@e2e.test', phone: '3001234567' },
    },
  });
  expect(orden.status, orden.text).toBeLessThan(300);
  const orderId = orden.body.order.id;
  const retener = (extra: Record<string, unknown>) =>
    vendedor.post<ErrorApi>('/portfolios/hold-booking', { orderId, ...extra });

  const otroTotal = await retener({ currency: 'COP', amountMinor: 1_000 });
  expect(otroTotal.status, 'sólo se retiene el total de la reserva').toBe(400);
  expect(otroTotal.body.message).toBe(
    'El total de la reserva cambió. Actualiza la reserva antes de retener saldo.',
  );

  const cons = await como('consolidador');
  const nodoA = await nodo('e2e-agencia-a');
  const carteras = await cons.get<{ portfolios?: { id: string; currency: string }[] }>(
    `/tenants/${nodoA}/portfolios`,
  );
  const cop = carteras.body.portfolios?.find((p) => p.currency === 'COP');
  expect(cop, 'agencia A tiene cartera COP').toBeDefined();
  const estado = (status: string) =>
    cons.patch(`/tenants/${nodoA}/portfolios/${cop!.id}`, { status, reason: `QA30 ${status}` });
  expect((await estado('suspended')).status).toBeLessThan(300);
  try {
    const suspendida = await retener({});
    expect(suspendida.status, suspendida.text).toBe(409);
    expect(suspendida.body.reason).toBe('PORTFOLIO_INACTIVE');
    expect(suspendida.body.message).toContain('está suspendida');
  } finally {
    expect((await estado('active')).status).toBeLessThan(300);
  }
});
