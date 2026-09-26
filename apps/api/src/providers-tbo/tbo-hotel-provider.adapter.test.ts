import { HttpStatus } from '@nestjs/common';
import type { HotelOffer, HotelRatesQuery, HotelSearchCriteria } from '@sales-travel/canonical';
import type { HotelBookingView } from '@sales-travel/domain';
import {
  TBO_OFFER_TTL_MS,
  TboDispatchRejectedError,
  TboHotelsAdapter,
  type TboHotelRatesReport,
  type TboSearchReport,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it, vi } from 'vitest';
import {
  supportsHotelBookingByClientReference,
  supportsHotelRatesContext,
  supportsHotelSearchContext,
  type HotelProviderCapabilities,
} from '../providers/hotel-provider.types.js';
import {
  TBO_PENDING_OPERATIONS,
  TboHotelProviderAdapter,
  TboOperationNotSupportedError,
  type TboHotelsAcl,
} from './tbo-hotel-provider.adapter.js';
import { TboHotelsProviderFactory } from './tbo-hotels.factory.js';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';

/**
 * El envoltorio neutral de TBO: delega lo que el ACL sabe hacer y rechaza, tipado y sin salir al
 * cable, lo que todavía no.
 */

const CTX = { tenantId: '11111111-1111-4111-8111-111111111111' };

const CRITERIO: HotelSearchCriteria = {
  hotelIds: ['1120548'],
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [] }],
  currency: 'USD',
  guestNationality: 'CO',
};

const OFERTA: HotelOffer = { hotelId: '1120548', roompacks: [] };

const CUENTA = { accountId: 'acc-consolidador', updatedAt: '2026-09-01T00:00:00.000Z' };

const T0 = Date.parse('2026-09-25T15:00:00Z');

/** El reporte del ACL: lo que el contexto del servidor necesita además de las ofertas. */
const REPORTE: Omit<TboSearchReport, 'offers'> = {
  searchId: '6110a41c-558c-405c-a0d3-6bdd3e131146',
  searchSentAt: T0,
  accountRef: '0123456789abcdef',
  packs: [
    {
      hotelCode: '1120548',
      bookingCode: '1120548!TB!2!TB!6110a41c-558c-405c-a0d3-6bdd3e131146',
      totalFare: '305.750',
      currency: 'USD',
    },
  ],
  batches: [],
  partial: false,
  omittedHotelCodes: 0,
  diagnostics: {
    hotelsReceived: 1,
    packsReceived: 1,
    packsMapped: 1,
    hotelsRejected: {},
    packsRejected: {},
    unknownKeys: [],
    unknownMealTypes: 0,
    amountsWithPrecisionLoss: 0,
    unsupportedCurrencies: [],
  },
};

/** Lo que BookingDetail devuelve ya en vocabulario neutral. */
const RESERVA: HotelBookingView = {
  found: true,
  status: 'CONFIRMED',
  providerBookingId: '7584263',
  bookingReference: 'STT0123456789ABCDEFGH',
  providerStatus: 'Confirmed',
  warnings: [],
};

type AclDoble = TboHotelsAcl & {
  searchAvailability: ReturnType<typeof vi.fn>;
  getHotelRates: ReturnType<typeof vi.fn>;
  searchAvailabilityReport: ReturnType<typeof vi.fn>;
  getHotelRatesReport: ReturnType<typeof vi.fn>;
  getBooking: ReturnType<typeof vi.fn>;
  getBookingByClientReference: ReturnType<typeof vi.fn>;
};

function acl(): AclDoble {
  return {
    accountRef: '0123456789abcdef',
    searchAvailability: vi.fn(() => Promise.resolve([OFERTA])),
    getHotelRates: vi.fn(() => Promise.resolve(OFERTA)),
    searchAvailabilityReport: vi.fn(() =>
      Promise.resolve<TboSearchReport>({ ...REPORTE, offers: [OFERTA] }),
    ),
    getHotelRatesReport: vi.fn(() =>
      Promise.resolve<TboHotelRatesReport>({ ...REPORTE, offer: OFERTA }),
    ),
    getBooking: vi.fn(() => Promise.resolve(RESERVA)),
    getBookingByClientReference: vi.fn(() => Promise.resolve(RESERVA)),
  };
}

describe('TboHotelProviderAdapter', () => {
  it('búsqueda y detalle van al ACL tal cual', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA);
    const query: HotelRatesQuery = { ...CRITERIO, hotelId: '1120548' };

    await expect(adapter.searchAvailability(CRITERIO, CTX)).resolves.toEqual([OFERTA]);
    await expect(adapter.getHotelRates(query, CTX)).resolves.toBe(OFERTA);
    expect(a.searchAvailability).toHaveBeenCalledWith(CRITERIO, CTX);
    expect(a.getHotelRates).toHaveBeenCalledWith(query, CTX);
    expect(adapter.accountRef).toBe('0123456789abcdef');
  });

  it.each(TBO_PENDING_OPERATIONS)(
    '`%s` todavía no existe: 501 tipado, sin tocar el ACL',
    async (operacion) => {
      const a = acl();
      const adapter = new TboHotelProviderAdapter(a, CUENTA);

      const err: unknown = await adapter[operacion]().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TboOperationNotSupportedError);
      expect((err as TboOperationNotSupportedError).getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
      expect((err as TboOperationNotSupportedError).operation).toBe(operacion);
      expect((err as Error).message).toContain('Elegí una tarifa de otro proveedor');
      expect(a.searchAvailability).not.toHaveBeenCalled();
      expect(a.getHotelRates).not.toHaveBeenCalled();
      expect(a.searchAvailabilityReport).not.toHaveBeenCalled();
      expect(a.getHotelRatesReport).not.toHaveBeenCalled();
      expect(a.getBooking).not.toHaveBeenCalled();
      expect(a.getBookingByClientReference).not.toHaveBeenCalled();
    },
  );

  it('PR-4.2: la lectura de una reserva, por localizador o por nuestra referencia, va al ACL tal cual', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA);

    await expect(adapter.getBooking('7584263', CTX)).resolves.toBe(RESERVA);
    await expect(adapter.getBookingByClientReference('STT0123456789ABCDEFGH', CTX)).resolves.toBe(
      RESERVA,
    );
    expect(a.getBooking).toHaveBeenCalledWith('7584263', CTX);
    expect(a.getBookingByClientReference).toHaveBeenCalledWith('STT0123456789ABCDEFGH', CTX);
    expect(supportsHotelBookingByClientReference(adapter)).toBe(true);
  });

  it('PreBook y Book siguen sin cablear aunque el ACL ya los tenga: los conecta la saga (PR-4.5, PR-4.6)', () => {
    expect(TBO_PENDING_OPERATIONS).toEqual(['prebook', 'book', 'cancelBooking']);
    expect(typeof TboHotelsAdapter.prototype.prebook).toBe('function');
    expect(typeof TboHotelsAdapter.prototype.book).toBe('function');
  });

  it('con contexto (RF-08): el reporte del ACL en vocabulario neutral, con el vencimiento de la oferta', async () => {
    const a = acl();
    const adapter = new TboHotelProviderAdapter(a, CUENTA);
    const query: HotelRatesQuery = { ...CRITERIO, hotelId: '1120548' };
    const contexto = {
      searchId: REPORTE.searchId,
      searchSentAt: T0,
      expiresAt: T0 + TBO_OFFER_TTL_MS,
      packs: [
        {
          hotelId: '1120548',
          offerRef: '1120548!TB!2!TB!6110a41c-558c-405c-a0d3-6bdd3e131146',
          // El literal, sin pasar por número: `305.750` no es `305.75` para quien lo reenvía.
          totalText: '305.750',
          currency: 'USD',
        },
      ],
    };

    await expect(adapter.searchAvailabilityWithContext(CRITERIO, CTX)).resolves.toEqual({
      ...contexto,
      offers: [OFERTA],
    });
    await expect(adapter.getHotelRatesWithContext(query, CTX)).resolves.toEqual({
      ...contexto,
      offer: OFERTA,
    });
    expect(a.searchAvailabilityReport).toHaveBeenCalledWith(CRITERIO, CTX);
    expect(a.getHotelRatesReport).toHaveBeenCalledWith(query, CTX);
    expect(TBO_OFFER_TTL_MS).toBe(27 * 60_000);
  });

  it('PR-2.6: un reporte completo no dice `partial`', async () => {
    const found = await new TboHotelProviderAdapter(acl(), CUENTA).searchAvailabilityWithContext(
      CRITERIO,
      CTX,
    );
    expect(found).not.toHaveProperty('partial');
  });

  /*
   * MUTACIÓN: sin pasar `report.partial`, el lote caído desaparece y el vendedor ve menos hoteles
   * sin ningún aviso (RF-14 CA-3; RNF-13).
   */
  it('PR-2.6: un lote que no aportó llega como `partial`, con el error tipado del primero que falló', async () => {
    const a = acl();
    const limite = new TboDispatchRejectedError('/Search', 'DEADLINE', 0);
    a.searchAvailabilityReport.mockResolvedValue({
      ...REPORTE,
      offers: [OFERTA],
      partial: true,
      batches: [
        { index: 0, hotelCodeCount: 100, status: 'ok', durationMs: 900 },
        { index: 1, hotelCodeCount: 100, status: 'not-dispatched', durationMs: 0, error: limite },
      ],
    } satisfies TboSearchReport);

    const found = await new TboHotelProviderAdapter(a, CUENTA).searchAvailabilityWithContext(
      CRITERIO,
      CTX,
    );

    expect(found.offers).toEqual([OFERTA]);
    expect(found.partial).toEqual({ cause: limite });
  });

  it('expone la huella de la cuenta de la bóveda como copia, y los puertos de contexto por presencia', () => {
    const adapter = new TboHotelProviderAdapter(acl(), CUENTA);

    expect(adapter.searchAccount).toEqual(CUENTA);
    (adapter.searchAccount as { accountId: string }).accountId = 'otra';
    expect(adapter.searchAccount).toEqual(CUENTA);
    expect(supportsHotelSearchContext(adapter)).toBe(true);
    expect(supportsHotelRatesContext(adapter)).toBe(true);
  });

  it('volcado a un log no arrastra el ACL', () => {
    expect(JSON.stringify(new TboHotelProviderAdapter(acl(), CUENTA))).toBe('{}');
  });
});

describe('las capacidades se encienden a medida que el ACL implementa cada puerto', () => {
  /**
   * Qué método del ACL enciende cada capacidad. Si el ACL de TBO gana uno, este test se pone en
   * rojo: hay que cablearlo en el envoltorio, sacarlo de `TBO_PENDING_OPERATIONS` y encender la
   * capacidad en el factory. Así la post-venta nunca confía en un método que responde "no
   * disponible", ni se queda sin usar uno que ya existe.
   */
  const METODO_DEL_ACL: Readonly<Record<keyof HotelProviderCapabilities, string>> = {
    retrieve: 'getBooking',
    cancel: 'cancelBooking',
    retrieveByClientReference: 'getBookingByClientReference',
    reconcileByDate: 'listBookingsByDate',
  };

  const factory = new TboHotelsProviderFactory({} as ProviderCredentialsService);

  it.each(Object.entries(METODO_DEL_ACL))('%s ⇔ el ACL implementa `%s`', (capacidad, metodo) => {
    const implementa =
      typeof (TboHotelsAdapter.prototype as unknown as Record<string, unknown>)[metodo] ===
      'function';
    expect(factory.capabilities[capacidad as keyof HotelProviderCapabilities]).toBe(implementa);
  });
});
