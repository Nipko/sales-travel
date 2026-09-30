import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  MemoryWalletHolds,
  type MemoryOrder,
  type MemoryWallet,
} from './__fixtures__/memory-wallet-holds.js';
import {
  BookingHoldRejectedError,
  PortfolioHoldAccountChangedError,
  type BookingHoldQuote,
} from './booking-hold.js';
import { PortfoliosService } from './portfolios.service.js';

/**
 * Retención de cartera sobre la orden ABIERTA, antes del Book (docs/tbo/09 PR-4.8; 08 RF-23 CA 1
 * y 2; D-TBO-21 A), y el aviso previo, con la red de 0060. La decisión y la cascada son de la base
 * (`wallet_hold_retain`, `wallet_hold_preview`); acá, con un doble de esas funciones, lo que hace el
 * servicio: qué orden admite, en qué orden bloquea, qué devuelve, cómo traduce un rechazo y a quién
 * avisa. La SQL real la prueban `portfolios.hold-intent.integration.test.ts` y
 * `network-holds.integration.test.ts`.
 */

const SUBAGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDEN = '22222222-2222-4222-8222-2222222222aa';
const USUARIO = '33333333-3333-4333-8333-333333333333';
const CUENTA = '77777777-7777-4777-8777-777777777777';

const USD = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

function quote(amountMinor: number, extra: Partial<BookingHoldQuote> = {}): BookingHoldQuote {
  return {
    amount: USD(amountMinor),
    netMinor: 30_000,
    vertical: 'hotels',
    providerCode: 'tbo-hotels',
    providerAccountId: CUENTA,
    ...extra,
  };
}

function intent(extra: Partial<MemoryOrder> = {}): MemoryOrder {
  return {
    id: ORDEN,
    tenant_id: SUBAGENCIA,
    status: 'pending',
    total_amount: 34_012,
    currency: 'USD',
    provider: 'tbo-hotels',
    provider_order_id: null,
    provider_raw: null,
    create_request_key: 'c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    vertical: 'hotels',
    ...extra,
  };
}

function banco(opts: { wallet?: Partial<MemoryWallet> | null; order?: Partial<MemoryOrder> } = {}) {
  const bank = new MemoryWalletHolds({
    orders: [intent(opts.order)],
    wallets:
      opts.wallet === null
        ? []
        : [MemoryWalletHolds.wallet(SUBAGENCIA, { balance_minor: 100_000, ...opts.wallet })],
  });
  const service = new PortfoliosService(
    bank.asDatabase(),
    {} as FlightProviderRegistry,
    {} as OrdersService,
    {} as HotelProviderRegistry,
  );
  return { bank, service };
}

async function rechazo(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PortfoliosService.assertBookingHoldAffordable: el control previo, sin escribir', () => {
  it('sin cartera en la moneda de la tarifa → rechazo con motivo, sin abrir una ni escribir', async () => {
    const b = banco({ wallet: { currency: 'COP' } });

    const err = await rechazo(b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012)));

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect((err as BookingHoldRejectedError).message).toBe(
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    );
    expect(b.bank.state.entries).toHaveLength(0);
    expect(b.bank.reports).toEqual([]);
  });

  it('pregunta con la cuenta, la vertical, la venta y el neto de la tarifa', async () => {
    const b = banco();

    await b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012));

    expect(b.bank.calls).toEqual([
      {
        fn: 'wallet_hold_preview',
        tenantId: SUBAGENCIA,
        params: ['tbo-hotels', CUENTA, 'hotels', 'USD', 34_012, 30_000],
      },
    ]);
  });

  it('el cupo que fija quien financia alcanza, y no retiene nada', async () => {
    const b = banco({ wallet: { balance_minor: 0, credit_limit_minor: 34_012 } });

    await expect(
      b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012)),
    ).resolves.toBeUndefined();
    expect(b.bank.state.entries).toHaveLength(0);
    expect(b.bank.wallet(SUBAGENCIA, 'USD')?.balance_minor).toBe(0);
  });

  it('un nivel de la red que no cubre la reserva la rechaza y, con la orden abierta, avisa a ese nivel', async () => {
    const b = banco();
    b.bank.network.rejectWith = 'network_funds_unavailable';

    const err = await rechazo(
      b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012), { reportOrderId: ORDEN }),
    );

    expect(err).toMatchObject({ reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE' });
    expect((err as BookingHoldRejectedError).message).toBe(
      'Tu red no tiene cupo disponible en USD para esta reserva. Pedile a quien te financia que lo revise.',
    );
    expect(b.bank.reports).toEqual([{ tenantId: SUBAGENCIA, orderId: ORDEN }]);
    expect(b.bank.state.entries).toHaveLength(0);
  });

  it('sin orden abierta (el PreBook) no hay a quién avisar', async () => {
    const b = banco();
    b.bank.network.rejectWith = 'network_currency_not_enabled';

    const err = await rechazo(b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012)));

    expect(err).toMatchObject({ reason: 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED' });
    expect(b.bank.reports).toEqual([]);
  });

  it('un rechazo de la cartera propia no avisa a la red', async () => {
    const b = banco({ wallet: { balance_minor: 0 } });

    await rechazo(
      b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012), { reportOrderId: ORDEN }),
    );

    expect(b.bank.reports).toEqual([]);
  });

  it('si la base no lo puede evaluar (una cuenta que ya no se resuelve), sigue: decide la reserva', async () => {
    const b = banco({ wallet: null });
    b.bank.network.previewUnknown = true;

    await expect(
      b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012), { reportOrderId: ORDEN }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['monto cero', { amountMinor: 0, currency: 'USD' }],
    ['monto no entero', { amountMinor: 1.5, currency: 'USD' }],
    ['moneda inválida', { amountMinor: 100, currency: 'dólares' }],
  ])('%s → 400 sin tocar la base', async (_caso, amount) => {
    const b = banco();

    await expect(
      b.service.assertBookingHoldAffordable(SUBAGENCIA, { ...quote(1), amount }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(b.bank.log).toEqual([]);
  });
});

describe('PortfoliosService.previewBookingHold: el aviso del PreBook, antes de cargar huéspedes', () => {
  it('con la cartera de la moneda de la tarifa y la red que alcanzan: ok, sin escribir ni bloquear', async () => {
    const b = banco();

    await expect(b.service.previewBookingHold(SUBAGENCIA, quote(34_012))).resolves.toEqual({
      status: 'ok',
      currency: 'USD',
    });
    expect(b.bank.state.entries).toHaveLength(0);
    expect(b.bank.log).toEqual(['wallet_hold_preview']);
  });

  it.each([
    [
      'sin cartera en esa moneda',
      { currency: 'COP' },
      'PORTFOLIO_CURRENCY_NOT_ENABLED',
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    ],
    [
      'con la cartera suspendida',
      { status: 'suspended' },
      'PORTFOLIO_INACTIVE',
      'La cartera en USD de la agencia está suspendida, así que no se puede retener el saldo para reservar. Pedile a quien te financia que la reactive.',
    ],
    [
      'sin saldo ni cupo',
      { balance_minor: 34_011 },
      'PORTFOLIO_FUNDS_INSUFFICIENT',
      'La cartera en USD de la agencia no tiene saldo ni cupo suficiente para esta reserva. Informá un depósito en Cartera B2B o pedile más cupo a quien te financia.',
    ],
  ])(
    '%s: bloqueado con el motivo y el texto de la reserva, sin saldo ni cupo',
    async (_caso, cambio, reason, message) => {
      const b = banco({ wallet: cambio });

      const preview = await b.service.previewBookingHold(SUBAGENCIA, quote(34_012));

      expect(preview).toEqual({ status: 'blocked', currency: 'USD', reason, message });
      // Lo mismo que diría la reserva: el aviso no inventa un texto propio.
      const err = await rechazo(b.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012)));
      expect(err).toMatchObject({ reason, message });
      expect(JSON.stringify(preview)).not.toMatch(/34011|100000/);
      expect(b.bank.state.entries).toHaveLength(0);
    },
  );

  it('un nivel de la red que no alcanza: bloqueado con el motivo de la red y sin decir cuál', async () => {
    const b = banco();
    b.bank.network.rejectWith = 'network_cost_unavailable';

    await expect(b.service.previewBookingHold(SUBAGENCIA, quote(34_012))).resolves.toEqual({
      status: 'blocked',
      currency: 'USD',
      reason: 'PORTFOLIO_NETWORK_COST_UNAVAILABLE',
      message:
        'No se pudo calcular el costo de esta reserva para tu red, así que no se retuvo saldo. Avisale a quien te financia.',
    });
  });

  it('si la base no lo puede evaluar, no hay aviso', async () => {
    const b = banco();
    b.bank.network.previewUnknown = true;

    await expect(b.service.previewBookingHold(SUBAGENCIA, quote(34_012))).resolves.toBeUndefined();
  });

  it('en el PreBook, un bloqueo de la red avisa al nivel que bloquea con lo cotizado, sin orden', async () => {
    const b = banco();
    b.bank.network.rejectWith = 'network_funds_unavailable';

    const preview = await b.service.previewBookingHold(SUBAGENCIA, quote(34_012), {
      reportNetworkBlock: true,
    });

    expect(preview).toMatchObject({ reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE' });
    // En su propia transacción, después de la lectura; la base decide a quién y deduplica.
    expect(b.bank.log).toEqual(['wallet_hold_preview', 'wallet_hold_report_preview_block']);
    expect(b.bank.previewReports).toEqual([
      { tenantId: SUBAGENCIA, params: ['tbo-hotels', CUENTA, 'hotels', 'USD', 34_012, 30_000] },
    ]);
    expect(b.bank.state.entries).toHaveLength(0);
  });

  it('sin pedirlo (el control previo del Book), o con un rechazo propio, no avisa a la red', async () => {
    const red = banco();
    red.bank.network.rejectWith = 'network_funds_unavailable';
    await red.service.previewBookingHold(SUBAGENCIA, quote(34_012));
    await rechazo(red.service.assertBookingHoldAffordable(SUBAGENCIA, quote(34_012)));
    expect(red.bank.previewReports).toEqual([]);

    const propia = banco({ wallet: { balance_minor: 0 } });
    await propia.service.previewBookingHold(SUBAGENCIA, quote(34_012), {
      reportNetworkBlock: true,
    });
    expect(propia.bank.previewReports).toEqual([]);
  });

  it('si el aviso del PreBook falla, el vendedor igual ve el bloqueo', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const b = banco();
    b.bank.network.rejectWith = 'network_currency_not_enabled';
    b.bank.reportFailure = new Error('base caída');

    await expect(
      b.service.previewBookingHold(SUBAGENCIA, quote(34_012), { reportNetworkBlock: true }),
    ).resolves.toMatchObject({ reason: 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED' });
  });

  it('un monto inválido es 400, como la retención: el aviso no inventa un "ok"', async () => {
    const b = banco();

    await expect(
      b.service.previewBookingHold(SUBAGENCIA, { ...quote(1), amount: USD(0) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normaliza la moneda antes de preguntar', async () => {
    const b = banco();

    await expect(
      b.service.previewBookingHold(SUBAGENCIA, {
        ...quote(1),
        amount: { amountMinor: 34_012, currency: ' usd ' },
      }),
    ).resolves.toEqual({ status: 'ok', currency: 'USD' });
  });
});

describe('PortfoliosService.holdBookingIntent: la retención sobre la orden abierta', () => {
  it('bloquea la orden, retiene por wallet_hold_retain y devuelve sólo lo de su cartera', async () => {
    const b = banco();

    const { transaction, portfolio } = await b.service.holdBookingIntent(
      SUBAGENCIA,
      ORDEN,
      USUARIO,
      USD(34_012),
    );

    expect(transaction).toMatchObject({
      amount_minor: -34_012,
      transaction_type: 'BOOKING_HOLD',
      reference_id: ORDEN,
      created_by: USUARIO,
      notes: 'Retención de saldo antes de reservar con el proveedor',
    });
    expect(portfolio.balance_minor).toBe(100_000 - 34_012);
    expect(b.bank.log).toEqual([
      "SET LOCAL lock_timeout = '2s'",
      'orders FOR UPDATE',
      'wallet_hold_retain',
      'agency_portfolios',
      'portfolio_transactions',
    ]);
    // La base recibe la orden y quien firma: nunca el monto ni la moneda.
    expect(b.bank.calls[0]?.params).toEqual([ORDEN, USUARIO]);
  });

  it('el cupo de la cartera acota lo que se retiene, también con una cuenta heredada', async () => {
    const b = banco({ wallet: { balance_minor: 10_000, credit_limit_minor: 24_011 } });

    const err = await rechazo(b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)));

    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_FUNDS_INSUFFICIENT');
    expect(b.bank.state.entries).toHaveLength(0);
    expect(b.bank.wallet(SUBAGENCIA, 'USD')?.balance_minor).toBe(10_000);

    b.bank.wallet(SUBAGENCIA, 'USD')!.credit_limit_minor = 24_012;
    await b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012));
    expect(b.bank.wallet(SUBAGENCIA, 'USD')?.balance_minor).toBe(10_000 - 34_012);
  });

  it('sin cartera en la moneda de la orden no retiene ni deja el asiento', async () => {
    const b = banco({ wallet: { currency: 'COP' } });

    const err = await rechazo(b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)));

    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect((err as BookingHoldRejectedError).message).toContain('cartera en USD');
    expect(b.bank.state.entries).toHaveLength(0);
    expect(b.bank.reports).toEqual([]);
  });

  it('un nivel de la red que no alcanza: 409 de la red, nada escrito y aviso al que bloqueó', async () => {
    const b = banco();
    b.bank.network.rejectWith = 'network_currency_not_enabled';

    const err = await rechazo(b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)));

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect((err as BookingHoldRejectedError).reason).toBe('PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED');
    expect((err as BookingHoldRejectedError).message).not.toMatch(/7970ade5|\d{3}/);
    // Todo o nada: tampoco quedó la retención propia.
    expect(b.bank.state.entries).toHaveLength(0);
    expect(b.bank.state.groups).toHaveLength(0);
    expect(b.bank.wallet(SUBAGENCIA, 'USD')?.balance_minor).toBe(100_000);
    // El aviso va en su propia transacción, después de la que se revirtió.
    expect(b.bank.log.slice(-1)).toEqual(['wallet_hold_report_block']);
    expect(b.bank.reports).toEqual([{ tenantId: SUBAGENCIA, orderId: ORDEN }]);
  });

  it('si el aviso falla, el vendedor igual ve el rechazo de la red', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const b = banco();
    b.bank.network.rejectWith = 'network_funds_unavailable';
    b.bank.reportFailure = new Error('base caída');

    await expect(
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
    ).rejects.toMatchObject({ reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE' });
  });

  it('la cuenta de la orden que ya no se resuelve: 409 PORTFOLIO_HOLD_ACCOUNT_CHANGED, sin retener', async () => {
    const b = banco();
    b.bank.network.ownerUnresolvable = true;

    const err = await rechazo(b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)));

    expect(err).toBeInstanceOf(PortfolioHoldAccountChangedError);
    expect(b.bank.state.entries).toHaveLength(0);
    expect(b.bank.reports).toEqual([]);
  });

  it('un bloqueo de la red se reintenta entero y, si pasa, retiene una sola vez', async () => {
    const b = banco();
    b.bank.retainLockErrors.push('55P03');

    await b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012));

    expect(b.bank.log.filter((l) => l === 'wallet_hold_retain')).toHaveLength(2);
    expect(b.bank.log.filter((l) => l.startsWith('SET LOCAL'))).toHaveLength(2);
    expect(b.bank.state.entries).toHaveLength(1);
  });

  it.each([
    ['confirmada', { status: 'confirmed' }],
    ['fallida', { status: 'failed' }],
    ['ya consolidada', { provider_raw: { phase: 'create' } }],
    ['sin clave de creación', { create_request_key: null }],
  ])(
    'una orden %s no es un intent abierto: 400 sin llamar a la retención',
    async (_caso, cambio) => {
      const b = banco({ order: cambio });

      await expect(
        b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
      ).rejects.toThrow(/Sólo una reserva abierta/);
      expect(b.bank.log).not.toContain('wallet_hold_retain');
      expect(b.bank.state.entries).toHaveLength(0);
    },
  );

  it('la orden de otro tenant no existe para este (RLS)', async () => {
    const b = banco();

    await expect(b.service.holdBookingIntent(OTRA, ORDEN, USUARIO, USD(34_012))).rejects.toThrow(
      /No se encontró la reserva/,
    );
  });

  it('una orden sin total válido es 400 antes de retener', async () => {
    const b = banco({ order: { total_amount: 0 } });

    await expect(
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
    ).rejects.toThrow(/no tiene un total y una moneda válidos/);
  });

  it('retiene lo que la orden dice: si la saga espera otro total, no retiene nada', async () => {
    const b = banco();

    for (const esperado of [USD(34_000), { amountMinor: 34_012, currency: 'EUR' }]) {
      await expect(
        b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, esperado),
      ).rejects.toThrow(/El total de la reserva cambió/);
    }
    expect(b.bank.state.entries).toHaveLength(0);
  });

  it('una segunda retención de la misma orden es 409 y no debita dos veces', async () => {
    const b = banco();

    const resultados = await Promise.allSettled([
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const perdida = resultados.find((r) => r.status === 'rejected');
    const razon = perdida?.status === 'rejected' ? (perdida.reason as Error) : undefined;
    expect(razon).toBeInstanceOf(ConflictException);
    expect(razon?.message).toBe(
      'Esta reserva ya tiene una retención activa. No se realizó un segundo débito.',
    );
    expect(b.bank.state.entries).toHaveLength(1);
    expect(b.bank.wallet(SUBAGENCIA, 'USD')?.balance_minor).toBe(100_000 - 34_012);
  });

  it('el 23505 de 0039, si otra ruta se coló, también es "ya tiene una retención activa"', async () => {
    const b = banco();
    b.bank.retainLockErrors.push('23505');

    await expect(
      b.service.holdBookingIntent(SUBAGENCIA, ORDEN, USUARIO, USD(34_012)),
    ).rejects.toThrow(
      'Esta reserva ya tiene una retención activa. No se realizó un segundo débito.',
    );
  });
});
