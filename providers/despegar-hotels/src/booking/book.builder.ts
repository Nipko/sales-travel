import type { BookInvoice, BookRequest } from './types';

function buildInvoice(inv: BookInvoice): Record<string, unknown> {
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
    fiscal_address: {
      street: inv.fiscalAddress.street,
      number: inv.fiscalAddress.number,
      apartment: inv.fiscalAddress.apartment,
      floor: inv.fiscalAddress.floor,
      neighborhood: inv.fiscalAddress.neighborhood,
      city_id: inv.fiscalAddress.cityId,
      zip_code: inv.fiscalAddress.zipCode,
    },
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
    payment: {
      option_type: req.payment.optionType,
      payment_units: req.payment.units.map((u) => ({
        type: u.type ?? req.payment.optionType,
        plan_id: u.planId,
        secure_token: u.secureToken,
        invoice_reference: u.invoiceReference,
        card_holder_identification: u.cardHolderIdentification
          ? { type: u.cardHolderIdentification.type, number: u.cardHolderIdentification.number }
          : undefined,
      })),
      invoices: req.payment.invoices?.map(buildInvoice),
    },
    context_information: req.context
      ? { client_ip: req.context.clientIp, user_agent: req.context.userAgent }
      : undefined,
    disable_sync_result: req.disableSyncResult,
  };
}
