import type { BookInvoice, BookPayment, BookPaymentUnit, BookRequest } from './types';

function buildInvoice(inv: BookInvoice): Record<string, unknown> {
  const address = inv.fiscalAddress;
  return {
    reference: inv.reference,
    fiscal_name: inv.fiscalName,
    first_name: inv.firstName,
    last_name: inv.lastName,
    fiscal_status: inv.fiscalStatus,
    fiscal_identification: {
      type: inv.fiscalIdentification.type,
      number: inv.fiscalIdentification.number,
      issue_country: inv.fiscalIdentification.issueCountry,
      expiration_date: inv.fiscalIdentification.expirationDate,
    },
    fiscal_address: address
      ? {
          street: address.street,
          number: address.number,
          apartment: address.apartment,
          floor: address.floor,
          // Así lo escribe Despegar (inglés británico).
          neighbourhood: address.neighborhood,
          city_id: address.cityId,
          zip_code: address.zipCode,
        }
      : undefined,
  };
}

/**
 * Una unidad de pago con la forma que pide cada `option_type` (docs/despegar/01 § Book):
 * cuenta corriente sólo el tipo, diferido el plan, tarjeta el plan, el token y el titular.
 */
function buildUnit(optionType: string, u: BookPaymentUnit): Record<string, unknown> {
  if (optionType === 'CURRENT_ACCOUNT') return { type: u.type ?? 'CURRENT_ACCOUNT' };
  if (optionType === 'DEFERRED') return { type: u.type ?? 'DEFERRED', plan_id: u.planId };
  return {
    type: u.type ?? optionType,
    plan_id: u.planId,
    secure_token: u.secureToken,
    invoice_reference: u.invoiceReference,
    card_holder_identification: u.cardHolderIdentification
      ? { type: u.cardHolderIdentification.type, number: u.cardHolderIdentification.number }
      : undefined,
  };
}

function buildPayment(payment: BookPayment): Record<string, unknown> {
  const units = payment.units.length > 0 ? payment.units : [{}];
  return {
    option_type: payment.optionType,
    payment_units: units.map((u) => buildUnit(payment.optionType, u)),
    // El diferido no lleva facturas: se emiten cuando se paga.
    invoices: payment.optionType === 'DEFERRED' ? undefined : payment.invoices?.map(buildInvoice),
  };
}

/**
 * Cuerpo del POST /book. Normaliza camelCase → snake_case. JSON.stringify descarta las claves
 * `undefined`, así que los campos opcionales ausentes no se envían. El `secure_token` proviene de
 * la tokenización hosted (PCI SAQ-A): aquí nunca circula PAN/CVV.
 */
export function buildBookBody(req: BookRequest): Record<string, unknown> {
  return {
    prebook_id: req.prebookId,
    external_booking_reference: req.externalBookingReference,
    modality: req.modality ?? 'PAYINADVANCE',
    contact_data: {
      email: req.contact.email,
      phones: (req.contact.phones ?? []).map((p) => ({
        country_code: p.countryCode,
        area_code: p.areaCode,
        number: p.number,
        type: p.type,
      })),
    },
    travelers: req.travelers.map((t) => ({
      traveler_reference_id: t.referenceId,
      first_name: t.firstName,
      last_name: t.lastName,
      gender: t.gender,
      nationality: t.nationality,
      birth_date: t.birthDate,
      identification: t.identification
        ? {
            type: t.identification.type,
            number: t.identification.number,
            issue_country: t.identification.issueCountry,
          }
        : undefined,
    })),
    payment: buildPayment(req.payment),
    context_information: req.context
      ? { client_ip: req.context.clientIp, user_agent: req.context.userAgent }
      : undefined,
    disable_sync_result: req.disableSyncResult,
  };
}
