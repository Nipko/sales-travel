import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mapAvailability,
  mapHotelDetail,
  type AvailabilityQuery,
  type BookRequest,
  type BookResult,
  type CancelReservationRequest,
  type CancelReservationResult,
  type DespegarHotelsAdapter,
  type GeoSuggestion,
  type HotelDetailQuery,
  type HotelOffer,
  type PaymentModality,
  type PaymentOptionsQuery,
  type PrebookQuery,
  type PrebookResult,
  type RecoveryRequest,
  type RecoveryResult,
} from '@sales-travel/despegar-hotels';
import { vi, type MockInstance } from 'vitest';
import type { ProviderCredentialsService } from '../../provider-credentials/provider-credentials.service.js';
import { HotelProviderRegistry } from '../../providers/hotel-provider.registry.js';
import type {
  HotelProviderAdapter,
  HotelProviderFactory,
} from '../../providers/hotel-provider.types.js';
import type {
  CredentialSource,
  ProviderEnablementDecision,
  ProviderFlagsPort,
  TenantAdapter,
} from '../../providers/provider.types.js';
import { providerFlags } from '../../providers/__fixtures__/provider-flags.js';
import { DespegarHotelProviderAdapter } from '../../providers-despegar/despegar-hotel-provider.adapter.js';
import { DespegarHotelsProviderFactory } from '../../providers-despegar/despegar-hotels.factory.js';

/**
 * Adapter FALSO de Despegar Hoteles para la red de seguridad de la vertical (PR-0.1).
 *
 * No fabrica ofertas a mano: la búsqueda pasa una respuesta con la forma del cable de Despegar
 * (`despegar-availability.response.json`) por el mapper REAL del ACL. Así lo que sale de
 * `/hotels/availability` en los tests es lo que produce la cadena entera salvo el socket: el ACL
 * falso, el envoltorio neutral REAL, el registry REAL y el servicio. El snapshot
 * (`availability.snapshot.json`) se reproduce con el mismo insumo.
 *
 * Sólo lo importan tests, y el guard de alcanzabilidad de fixtures
 * (`search/sin-ofertas-fabricadas.guard.test.ts`) lo vigila desde los endpoints de hoteles.
 */

type RespuestaDespegar = Parameters<typeof mapAvailability>[0];

/** La superficie pública del adapter concreto: exactamente lo que `HotelsService` puede llamar. */
export type DespegarHotelsPort = Pick<DespegarHotelsAdapter, keyof DespegarHotelsAdapter>;

/** Se relee en cada llamada para que ningún test pueda contaminar el insumo de otro. */
function respuestaDisponibilidad(): RespuestaDespegar {
  const crudo = readFileSync(join(__dirname, 'despegar-availability.response.json'), 'utf8');
  return JSON.parse(crudo) as RespuestaDespegar;
}

function itemsPedidos(hotelIds: readonly string[]): NonNullable<RespuestaDespegar['items']> {
  const pedidos = new Set(hotelIds);
  return (respuestaDisponibilidad().items ?? []).filter((it) => pedidos.has(String(it.id ?? '')));
}

/**
 * Lo que Despegar contesta para esos IDs: sólo los que tienen cupo, en SU orden y no en el del
 * pedido. Un ID pedido que no figura en la respuesta es un hotel sin disponibilidad.
 */
export function ofertasDespegar(hotelIds: readonly string[]): HotelOffer[] {
  return mapAvailability({ items: itemsPedidos(hotelIds) });
}

/** IDs de la respuesta grabada, en el orden en que llegan. */
export const HOTELES_CON_CUPO = ['101', '205', '350'] as const;

export class FakeDespegarHotelsAdapter implements DespegarHotelsPort {
  readonly suggest = vi.fn((_hint: string, _locale?: string) =>
    Promise.resolve<GeoSuggestion[]>([
      { id: 2345, gid: 'CITY_2345', type: 1, display: 'Bogotá, Colombia', city: 'Bogotá' },
    ]),
  );

  readonly searchAvailability = vi.fn((q: AvailabilityQuery) =>
    Promise.resolve(ofertasDespegar(q.hotelIds)),
  );

  readonly getHotelDetail = vi.fn((q: HotelDetailQuery) => {
    const [item] = itemsPedidos([q.hotelId]);
    return Promise.resolve(mapHotelDetail(item ?? { id: q.hotelId }));
  });

  readonly prebook = vi.fn((_q: PrebookQuery) =>
    Promise.resolve<PrebookResult>({
      prebookId: 'PB-0001',
      status: 'AVAILABLE',
      expiration: '2026-11-01T15:30:00-05:00',
      total: { amountMinor: 41_237, currency: 'USD' },
    }),
  );

  readonly getPaymentOptions = vi.fn((_q: PaymentOptionsQuery) =>
    Promise.resolve<PaymentModality[]>([]),
  );

  readonly book = vi.fn((_req: BookRequest) =>
    Promise.resolve<BookResult>({ reservationId: 'RES-0001', status: 'SUCCESS', products: [] }),
  );

  readonly getReservation = vi.fn((reservationId: string) =>
    Promise.resolve<BookResult>({ reservationId, status: 'SUCCESS', products: [] }),
  );

  readonly cancelReservation = vi.fn((_req: CancelReservationRequest) =>
    Promise.resolve<CancelReservationResult>({ success: true }),
  );

  readonly recoverBooking = vi.fn((_req: RecoveryRequest) => Promise.resolve<RecoveryResult>({}));
}

export interface FakeDespegarFactory {
  /** El factory REAL de Despegar —código, capacidades, perfil de búsqueda y humanizador— … */
  factory: DespegarHotelsProviderFactory;
  /** … con el ACL concreto falso, que es lo que usan las rutas de reserva … */
  forTenant: MockInstance<(tenantId: string) => Promise<DespegarHotelsAdapter>>;
  /** … y el envoltorio neutral REAL sobre ese ACL, que es lo que usa la búsqueda. */
  resolveForTenant: MockInstance<
    (tenantId: string) => Promise<TenantAdapter<HotelProviderAdapter>>
  >;
}

/**
 * El factory real de Despegar con la resolución de credenciales reemplazada: entrega siempre el
 * mismo ACL falso. La resolución BYOC y el fallback a variables de entorno tienen su propio test
 * (`despegar-hotels.factory.test.ts`).
 */
export function fakeDespegarFactory(
  adapter: DespegarHotelsPort = new FakeDespegarHotelsAdapter(),
  credentialSource: CredentialSource = 'own',
): FakeDespegarFactory {
  const factory = new DespegarHotelsProviderFactory({
    resolve: () => Promise.reject(new Error('el doble de Despegar no resuelve credenciales')),
  } as unknown as ProviderCredentialsService);
  const neutral = new DespegarHotelProviderAdapter(adapter);

  const forTenant = vi
    .spyOn(factory, 'forTenant')
    .mockImplementation(() => Promise.resolve(adapter as unknown as DespegarHotelsAdapter));
  const resolveForTenant = vi
    .spyOn(factory, 'resolveForTenant')
    .mockImplementation(() => Promise.resolve({ adapter: neutral, credentialSource }));

  return { factory, forTenant, resolveForTenant };
}

/**
 * Habilitación: `true` enciende todo, `false` deja que mande la política de cada proveedor (un
 * `opt-in` apagado, el resto encendido) y la función decide a medida, también con una decisión de
 * la plataforma (ver `providers/__fixtures__/provider-flags.ts`).
 */
export function hotelFlags(
  enabled:
    | boolean
    | ((
        tenantId: string,
        code: string,
      ) => boolean | ProviderEnablementDecision | undefined) = false,
): ProviderFlagsPort {
  return providerFlags(enabled);
}

/** El registry REAL de hoteles con los factories dados. */
export function hotelRegistry(
  factories: HotelProviderFactory[],
  flags: ProviderFlagsPort = hotelFlags(),
): HotelProviderRegistry {
  return new HotelProviderRegistry(factories, flags);
}
