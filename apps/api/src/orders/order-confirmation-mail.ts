import type { BrandingService } from '../branding/branding.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { orderConfirmationEmailHtml, type EmailBrand } from '../mail/templates.js';
import { isTestSelectedOffer } from '../providers/provider-environment.js';
import type { OrderRow } from './orders.service.js';

/*
 * La confirmación por correo de una reserva de VUELO, en un solo lugar: la manda el controlador
 * (al crear la reserva y cuando el vendedor la reenvía) y la emisión de tiquetes cuando la reserva
 * queda emitida. Dos copias de esto se desincronizan, y la que se queda atrás es la que le escribe
 * «¡Tu billete está emitido!» a un pasajero con un localizador de pruebas.
 */

/**
 * ¿La orden es una reserva de la cuenta de pruebas del proveedor?
 *
 * Lo lee de `selected_offer.provider.environment`, que escribe el servidor al crear la orden desde
 * la cuenta resuelta (nunca el navegador). Una reserva de prueba no genera un tiquete válido: no se
 * le confirma al pasajero por correo sin que el vendedor lo pida, y si lo pide va marcada.
 */
export function isTestContentOrder(row: Pick<OrderRow, 'selected_offer'>): boolean {
  return isTestSelectedOffer(row.selected_offer);
}

/** El correo de contacto de la reserva, o `''` si no tiene. */
export function orderContactEmail(order: Pick<OrderRow, 'contact_info'>): string {
  const ci = order.contact_info;
  if (ci && typeof ci === 'object' && 'email' in ci) {
    const email = (ci as { email?: unknown }).email;
    return typeof email === 'string' ? email : '';
  }
  return '';
}

/**
 * El correo de confirmación de una reserva de vuelo. «Billete emitido» sólo con la orden en
 * `ticketed`; una de prueba sale con «[PRUEBA]» en el asunto y el aviso de que no sirve para viajar.
 */
export function flightOrderConfirmationMail(
  order: Pick<
    OrderRow,
    | 'order_number'
    | 'provider_order_id'
    | 'search_criteria'
    | 'passengers'
    | 'total_amount'
    | 'currency'
    | 'status'
    | 'selected_offer'
  >,
  brand: EmailBrand | null | undefined,
): { subject: string; html: string; text: string } {
  return orderConfirmationEmailHtml({
    orderNumber: order.order_number,
    pnr: order.provider_order_id,
    searchCriteria: order.search_criteria,
    passengers: order.passengers,
    totalAmount: order.total_amount,
    currency: order.currency,
    brand,
    ticketed: order.status === 'ticketed',
    testContent: isTestContentOrder(order),
  });
}

/**
 * La confirmación AUTOMÁTICA de una reserva de vuelo emitida. No sale con una reserva de prueba: el
 * pasajero recibiría un tiquete que no le sirve para viajar (el vendedor la puede reenviar a mano,
 * marcada). Devuelve si se mandó; nunca lanza por el correo.
 */
export async function sendAutomaticFlightConfirmation(
  deps: { readonly mailer: MailerService; readonly branding: BrandingService },
  tenantId: string,
  order: OrderRow,
): Promise<boolean> {
  if (isTestContentOrder(order)) return false;
  const to = orderContactEmail(order);
  if (!to) return false;
  const brand = await deps.branding.resolve(tenantId);
  const mail = flightOrderConfirmationMail(order, brand);
  return deps.mailer.sendToTenant(tenantId, {
    to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
}
