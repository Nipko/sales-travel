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
}): { subject: string; html: string; text: string } {
  const sc = obj(input.searchCriteria);
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
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3f3f46">¡Tu reserva está confirmada! Estos son los detalles:</p>
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
    subject: `Reserva confirmada #${input.orderNumber}${input.pnr ? ` · PNR ${input.pnr}` : ''}`,
    html: layout('Reserva confirmada', body, input.brand),
    text: `Reserva #${input.orderNumber}${input.pnr ? ` · PNR ${input.pnr}` : ''}\nRuta: ${route}\nFechas: ${dates}\n${paxNames ? `Pasajeros: ${paxNames}\n` : ''}Total: ${price}`,
  };
}
