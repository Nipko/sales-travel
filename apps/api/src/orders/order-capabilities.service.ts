import { BadRequestException, Injectable } from '@nestjs/common';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities, ProviderCapability } from '../providers/provider.types.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import type { OrderRow } from './orders.service.js';
import { TICKET_VOID_MESSAGES } from './ticket-void.plan.js';

const NO_FLIGHT_CAPABILITIES: ProviderCapabilities = {
  retrieve: false,
  cancel: false,
  pay: false,
  services: false,
  reshop: false,
};

/** AgentCars no tiene registry: su factory es único y hoy sólo expone cancelación dentro de Orders. */
const AGENT_CARS_ORDER_CAPABILITIES: ProviderCapabilities = {
  retrieve: false,
  cancel: true,
  pay: false,
  services: false,
  reshop: false,
};

/**
 * Qué operaciones de post-venta sabe hacer el proveedor de una reserva. Lo usan Reservas de la
 * agencia (`OrdersController`) y Reservas de la red (la consola del superadmin), con las mismas
 * reglas: antes vivía dentro del controlador de la agencia.
 */
@Injectable()
export class OrderCapabilitiesService {
  constructor(
    private readonly registry: FlightProviderRegistry,
    private readonly hotelReads: HotelOrderReadsService,
  ) {}

  /**
   * Rechaza la operación si el proveedor de la reserva no la sabe hacer.
   *
   * Antes esto era `row.provider !== '<un proveedor concreto>'`: cada proveedor nuevo obligaba
   * a acordarse de tocar este `if`, y olvidarlo significaba mandar una operación a un adapter
   * que no la implementa. Ahora lo decide el propio proveedor, declarando sus capacidades.
   */
  assertSupports(row: Pick<OrderRow, 'provider' | 'status'>, capability: ProviderCapability): void {
    if (capability === 'cancel' && row.status === 'ticketed') {
      // La única forma de cancelar una reserva emitida es anular (o reembolsar) sus tiquetes.
      throw new BadRequestException(TICKET_VOID_MESSAGES.ticketedCancel);
    }
    if (!this.capabilitiesForOrder(row)[capability]) {
      throw new BadRequestException(
        `La operación no está disponible para reservas de proveedor '${row.provider}'.`,
      );
    }
  }

  /**
   * ¿Es una orden de vuelo? Ni hotel ni auto: una orden de un proveedor de vuelos ya retirado
   * también cuenta. Vive aquí, junto a las capacidades de autos, para que el controlador no nombre
   * proveedores (guard de neutralidad).
   */
  isFlightOrder(row: Pick<OrderRow, 'provider'>): boolean {
    return !this.hotelReads.handles(row.provider) && row.provider !== 'agent-cars';
  }

  /** Lo declara el registry de la vertical del proveedor; ninguna vertical se fija aquí. */
  capabilitiesFor(provider: string): ProviderCapabilities {
    if (provider === 'agent-cars') return AGENT_CARS_ORDER_CAPABILITIES;
    return (
      this.hotelReads.capabilitiesOf(provider) ??
      this.registry.capabilitiesOf(provider) ??
      NO_FLIGHT_CAPABILITIES
    );
  }

  /** Las del proveedor, sin cancelar una emitida: la cancelación genérica no anula tiquetes. */
  capabilitiesForOrder(row: Pick<OrderRow, 'provider' | 'status'>): ProviderCapabilities {
    const capabilities = this.capabilitiesFor(row.provider);
    return row.status === 'ticketed' ? { ...capabilities, cancel: false } : capabilities;
  }
}
