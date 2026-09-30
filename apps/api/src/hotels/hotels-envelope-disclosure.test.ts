import { Logger } from '@nestjs/common';
import type { HotelOffer } from '@sales-travel/canonical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { stubHotelOffer } from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type { ActiveTenantService } from '../request-context/active-tenant.service.js';
import type { DespegarHotelReservationsService } from './despegar-hotel-reservations.service.js';
import type { HotelBookingService } from './hotel-booking.service.js';
import type { BookingPermissionsService } from '../booking-permissions/booking-permissions.service.js';
import type { HotelContentService } from './hotel-content.service.js';
import type { HotelPrebookService } from './hotel-prebook.service.js';
import type { HotelSearchResponse } from './hotel-search.aggregate.js';
import { HotelsController } from './hotels.controller.js';
import type { HotelAvailabilityInput } from './hotels.schemas.js';
import type { HotelsService } from './hotels.service.js';

/**
 * RF-40 CA 1 a 3 del lado del API: "me tiene que mostrar de dónde es". Espejo de
 * `provider-disclosure/search-envelope-disclosure.test.ts`.
 *
 * El ajuste es de PRESENTACIÓN y viaja como un booleano aparte: con el ajuste apagado cada tarifa
 * sigue diciendo de qué proveedor es, porque el PreBook se enruta por `provider.name`, y el parte
 * por proveedor sale intacto. La regla es la de vuelos, sin variantes: la misma columna, el mismo
 * plegado de la cadena ("ocultar gana") y el mismo servicio.
 */

const CONSOLIDADOR = '11111111-1111-4111-8111-111111111111';
const AGENCIA = '22222222-2222-4222-8222-222222222222';
const SUBAGENCIA = '33333333-3333-4333-8333-333333333333';

/** Un hotel con una tarifa de cada proveedor: la tarjeta agrupada de RF-40 CA 5. */
function hotelCompartido(): HotelOffer {
  const roompacks = [
    ...stubHotelOffer('despegar-hotels', { hotelId: 'H-1' }).roompacks,
    ...stubHotelOffer('otro-hotels', { hotelId: 'H-1', amountMinor: 90_000 }).roompacks,
  ];
  return { hotelId: 'H-1', name: 'Hotel Compartido', roompacks };
}

const RESPUESTA: HotelSearchResponse = {
  hotels: [hotelCompartido()],
  providers: [
    { code: 'despegar-hotels', status: 'ok', count: 1 },
    { code: 'otro-hotels', status: 'ok', count: 1 },
    { code: 'tercero-hotels', status: 'error', count: 0, reason: 'no respondió' },
  ],
};

const BUSQUEDA: HotelAvailabilityInput = {
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-13',
  rooms: [{ adults: 2, childrenAges: [] }],
  destinationId: 2345,
};

interface Fila {
  tenant_id: string;
  lvl: number;
  show_provider_in_results: boolean | null;
}

/** El ejecutor mínimo que consume `sql\`…\`.execute(db)`: devuelve la cadena de 0036. */
function disclosureCon(cadena: () => readonly Fila[] | Promise<never>): ProviderDisclosureService {
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: () => ({ sql: '', parameters: [] }),
    executeQuery: () => {
      const filas = cadena();
      return filas instanceof Promise ? filas : Promise.resolve({ rows: filas });
    },
  };
  return new ProviderDisclosureService({
    db: { getExecutor: () => executor },
  } as unknown as DatabaseService);
}

function controllerCon(
  tenantId: string,
  disclosure: ProviderDisclosureService,
): { controller: HotelsController; searchAvailability: ReturnType<typeof vi.fn> } {
  const searchAvailability = vi.fn(() => Promise.resolve(structuredClone(RESPUESTA)));
  const controller = new HotelsController(
    { searchAvailability } as unknown as HotelsService,
    {} as DespegarHotelReservationsService,
    { resolve: () => Promise.resolve(tenantId) } as unknown as ActiveTenantService,
    disclosure,
    {} as HotelPrebookService,
    {} as HotelBookingService,
    {} as HotelContentService,
    {} as BookingPermissionsService,
  );
  return { controller, searchAvailability };
}

function fijo(valor: boolean): ProviderDisclosureService {
  return { effective: () => Promise.resolve(valor) } as unknown as ProviderDisclosureService;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RF-40 CA 1 — el booleano va FUERA de `hotels[]` y no recorta nada', () => {
  it('con el ajuste apagado, cada tarifa sigue diciendo de qué proveedor es', async () => {
    const { controller } = controllerCon(AGENCIA, fijo(false));
    const out = await controller.availability('u1', BUSQUEDA);

    expect(out.showProviderInResults).toBe(false);
    expect(out.hotels[0]?.roompacks.map((rp) => rp.provider.name)).toEqual([
      'despegar-hotels',
      'otro-hotels',
    ]);
    expect(out.hotels[0]?.roompacks.map((rp) => rp.provider.offerRef)).toEqual([
      'despegar-hotels-H-1-REF',
      'otro-hotels-H-1-REF',
    ]);
  });

  it('con el ajuste apagado, el parte por proveedor sale intacto, motivos incluidos', async () => {
    const { controller } = controllerCon(AGENCIA, fijo(false));
    const out = await controller.availability('u1', BUSQUEDA);

    expect(out.providers).toEqual(RESPUESTA.providers);
  });

  it('con el ajuste encendido la respuesta es la misma, salvo el booleano', async () => {
    const oculto = await controllerCon(AGENCIA, fijo(false)).controller.availability(
      'u1',
      BUSQUEDA,
    );
    const visible = await controllerCon(AGENCIA, fijo(true)).controller.availability(
      'u1',
      BUSQUEDA,
    );

    expect(visible.showProviderInResults).toBe(true);
    expect({ ...visible, showProviderInResults: false }).toEqual(oculto);
  });

  it('el booleano no se mete en ningún hotel ni en ninguna tarifa', async () => {
    const { controller } = controllerCon(AGENCIA, fijo(true));
    const out = await controller.availability('u1', BUSQUEDA);

    expect(JSON.stringify(out.hotels)).not.toContain('showProviderInResults');
  });
});

describe('RF-40 CA 2 — el plegado de vuelos, sin reglas nuevas', () => {
  async function efectivo(tenantId: string, cadena: readonly Fila[]): Promise<boolean> {
    const { controller } = controllerCon(
      tenantId,
      disclosureCon(() => cadena),
    );
    return (await controller.availability('u1', BUSQUEDA)).showProviderInResults;
  }

  it('cadena sin opiniones → oculto', async () => {
    expect(
      await efectivo(AGENCIA, [
        { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: null },
        { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: null },
      ]),
    ).toBe(false);
  });

  it('consolidador "Mostrar" y nadie más opina → visible en su agencia y en su sub-agencia', async () => {
    expect(
      await efectivo(AGENCIA, [
        { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: true },
        { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: null },
      ]),
    ).toBe(true);
    expect(
      await efectivo(SUBAGENCIA, [
        { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: true },
        { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: null },
        { tenant_id: SUBAGENCIA, lvl: 3, show_provider_in_results: null },
      ]),
    ).toBe(true);
  });

  it('consolidador "Mostrar" y agencia "Ocultar" → oculto en toda la rama de la agencia', async () => {
    const rama = [
      { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: true },
      { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: false },
    ];
    expect(await efectivo(AGENCIA, rama)).toBe(false);
    expect(
      await efectivo(SUBAGENCIA, [
        ...rama,
        { tenant_id: SUBAGENCIA, lvl: 3, show_provider_in_results: null },
      ]),
    ).toBe(false);
  });

  it('consolidador "Ocultar" y agencia "Mostrar" → oculto, bloqueado por el ancestro', async () => {
    const cadena = [
      { tenant_id: CONSOLIDADOR, lvl: 1, show_provider_in_results: false },
      { tenant_id: AGENCIA, lvl: 2, show_provider_in_results: true },
    ];
    expect(await efectivo(AGENCIA, cadena)).toBe(false);
    expect((await disclosureCon(() => cadena).view(AGENCIA)).lockedByAncestor).toBe(true);
  });

  it('si la divulgación no se puede resolver, la búsqueda responde igual, con `false`', async () => {
    const { controller, searchAvailability } = controllerCon(
      AGENCIA,
      disclosureCon(() => Promise.reject(new Error('base caída'))),
    );
    const out = await controller.availability('u1', BUSQUEDA);

    expect(out.showProviderInResults).toBe(false);
    expect(out.hotels).toEqual(RESPUESTA.hotels);
    expect(searchAvailability).toHaveBeenCalledTimes(1);
  });
});

describe('RF-40 CA 3 — el ajuste se resuelve en cada búsqueda', () => {
  it('un cambio del ajuste se ve en la búsqueda siguiente', async () => {
    let muestra: boolean | null = false;
    const disclosure = disclosureCon(() => [
      { tenant_id: AGENCIA, lvl: 1, show_provider_in_results: muestra },
    ]);
    const { controller } = controllerCon(AGENCIA, disclosure);

    const antes = await controller.availability('u1', BUSQUEDA);
    muestra = true;
    const despues = await controller.availability('u1', BUSQUEDA);

    expect([antes.showProviderInResults, despues.showProviderInResults]).toEqual([false, true]);
  });

  it('se resuelve con el tenant ACTIVO de la búsqueda, en paralelo con ella', async () => {
    const effective = vi.fn(() => Promise.resolve(true));
    const { controller, searchAvailability } = controllerCon(SUBAGENCIA, {
      effective,
    } as unknown as ProviderDisclosureService);
    await controller.availability('u1', BUSQUEDA);

    expect(effective).toHaveBeenCalledWith(SUBAGENCIA);
    expect(searchAvailability).toHaveBeenCalledWith(SUBAGENCIA, BUSQUEDA);
  });
});
