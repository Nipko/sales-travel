import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BrandingService } from '../branding/branding.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { hotelOrderConfirmationEmailHtml } from '../mail/templates.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import {
  flightOrderConfirmationMail,
  isTestContentOrder,
  orderContactEmail,
} from './order-confirmation-mail.js';
import type { OrderRow } from './orders.service.js';

/** Qué salió del reenvío: si el correo se mandó y a quién. */
export interface OrderConfirmationSent {
  readonly sent: boolean;
  /** El correo de contacto de la reserva; vacío si no tiene. */
  readonly to: string;
}

/**
 * ¿La orden es una reserva de la cuenta de pruebas del proveedor? La regla vive en
 * `order-confirmation-mail.ts`, junto a la plantilla que la usa, para que la emisión de tiquetes y
 * este servicio no se desincronicen.
 */
export const isTestContent = isTestContentOrder;

/** El correo de contacto de la reserva, o `''` si no tiene uno. */
export const contactEmail = orderContactEmail;

/**
 * La confirmación de una reserva por correo al contacto, con la marca y el correo del nodo de la
 * reserva (`tenantId`). La usan Reservas de la agencia —al crear la reserva y al reenviarla— y
 * Reservas de la red, cuando el superadmin la reenvía por la agencia.
 *
 * Antes vivía dentro de `OrdersController`; salió de ahí para que el reenvío del superadmin siga
 * exactamente las mismas reglas y la misma plantilla que el de la agencia.
 */
@Injectable()
export class OrderConfirmationService {
  constructor(
    private readonly mailer: MailerService,
    private readonly branding: BrandingService,
    private readonly hotelReads: HotelOrderReadsService,
  ) {}

  /**
   * Manda la confirmación, sin reglas: quien llama ya decidió que corresponde. Sin correo de
   * contacto no manda nada (`sent: false`).
   */
  async send(tenantId: string, order: OrderRow): Promise<OrderConfirmationSent> {
    const to = contactEmail(order);
    if (!to) return { sent: false, to };
    const brand = await this.branding.resolve(tenantId);
    // Una reserva de hotel lleva su plantilla: la estadía, el localizador y, si la tarifa no es
    // reembolsable, el aviso con el 100 %. La de vuelos hablaría de una ruta vacía.
    const mail = this.hotelReads.handles(order.provider)
      ? hotelOrderConfirmationEmailHtml({
          orderNumber: order.order_number,
          locator: order.provider_order_id,
          searchCriteria: order.search_criteria,
          selectedOffer: order.selected_offer,
          passengers: order.passengers,
          totalAmount: order.total_amount,
          currency: order.currency,
          brand,
        })
      : // Sólo llega aquí una de prueba si alguien la reenvió a mano: asunto «[PRUEBA] » y el aviso
        // de que no es un tiquete válido para viajar.
        flightOrderConfirmationMail(order, brand);
    const sent = await this.mailer.sendToTenant(tenantId, {
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    return { sent, to };
  }

  /**
   * El reenvío que pide una persona (`POST …/send-confirmation`), con sus reglas: la reserva tiene
   * correo de contacto (404) y existe del lado del proveedor (409).
   */
  async resend(tenantId: string, order: OrderRow): Promise<OrderConfirmationSent> {
    if (!contactEmail(order)) {
      throw new NotFoundException('La reserva no tiene email de contacto');
    }
    // Sólo hay algo que confirmar si la reserva existe del lado del proveedor. Una pendiente,
    // fallida o cancelada no se «reenvía»: se le mentiría al cliente con su total.
    if (order.status !== 'confirmed' && order.status !== 'ticketed') {
      throw new ConflictException(
        'Sólo se puede enviar la confirmación de una reserva confirmada o emitida.',
      );
    }
    return this.send(tenantId, order);
  }
}
