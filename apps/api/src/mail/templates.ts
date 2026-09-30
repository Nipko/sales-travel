// Plantillas HTML de notificaciones (cotización / confirmación de reserva). Sin imágenes externas;
// estilos inline para máxima compatibilidad con clientes de correo.

function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}
function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Marca a aplicar al correo. Es la identidad EFECTIVA del tenant (BrandingService),
 * o sea la propia o la heredada de su cadena de ancestros.
 */
export interface EmailBrand {
  name: string;
  color: string | null;
}

/** Índigo de la plataforma, sólo si el tenant no tiene marca resoluble. */
const FALLBACK_COLOR = '#4f46e5';
const HEX = /^#[0-9a-fA-F]{6}$/;

function layout(heading: string, bodyHtml: string, brand?: EmailBrand | null): string {
  // Re-validado acá aunque BrandingService ya filtre: esto se interpola en un style.
  const color = brand?.color && HEX.test(brand.color) ? brand.color : FALLBACK_COLOR;
  // Este correo lo recibe el CLIENTE FINAL, así que la firma es la de SU agencia.
  // Antes decía siempre "vía PlaneTour", filtrando la marca del consolidador.
  const signature = brand?.name ? `Enviado por ${esc(brand.name)}` : 'Enviado por tu agencia';

  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden">
        <tr><td style="background:${color};padding:18px 28px"><span style="color:#fff;font-size:16px;font-weight:700">${esc(heading)}</span></td></tr>
        <tr><td style="padding:28px">${bodyHtml}</td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#a1a1aa">${signature}</p>
    </td></tr>
  </table>
</body></html>`;
}

function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 0;font-size:13px;color:#71717a">${esc(label)}</td>
    <td style="padding:6px 0;font-size:13px;color:#18181b;font-weight:600;text-align:right">${esc(value)}</td>
  </tr>`;
}

export function quotationEmailHtml(input: {
  quoteNumber: number;
  customerName: string | null;
  searchCriteria: unknown;
  selectedOffer: unknown;
  brand?: EmailBrand | null;
}): { subject: string; html: string; text: string } {
  const sc = obj(input.searchCriteria);
  const offer = obj(input.selectedOffer);
  const total = obj(offer['total']);
  const pricing = obj(offer['pricing']);
  const fareFamily = obj(offer['fareFamily']);
  const currency = s(total['currency']) || 'USD';
  const finalMinor = num(pricing['finalMinor']) || num(total['amountMinor']);
  const route = `${s(sc['origin'])} → ${s(sc['destination'])}`;
  const dates = s(sc['returnDate'])
    ? `${s(sc['departureDate'])} – ${s(sc['returnDate'])}`
    : s(sc['departureDate']);
  const fare = s(fareFamily['name']) || 'Estándar';
  const price = money(finalMinor, currency);
  const hello = input.customerName ? `Hola ${esc(input.customerName)},` : 'Hola,';

  const body = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3f3f46">${hello}<br>Te compartimos tu cotización de vuelo:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f4f4f5;border-bottom:1px solid #f4f4f5;margin-bottom:18px">
      ${row('Cotización', `#${input.quoteNumber}`)}
      ${row('Ruta', route)}
      ${row('Fechas', dates)}
      ${row('Tarifa', fare)}
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;border-radius:10px;margin-bottom:18px">
      <tr><td style="padding:14px 18px">
        <span style="font-size:12px;color:#71717a">Precio total</span><br>
        <span style="font-size:24px;font-weight:800;color:#18181b">${esc(price)}</span>
      </td></tr>
    </table>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#a1a1aa">La tarifa está sujeta a disponibilidad y puede cambiar. Respondé este correo para confirmar tu reserva.</p>`;

  return {
    subject: `Tu cotización de vuelo #${input.quoteNumber} · ${route}`,
    html: layout('Cotización de vuelo', body, input.brand),
    text: `Cotización #${input.quoteNumber}\nRuta: ${route}\nFechas: ${dates}\nTarifa: ${fare}\nTotal: ${price}\n\nLa tarifa puede cambiar. Respondé para reservar.`,
  };
}

export function orderConfirmationEmailHtml(input: {
  orderNumber: number;
  pnr: string | null;
  searchCriteria: unknown;
  passengers: unknown;
  totalAmount: number;
  currency: string;
  brand?: EmailBrand | null;
  /**
   * `true` sólo con billete emitido. Una reserva sin billete NO está confirmada para el pasajero:
   * la tarifa puede caerse antes de emitir, y «¡Tu reserva está confirmada!» es la promesa que se
   * descubre rota en el mostrador.
   */
  ticketed?: boolean;
}): { subject: string; html: string; text: string } {
  const sc = obj(input.searchCriteria);
  const ticketed = input.ticketed === true;
  const intro = ticketed
    ? '¡Tu billete está emitido! Estos son los detalles:'
    : 'Tu reserva está hecha y el billete todavía no se emitió: la tarifa y los asientos se garantizan al emitir. Estos son los detalles:';
  const titulo = ticketed ? 'Billete emitido' : 'Reserva registrada';
  const route = `${s(sc['origin'])} → ${s(sc['destination'])}`;
  const dates = s(sc['returnDate'])
    ? `${s(sc['departureDate'])} – ${s(sc['returnDate'])}`
    : s(sc['departureDate']);
  const price = money(input.totalAmount, input.currency);
  const paxArr = Array.isArray(input.passengers) ? input.passengers : [];
  const paxNames = paxArr
    .map((p) => {
      const po = obj(p);
      return `${s(po['givenName'])} ${s(po['surname'])}`.trim();
    })
    .filter(Boolean)
    .join(', ');

  const body = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3f3f46">${intro}</p>
    ${
      input.pnr
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;margin-bottom:18px">
      <tr><td style="padding:14px 18px;text-align:center">
        <span style="font-size:12px;color:#047857">Código de reserva (PNR)</span><br>
        <span style="font-size:24px;font-weight:800;letter-spacing:2px;color:#065f46;font-family:monospace">${esc(input.pnr)}</span>
      </td></tr>
    </table>`
        : ''
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f4f4f5;border-bottom:1px solid #f4f4f5;margin-bottom:18px">
      ${row('Reserva', `#${input.orderNumber}`)}
      ${row('Ruta', route)}
      ${row('Fechas', dates)}
      ${paxNames ? row('Pasajeros', paxNames) : ''}
      ${row('Total', price)}
    </table>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#a1a1aa">Guardá este correo. Para cambios o consultas, respondé a tu agencia.</p>`;

  return {
    subject: `${titulo} #${input.orderNumber}${input.pnr ? ` · PNR ${input.pnr}` : ''}`,
    html: layout(titulo, body, input.brand),
    text: `Reserva #${input.orderNumber}${input.pnr ? ` · PNR ${input.pnr}` : ''}\nRuta: ${route}\nFechas: ${dates}\n${paxNames ? `Pasajeros: ${paxNames}\n` : ''}Total: ${price}`,
  };
}

// ───────────────────────── Reserva de hotel ─────────────────────────

/**
 * El importe EXACTO, con sus centavos: el aviso de no reembolsable dice cuánto se pierde, y
 * `money` redondea a la unidad (US$ 321,34 saldría US$ 321).
 */
function exactMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/** "12 oct 2026", sin depender de la zona del servidor: la fecha de la estadía es de calendario. */
function stayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('es', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(date)
    .replace(/\./g, '');
}

/** ¿La orden es de una tarifa no reembolsable? Lo que guardó al reservar, o la política declarada. */
export function hotelOrderIsNonRefundable(selectedOffer: unknown): boolean {
  const offer = obj(selectedOffer);
  if (Object.keys(obj(offer['nonRefundable'])).length > 0) return true;
  const cancellation = obj(obj(offer['roompack'])['cancellation']);
  return cancellation['refundable'] === false || cancellation['status'] === 'non_refundable';
}

function guestNames(passengers: unknown): string {
  const rooms: unknown[] = Array.isArray(passengers) ? passengers : [];
  return rooms
    .flatMap((room): unknown[] => {
      const guests = obj(room)['guests'];
      return Array.isArray(guests) ? (guests as unknown[]) : [];
    })
    .map((g) => `${s(obj(g)['firstName'])} ${s(obj(g)['lastName'])}`.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * La confirmación de una reserva de hotel al huésped. La de vuelos habla de ruta y PNR; ésta, de
 * la estadía, las habitaciones y el localizador del proveedor. Una tarifa no reembolsable lo dice
 * en un recuadro propio, con el monto (pedido del founder del 2026-09-29, punto d): el cliente
 * tiene que saber antes de pedir un cambio que no hay reembolso.
 */
export function hotelOrderConfirmationEmailHtml(input: {
  orderNumber: number;
  locator: string | null;
  searchCriteria: unknown;
  selectedOffer: unknown;
  passengers: unknown;
  totalAmount: number;
  currency: string;
  brand?: EmailBrand | null;
}): { subject: string; html: string; text: string } {
  const sc = obj(input.searchCriteria);
  const offer = obj(input.selectedOffer);
  const checkin = s(sc['checkinDate']) || s(offer['checkinDate']);
  const checkout = s(sc['checkoutDate']) || s(offer['checkoutDate']);
  const rooms = Array.isArray(obj(offer['roompack'])['rooms'])
    ? (obj(offer['roompack'])['rooms'] as unknown[]).map((r) => s(obj(r)['name'])).filter(Boolean)
    : [];
  const price = exactMoney(input.totalAmount, input.currency);
  const guests = guestNames(input.passengers);
  const nonRefundable = hotelOrderIsNonRefundable(input.selectedOffer);
  const nonRefundableText = `Si la reserva se cancela, se modifica o el huésped no se presenta, se cobra el 100 % (${price}) y no hay reembolso.`;

  const body = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3f3f46">Tu reserva de hotel está confirmada. Estos son los detalles:</p>
    ${
      input.locator
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;margin-bottom:18px">
      <tr><td style="padding:14px 18px;text-align:center">
        <span style="font-size:12px;color:#047857">Localizador de la reserva</span><br>
        <span style="font-size:22px;font-weight:800;letter-spacing:1px;color:#065f46;font-family:monospace">${esc(input.locator)}</span>
      </td></tr>
    </table>`
        : ''
    }
    ${
      nonRefundable
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #f59e0b;border-radius:10px;margin-bottom:18px">
      <tr><td style="padding:14px 18px">
        <span style="font-size:13px;font-weight:800;color:#92400e">Tarifa no reembolsable</span><br>
        <span style="font-size:13px;line-height:1.5;color:#78350f">${esc(nonRefundableText)}</span>
      </td></tr>
    </table>`
        : ''
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f4f4f5;border-bottom:1px solid #f4f4f5;margin-bottom:18px">
      ${row('Reserva', `#${input.orderNumber}`)}
      ${checkin ? row('Entrada', stayDate(checkin)) : ''}
      ${checkout ? row('Salida', stayDate(checkout)) : ''}
      ${rooms.length > 0 ? row(rooms.length === 1 ? 'Habitación' : 'Habitaciones', rooms.join(' · ')) : ''}
      ${guests ? row('Huéspedes', guests) : ''}
      ${row('Total', price)}
      ${row('Cancelación', nonRefundable ? 'No reembolsable' : 'Según la política de la reserva')}
    </table>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#a1a1aa">Guardá este correo. Para cambios o consultas, respondé a tu agencia.</p>`;

  const lines = [
    `Reserva de hotel #${input.orderNumber}${input.locator ? ` · Localizador ${input.locator}` : ''}`,
    checkin ? `Entrada: ${stayDate(checkin)}` : '',
    checkout ? `Salida: ${stayDate(checkout)}` : '',
    rooms.length > 0 ? `Habitaciones: ${rooms.join(' · ')}` : '',
    guests ? `Huéspedes: ${guests}` : '',
    `Total: ${price}`,
    nonRefundable ? `TARIFA NO REEMBOLSABLE. ${nonRefundableText}` : '',
  ].filter(Boolean);

  return {
    subject: `Reserva de hotel confirmada #${input.orderNumber}${nonRefundable ? ' · No reembolsable' : ''}`,
    html: layout('Reserva de hotel confirmada', body, input.brand),
    text: lines.join('\n'),
  };
}
