import { Injectable } from '@nestjs/common';
import {
  DespegarApiError,
  type BookRequest,
  type BookResult,
  type CancelReservationRequest,
  type CancelReservationResult,
  type DespegarHotelsAdapter,
  type PaymentModality,
  type PaymentOptionsQuery,
  type PrebookQuery,
  type PrebookResult,
  type RecoveryRequest,
  type RecoveryResult,
} from '@sales-travel/despegar-hotels';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import {
  supportsHotelPaymentOptions,
  supportsHotelPriceJumpRecovery,
  type HotelProviderAdapter,
  type HotelProviderCapability,
} from '../providers/hotel-provider.types.js';
import { DespegarHotelsProviderFactory } from '../providers-despegar/despegar-hotels.factory.js';
import { DESPEGAR_HOTELS_PROVIDER_CODE } from '../providers-despegar/despegar-hotel-provider.adapter.js';
import { CircuitBreakerService, type CallScope } from '../search/circuit-breaker.service.js';
import { HotelProviderCapabilityError } from './hotel-provider-errors.js';

const CODE = DESPEGAR_HOTELS_PROVIDER_CODE;

/** Qué tiene que saber hacer Despegar para servir cada ruta. */
type Requirement =
  | { readonly capability: HotelProviderCapability; readonly operation: string }
  | {
      readonly supports: (adapter: HotelProviderAdapter) => boolean;
      readonly operation: string;
    };

/** Lo que devolvió Despegar, o su rechazo, sin que el rechazo cuente como caída. */
type Answer<T> = { readonly value: T } | { readonly rejection: DespegarApiError };

/**
 * Un 4xx es Despegar RESPONDIENDO que no: tarifa vencida, reserva que no existe, datos que no
 * acepta, credencial o cupo de UNA cuenta. El circuito mide si Despegar está caído y es uno por
 * código para todos los tenants: si esto contara, cinco reintentos de un vendedor cortarían 30 s
 * la búsqueda de hoteles de toda la red. Sí cuentan la red (status 0), los 5xx y lo que no es de
 * Despegar. Es el criterio de 06 §5.6. El breaker ya lee el efecto que declara cada error
 * (`failure.circuit`, PR-0.6), pero `DespegarApiError` no lo trae y el ACL de Despegar no se toca:
 * por eso el rechazo se sigue apartando acá.
 */
function isRejection(err: unknown): err is DespegarApiError {
  return err instanceof DespegarApiError && err.status >= 400 && err.status < 500;
}

/**
 * Las rutas de reserva de `/hotels` que todavía hablan los DTOs de Despegar: prebook por
 * `choiceId`, medios de pago, book con token de checkout alojado, lectura, cancelación y salto de
 * precio.
 *
 * Son el flujo actual de Despegar y siguen como están hasta que la reserva de hoteles pase a
 * órdenes con el contrato neutral (PR-4.x). Lo que cambia es cómo se llega a Despegar:
 *
 * - por el registry: si Despegar no está habilitado para el tenant con las mismas reglas que la
 *   búsqueda (cuenta propia, heredada o fallback de plataforma), la ruta responde 400 en vez de
 *   salir con las credenciales de la plataforma; y si la plataforma lo apagó para el tenant, las
 *   rutas de venta responden 400 y las de post-venta siguen;
 * - por capacidad: lectura y cancelación, según lo que declara el factory; medios de pago y salto
 *   de precio, según los puertos opcionales que implementa su adapter;
 * - por el circuito, como la búsqueda: `PROVIDERS_DISABLED=despegar-hotels` apaga también la
 *   reserva y un Despegar caído falla al instante. Sus rechazos (4xx) no abren el circuito:
 *   ver {@link isRejection}. `despegar-hotels:ventas` frena prebook, medios de pago, book y salto
 *   de precio, pero deja leer y cancelar lo ya vendido: esas dos rutas son post-venta.
 *
 * Pedido y respuesta de cada llamada pasan intactos, como antes.
 */
@Injectable()
export class DespegarHotelReservationsService {
  constructor(
    private readonly registry: HotelProviderRegistry,
    private readonly factory: DespegarHotelsProviderFactory,
    private readonly breaker: CircuitBreakerService,
  ) {}

  prebook(tenantId: string, q: PrebookQuery): Promise<PrebookResult> {
    return this.call(tenantId, 'sales', undefined, (acl) => acl.prebook(q));
  }

  getPaymentOptions(tenantId: string, q: PaymentOptionsQuery): Promise<PaymentModality[]> {
    return this.call(
      tenantId,
      'sales',
      { supports: supportsHotelPaymentOptions, operation: 'medios de pago por prebook' },
      (acl) => acl.getPaymentOptions(q),
    );
  }

  book(tenantId: string, req: BookRequest): Promise<BookResult> {
    return this.call(tenantId, 'sales', undefined, (acl) => acl.book(req));
  }

  getReservation(tenantId: string, reservationId: string): Promise<BookResult> {
    return this.call(
      tenantId,
      'post-sale',
      { capability: 'retrieve', operation: 'la consulta de reservas' },
      (acl) => acl.getReservation(reservationId),
    );
  }

  cancelReservation(
    tenantId: string,
    req: CancelReservationRequest,
  ): Promise<CancelReservationResult> {
    return this.call(
      tenantId,
      'post-sale',
      { capability: 'cancel', operation: 'la cancelación de reservas' },
      (acl) => acl.cancelReservation(req),
    );
  }

  recoverBooking(tenantId: string, req: RecoveryRequest): Promise<RecoveryResult> {
    return this.call(
      tenantId,
      'sales',
      { supports: supportsHotelPriceJumpRecovery, operation: 'la confirmación de salto de precio' },
      (acl) => acl.recoverBooking(req),
    );
  }

  private async call<T>(
    tenantId: string,
    scope: CallScope,
    requirement: Requirement | undefined,
    op: (acl: DespegarHotelsAdapter) => Promise<T>,
  ): Promise<T> {
    // Las rutas de venta respetan el apagado de la plataforma para el tenant; leer y cancelar lo ya
    // vendido, no.
    const provider =
      scope === 'sales'
        ? await this.registry.byCodeForOffer(tenantId, CODE)
        : await this.registry.byCode(tenantId, CODE);
    if (requirement !== undefined) {
      const ok =
        'capability' in requirement
          ? provider.capabilities[requirement.capability]
          : requirement.supports(provider.adapter);
      if (!ok) throw new HotelProviderCapabilityError(CODE, requirement.operation);
    }
    const acl = await this.factory.forTenant(tenantId);
    // El rechazo cruza el circuito como respuesta y se relanza afuera, el mismo objeto: el filtro
    // de la vertical lo sigue traduciendo a 502 como antes.
    const answer = await this.breaker.execute(
      CODE,
      async (): Promise<Answer<T>> => {
        try {
          return { value: await op(acl) };
        } catch (err) {
          if (isRejection(err)) return { rejection: err };
          throw err;
        }
      },
      { scope },
    );
    if ('rejection' in answer) throw answer.rejection;
    return answer.value;
  }
}
