import type { HttpException } from '@nestjs/common';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ActivityPrice } from '@sales-travel/canonical';
import { mapAvailability } from '@sales-travel/despegar-activities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVAILABILITY_UN_ORL_FAMILY } from '../providers-despegar/__fixtures__/despegar-activities.fixtures.js';
import { activitiesGate } from './activities.capabilities.js';
import { ActivitiesService, pickPrice } from './activities.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';

const OFFER = mapAvailability(AVAILABILITY_UN_ORL_FAMILY, {
  activityId: 'UN_ORL',
  modalityId: 'ORL_1P1D_EPIC',
  date: '2026-12-10',
  requested: { adults: 2, childrenAges: [7, 1] },
})!;

const CURRENT_ACCOUNT = [
  {
    modality: 'PAYINADVANCE',
    total: { amountMinor: 41700, currency: 'USD' },
    taxBreakdown: [],
    options: [{ optionType: 'CURRENT_ACCOUNT', plans: [] }],
  },
];
const CARD_ONLY = [
  {
    modality: 'PAYINADVANCE',
    total: { amountMinor: 41700, currency: 'USD' },
    taxBreakdown: [],
    options: [{ optionType: 'ONE_CARD', plans: [] }],
  },
];

interface Setup {
  rules?: {
    tenantId: string;
    tenantName: string;
    level: number;
    ruleType: string;
    valueMinor: number;
  }[];
  homeCurrency?: string;
  owned?: { id: string; status: string } | undefined;
  payments?: unknown;
  book?: unknown;
  recordFails?: boolean;
  panel?: 'all' | 'sales';
}

function setup(s: Setup = {}) {
  const adapter = {
    discover: vi.fn(() => Promise.resolve([{ id: 'UN_ORL', category: 'ticket', name: 'UO' }])),
    getModalities: vi.fn(),
    getAvailability: vi.fn(() => Promise.resolve(OFFER)),
    shopping: vi.fn(() => Promise.resolve([])),
    prebook: vi.fn(() => Promise.resolve({ prebookId: 'pb-1', exchangePolicies: [], hints: [] })),
    getPaymentOptions: vi.fn(() => Promise.resolve(s.payments ?? CURRENT_ACCOUNT)),
    book: vi.fn(() =>
      Promise.resolve(
        s.book ?? {
          reservationId: 'R-1',
          status: 'SUCCESS',
          products: [{ type: 'TICKET', pnr: '777' }],
        },
      ),
    ),
    findReservation: vi.fn(() => Promise.resolve({ productId: 'P1' })),
    previewCancellation: vi.fn(),
    cancelReservation: vi.fn(() => Promise.resolve({ success: true, flowId: 'CAN-1' })),
  };
  const factory = {
    forTenant: vi.fn(() =>
      Promise.resolve({ adapter, credentialSource: 'inherited', accountId: 'acc-1', site: 'BR' }),
    ),
  };
  const pricing = { getApplicableRules: vi.fn(() => Promise.resolve(s.rules ?? [])) };
  const orders = {
    recordExternalOrder: vi.fn(() =>
      s.recordFails ? Promise.reject(new Error('db down')) : Promise.resolve({ id: 'order-1' }),
    ),
    findByProviderOrderId: vi.fn(() => Promise.resolve(s.owned)),
  };
  const audit = { emit: vi.fn(() => Promise.resolve()) };
  const updates: { set: unknown; wheres: unknown[][] }[] = [];
  const db = {
    db: {
      selectFrom: () => {
        const chain = {
          select: () => chain,
          where: () => chain,
          executeTakeFirst: () =>
            Promise.resolve({ default_currency: s.homeCurrency ?? 'COP', country_code: 'CO' }),
        };
        return chain;
      },
    },
    withTenant: (_t: string, fn: (trx: unknown) => unknown) => {
      const u = { set: undefined as unknown, wheres: [] as unknown[][] };
      const chain = {
        set: (v: unknown) => ((u.set = v), chain),
        where: (...args: unknown[]) => (u.wheres.push(args), chain),
        execute: () => (updates.push(u), Promise.resolve([])),
      };
      return fn({ updateTable: () => chain });
    },
  };
  const killSwitches = { panelLevel: vi.fn(() => s.panel) };
  const service = new ActivitiesService(
    factory as never,
    pricing as never,
    orders as never,
    audit as never,
    db as never,
    killSwitches as never,
  );
  return { service, adapter, factory, pricing, orders, audit, updates };
}

const BOOK_BODY = {
  prebookId: 'pb-1',
  offer: {
    choiceId: 'c-1',
    activityId: 'UN_ORL',
    name: 'Universal Orlando Resort',
    category: 'ticket' as const,
    date: '2026-12-10',
    currency: 'USD',
    netMinor: 41700,
  },
  contact: { email: 'agencia@example.com' },
  travelers: [
    {
      firstName: 'José',
      lastName: 'Peña',
      birthDate: '1990-01-01',
      identification: { type: 'PASSPORT' as const, number: 'AB12345' },
    },
  ],
};

describe('ActivitiesService', () => {
  beforeEach(() => {
    vi.stubEnv('DESPEGAR_ACTIVITIES_ENABLED', 'true');
    vi.stubEnv('PROVIDERS_DISABLED', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  describe('puerta: flag y kill-switch', () => {
    it('apagado por defecto: sin el flag la búsqueda es 503 y no llama a Despegar', async () => {
      vi.stubEnv('DESPEGAR_ACTIVITIES_ENABLED', '');
      const { service, adapter } = setup();
      await expect(service.search(TENANT, { destination: 'ORL' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(adapter.discover).not.toHaveBeenCalled();
      expect(service.status()).toMatchObject({ enabled: false, reason: 'flag-off' });
    });

    it('el apagado del panel le gana al flag', async () => {
      const { service, adapter } = setup({ panel: 'all' });
      await expect(service.search(TENANT, { destination: 'ORL' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(adapter.discover).not.toHaveBeenCalled();
      expect(service.status()).toMatchObject({ enabled: false, reason: 'kill-switch' });
    });

    it('`despegar-activities:ventas` frena la venta pero deja cancelar lo vendido', () => {
      vi.stubEnv('PROVIDERS_DISABLED', 'despegar-activities:ventas');
      expect(activitiesGate('sale', undefined)).toEqual({ enabled: false, reason: 'kill-switch' });
      expect(activitiesGate('read', undefined)).toEqual({ enabled: true });
    });

    it('con el flag apagado la post-venta de lo ya vendido sigue', () => {
      vi.stubEnv('DESPEGAR_ACTIVITIES_ENABLED', 'false');
      expect(activitiesGate('read', undefined)).toEqual({ enabled: true });
      expect(activitiesGate('sale', undefined)).toEqual({ enabled: false, reason: 'flag-off' });
    });

    it('declara sus capacidades y que no está validado contra la API real', () => {
      const { service } = setup();
      expect(service.status()).toMatchObject({
        enabled: true,
        provider: 'despegar-activities',
        capabilities: {
          paymentMethods: ['CURRENT_ACCOUNT'],
          providerFloor: false,
          validatedAgainstApi: false,
        },
      });
    });
  });

  describe('búsqueda y pricing', () => {
    it('usa el país de la cuenta como site, en minúsculas', async () => {
      const { service, adapter } = setup();
      await service.search(TENANT, { destination: 'ORL' });
      expect(adapter.discover).toHaveBeenCalledWith({ destination: 'ORL', site: 'br' });
    });

    it('availability sin tarifa es 404', async () => {
      const { service, adapter } = setup();
      adapter.getAvailability.mockResolvedValueOnce(undefined as never);
      await expect(
        service.availability(TENANT, {
          activityId: 'UN_ORL',
          modalityId: 'M',
          date: '2026-12-10',
          participants: { adults: 2, childrenAges: [] },
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('aplica la cascada `activities` sobre el bruto de la moneda elegida', async () => {
      const rules = [
        {
          tenantId: PARENT,
          tenantName: 'Consolidador',
          level: 0,
          ruleType: 'percentage',
          valueMinor: 1000,
        },
        { tenantId: TENANT, tenantName: 'Agencia', level: 1, ruleType: 'fixed', valueMinor: 500 },
      ];
      const { service, pricing } = setup({ rules, homeCurrency: 'USD' });
      const offer = await service.availability(TENANT, {
        activityId: 'UN_ORL',
        modalityId: 'ORL_1P1D_EPIC',
        date: '2026-12-10',
        participants: { adults: 2, childrenAges: [7, 1] },
        currency: 'USD',
      });
      expect(pricing.getApplicableRules).toHaveBeenCalledWith(TENANT, 'activities');
      expect(offer.price.currency).toBe('USD');
      // 41.700 + 10 % = 45.870 + 500 fijo = 46.370. Costo = neto + lo del consolidador.
      expect(offer.pricing).toEqual({
        costMinor: 45870,
        finalMinor: 46370,
        ownMarkupMinor: 500,
        currency: 'USD',
      });
    });

    it('en una moneda que no es la de la agencia sólo se aplican porcentajes', async () => {
      const rules = [
        { tenantId: TENANT, tenantName: 'Agencia', level: 0, ruleType: 'fixed', valueMinor: 20000 },
        {
          tenantId: TENANT,
          tenantName: 'Agencia',
          level: 0,
          ruleType: 'percentage',
          valueMinor: 500,
        },
      ];
      const { service } = setup({ rules, homeCurrency: 'COP' });
      const offer = await service.availability(TENANT, {
        activityId: 'UN_ORL',
        modalityId: 'ORL_1P1D_EPIC',
        date: '2026-12-10',
        participants: { adults: 2, childrenAges: [7, 1] },
        currency: 'BRL',
      });
      expect(offer.price.currency).toBe('BRL');
      expect(offer.pricing?.finalMinor).toBe(Math.round(229650 * 1.05));
    });

    it('sin reglas, el precio de venta es el del proveedor (sin `pricing`)', async () => {
      const { service } = setup();
      const offer = await service.availability(TENANT, {
        activityId: 'UN_ORL',
        modalityId: 'ORL_1P1D_EPIC',
        date: '2026-12-10',
        participants: { adults: 2, childrenAges: [7, 1] },
      });
      expect(offer.pricing).toBeUndefined();
      // Sin moneda pedida ni COP disponible: la local (BRL) antes que USD.
      expect(offer.price.currency).toBe('BRL');
    });
  });

  describe('reserva', () => {
    it('prebook informa si la cuenta ofrece cuenta corriente', async () => {
      const { service } = setup({ payments: CARD_ONLY });
      const p = await service.prebook(TENANT, { choiceId: 'c-1' });
      expect(p).toMatchObject({ prebookId: 'pb-1', currentAccountAvailable: false });
    });

    it('sin cuenta corriente no se reserva (402) y no se llama al book', async () => {
      const { service, adapter } = setup({ payments: CARD_ONLY });
      await expect(service.book(TENANT, USER, BOOK_BODY)).rejects.toMatchObject({ status: 402 });
      expect(adapter.book).not.toHaveBeenCalled();
    });

    it('un book en ERROR se traduce por su sub_status y no crea orden', async () => {
      const { service, orders } = setup({
        book: {
          reservationId: 'R-2',
          status: 'ERROR',
          subStatus: 'INSUFFICIENT_FUNDS',
          products: [],
        },
      });
      const err = (await service
        .book(TENANT, USER, BOOK_BODY)
        .catch((e: unknown) => e)) as HttpException;
      expect(err.getStatus()).toBe(402);
      expect(JSON.stringify(err.getResponse())).toContain('saldo');
      expect(orders.recordExternalOrder).not.toHaveBeenCalled();
    });

    it('confirmada: guarda la orden con el precio de venta y referencia única del partner', async () => {
      const rules = [
        { tenantId: TENANT, tenantName: 'A', level: 0, ruleType: 'percentage', valueMinor: 1000 },
      ];
      const { service, adapter, orders, audit } = setup({ rules, homeCurrency: 'USD' });
      const out = await service.book(TENANT, USER, BOOK_BODY);
      expect(out).toMatchObject({
        reservationId: 'R-1',
        status: 'SUCCESS',
        pnr: '777',
        recorded: true,
        orderId: 'order-1',
        saleMinor: 45870,
        currency: 'USD',
      });
      const bookReq = (adapter.book.mock.calls[0] as unknown[] | undefined)?.[0] as {
        externalBookingReference: string;
      };
      expect(bookReq.externalBookingReference).toMatch(/^ST-ACT-[0-9A-F]{16}$/);
      expect(orders.recordExternalOrder).toHaveBeenCalledWith(
        TENANT,
        USER,
        expect.objectContaining({
          provider: 'despegar-activities',
          providerOrderId: 'R-1',
          status: 'confirmed',
          totalAmountMinor: 45870,
          currency: 'USD',
        }),
      );
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ActivityReservationCreated' }),
      );
      // El evento no lleva nombres ni correos.
      const payload = JSON.stringify(audit.emit.mock.calls[0]);
      expect(payload).not.toContain('Peña');
      expect(payload).not.toContain('agencia@example.com');
    });

    it('si la orden no se puede guardar, la reserva se informa igual con rastro durable', async () => {
      const { service, audit } = setup({ recordFails: true });
      const out = await service.book(TENANT, USER, BOOK_BODY);
      expect(out).toMatchObject({ reservationId: 'R-1', recorded: false });
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ActivityReservationUnrecorded' }),
      );
    });
  });

  describe('post-venta: sólo reservas de la agencia', () => {
    it('una reserva ajena (cuenta heredada) es 404 y no llega a Despegar', async () => {
      const { service, adapter, orders } = setup({ owned: undefined });
      await expect(service.reservation(TENANT, 'R-OTRA')).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.cancel(TENANT, USER, 'R-OTRA', { reason: 'OTHER' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(orders.findByProviderOrderId).toHaveBeenCalledWith(
        TENANT,
        'despegar-activities',
        'R-OTRA',
      );
      expect(adapter.findReservation).not.toHaveBeenCalled();
      expect(adapter.cancelReservation).not.toHaveBeenCalled();
    });

    it('cancelar deja la orden cancelada, filtrando por tenant', async () => {
      const { service, adapter, updates } = setup({
        owned: { id: 'order-1', status: 'confirmed' },
      });
      const r = await service.cancel(TENANT, USER, 'R-1', { reason: 'OTHER' });
      expect(r).toMatchObject({ success: true });
      expect(adapter.cancelReservation).toHaveBeenCalledWith('R-1', 'OTHER');
      expect(updates[0]?.set).toEqual({ status: 'cancelled' });
      expect(updates[0]?.wheres).toContainEqual(['tenant_id', '=', TENANT]);
    });

    it('una reserva ya cancelada no se vuelve a mandar', async () => {
      const { service, adapter } = setup({ owned: { id: 'order-1', status: 'cancelled' } });
      await expect(service.cancel(TENANT, USER, 'R-1', { reason: 'OTHER' })).rejects.toMatchObject({
        status: 409,
      });
      expect(adapter.cancelReservation).not.toHaveBeenCalled();
    });
  });
});

describe('pickPrice', () => {
  const price = (currency: string): ActivityPrice => ({
    currency,
    net: { amountMinor: 1, currency },
    tax: { amountMinor: 0, currency },
    gross: { amountMinor: 1, currency },
  });
  const prices = [price('USD'), price('BRL')];

  it('la pedida, luego la de la agencia, luego la local, luego la primera', () => {
    expect(pickPrice(prices, 'usd', 'BRL').currency).toBe('USD');
    expect(pickPrice(prices, 'COP', 'BRL').currency).toBe('BRL');
    expect(pickPrice(prices, undefined, 'COP').currency).toBe('BRL');
    expect(pickPrice([price('USD')], 'COP', 'COP').currency).toBe('USD');
  });
});
