import type { BrandingService } from '../../branding/branding.service.js';
import type { MailerService } from '../../mail/mailer.service.js';
import type { FlightProviderRegistry } from '../../providers/flight-provider.registry.js';
import type { ActiveTenantService } from '../../request-context/active-tenant.service.js';
import type { FlightOrderTrackingStore } from '../flight-order-tracking.store.js';
import type { HotelOrderReadsService } from '../hotel-order-reads.service.js';
import { OrderCapabilitiesService } from '../order-capabilities.service.js';
import { OrderConfirmationService } from '../order-confirmation.service.js';
import { OrdersController } from '../orders.controller.js';
import type { OrdersService } from '../orders.service.js';

/**
 * `OrdersController` con sus servicios de confirmación y de capacidades REALES, armados sobre los
 * dobles de cada test (el correo, la marca, los registries). Así los tests del controlador siguen
 * probando las reglas de siempre aunque vivan en otro archivo.
 */
export function ordersController(deps: {
  readonly orders: OrdersService;
  readonly mailer: MailerService;
  readonly branding: BrandingService;
  readonly activeTenant: ActiveTenantService;
  readonly registry: FlightProviderRegistry;
  readonly hotelReads: HotelOrderReadsService;
  readonly flightTracking?: FlightOrderTrackingStore;
}): OrdersController {
  return new OrdersController(
    deps.orders,
    deps.activeTenant,
    deps.hotelReads,
    new OrderConfirmationService(deps.mailer, deps.branding, deps.hotelReads),
    new OrderCapabilitiesService(deps.registry, deps.hotelReads),
    deps.flightTracking,
  );
}
