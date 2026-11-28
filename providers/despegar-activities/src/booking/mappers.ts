import type { BookInvoice, BookRequest } from '@sales-travel/despegar-hotels';
import { amount, money, str } from '../search/common';
import type {
  ActivityBookRequest,
  ActivityExchangePolicy,
  ActivityHint,
  ActivityPrebook,
  ActivityReservation,
} from '../types';

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

// ───────────────────────── Prebook ─────────────────────────

/**
 * Cuerpo de `POST /prebook` para una actividad. La certificación pide validar las políticas de
 * cambio y los hints: se piden siempre los dos.
 */
export function buildActivityPrebookBody(
  choiceId: string,
  lang: 'es' | 'pt' | 'en' = 'es',
): Record<string, unknown> {
  return { choice_id: choiceId, lang, include: ['EXCHANGE_POLICIES', 'HINTS'] };
}

function mapPolicy(p: Obj): ActivityExchangePolicy {
  const summary = obj(p['summary']);
  const productType = str(p['product_type']);
  const title = str(p['product_title']);
  return {
    conditions: arr(p['conditions']).map((c) => {
      const t = str(c['title']);
      return {
        ...(t ? { title: t } : {}),
        answers: arr(c['question_and_answer']).map((qa) => {
          const question = str(qa['question']);
          const answer = str(qa['answer']);
          return { ...(question ? { question } : {}), ...(answer ? { answer } : {}) };
        }),
      };
    }),
    disclaimers: [...arr(p['disclaimers']), ...arr(summary['disclaimers'])].map((d) => {
      const t = str(d['title']);
      const description = str(d['description']);
      return { ...(t ? { title: t } : {}), ...(description ? { description } : {}) };
    }),
    summaries: arr(summary['operations_summaries']).map((s) => {
      const t = str(s['title']);
      const description = str(s['description']);
      const permit = s['permit'];
      return {
        ...(t ? { title: t } : {}),
        ...(description ? { description } : {}),
        ...(typeof permit === 'boolean' || typeof permit === 'string' ? { permit } : {}),
      };
    }),
    ...(productType ? { productType } : {}),
    ...(title ? { title } : {}),
  };
}

/** Aplana un hint (`{ form: { travelers: { hint_type, validations[] } } }`) a renglones legibles. */
function flattenHint(node: unknown, path: string, out: string[]): void {
  if (out.length >= 50) return;
  if (Array.isArray(node)) {
    node.forEach((n) => flattenHint(n, path, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Obj))
      flattenHint(v, path ? `${path}.${k}` : k, out);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    out.push(`${path}: ${String(node)}`);
  }
}

/**
 * `extended_info.exchange_policies` es un objeto por clave de producto (`K0` actividades según la
 * tabla, `F0` en el esquema; sin verificar): se leen todas las claves.
 */
export function mapActivityPrebook(raw: unknown): ActivityPrebook {
  const r = obj(raw);
  const prebookId = str(r['prebook_id']) ?? '';
  const currency = str(r['currency']);
  const info = obj(r['extended_info']);
  const exchangePolicies = Object.values(obj(info['exchange_policies'])).map((p) =>
    mapPolicy(obj(p)),
  );
  const hints: ActivityHint[] = arr(info['hints']).map((h) => {
    const requirements: string[] = [];
    flattenHint(h['hint'], '', requirements);
    const modality = str(h['modality']);
    const paymentOption = str(h['payment_option']);
    return {
      requirements,
      ...(modality ? { modality } : {}),
      ...(paymentOption ? { paymentOption } : {}),
    };
  });
  const out: ActivityPrebook = { prebookId, exchangePolicies, hints };
  const expiresAt = str(r['expiration']);
  if (expiresAt) out.expiresAt = expiresAt;
  const status = str(r['status']);
  if (status) out.status = status;
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    if (r['total'] !== undefined) out.total = money(r['total'], currency);
    const c = obj(r['commission']);
    if (Object.keys(c).length > 0) {
      out.commission = {
        ...(c['amount'] !== undefined ? { amount: money(c['amount'], currency) } : {}),
        ...(c['min_amount'] !== undefined ? { min: money(c['min_amount'], currency) } : {}),
        ...(c['max_amount'] !== undefined ? { max: money(c['max_amount'], currency) } : {}),
      };
    }
  }
  return out;
}

// ───────────────────────── Book ─────────────────────────

/**
 * El book de una actividad con la forma COMPARTIDA de `POST /book` (el builder de hoteles):
 * cuenta corriente, todos los participantes y el titular en la referencia 0. No hay tarjeta: la
 * plataforma no implementa ONE_CARD para actividades (PCI SAQ-A).
 */
export function toActivityBookRequest(
  req: ActivityBookRequest,
  invoice: BookInvoice | undefined,
): BookRequest {
  return {
    prebookId: req.prebookId,
    externalBookingReference: req.externalBookingReference,
    modality: 'PAYINADVANCE',
    contact: req.contact,
    travelers: req.travelers.map((t, i) => ({
      referenceId: String(i),
      firstName: t.firstName,
      lastName: t.lastName,
      birthDate: t.birthDate,
      ...(t.nationality ? { nationality: t.nationality.toUpperCase() } : {}),
      ...(t.gender ? { gender: t.gender } : {}),
      ...(t.identification ? { identification: t.identification } : {}),
    })),
    payment: {
      optionType: 'CURRENT_ACCOUNT',
      units: [{ type: 'CURRENT_ACCOUNT' }],
      invoices: invoice ? [invoice] : [],
    },
  };
}

// ───────────────────────── Post-venta ─────────────────────────

const STATUSES = new Set(['IN_PROCESS', 'ISSUED', 'CANCELLED']);

/** Resuelve la URL del voucher contra el host de la cuenta. Sólo https. */
export function absoluteVoucherUrl(raw: unknown, baseUrl: string): string | undefined {
  const s = str(raw);
  if (!s) return undefined;
  try {
    const url = new URL(s, new URL(baseUrl).origin);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Los productos TICKET/TOUR de `/reservations`. */
export function mapActivityReservations(raw: unknown, baseUrl: string): ActivityReservation[] {
  return arr(obj(raw)['items']).flatMap((item) => {
    const p = obj(item['product']);
    const productType = (str(p['product_type']) ?? '').toUpperCase();
    if (productType !== 'TICKET' && productType !== 'TOUR') return [];
    const productId = str(p['product_id']);
    if (!productId) return [];
    const rawStatus = str(p['status']) ?? '';
    const sale = obj(p['sale_price']);
    const saleCurrency = str(sale['currency']);
    const policy = obj(p['cancellation_policy']);
    const voucherUrl = absoluteVoucherUrl(
      p['download_voucher_url'] ?? item['download_voucher_url'],
      baseUrl,
    );
    const duration = Math.trunc(amount(p['duration']));
    const out: ActivityReservation = {
      productId,
      productType,
      status: STATUSES.has(rawStatus) ? (rawStatus as ActivityReservation['status']) : 'UNKNOWN',
      rawStatus,
      highlights: Array.isArray(p['highlights'])
        ? p['highlights'].filter((h): h is string => typeof h === 'string')
        : [],
      passengers: arr(p['passengers']).map((x) => {
        const type = str(x['type']);
        const firstName = str(x['first_name']);
        const lastName = str(x['last_name']);
        return {
          ...(type ? { type } : {}),
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
        };
      }),
    };
    const set = <K extends keyof ActivityReservation>(
      k: K,
      v: ActivityReservation[K] | undefined,
    ) => {
      if (v !== undefined) out[k] = v;
    };
    set('transactionId', str(p['transaction_id']));
    set('reservationId', str(p['reservation_id']));
    set('pnr', str(p['pnr']));
    set('purchaseDateTime', str(p['purchase_date_time']));
    set(
      'salePrice',
      saleCurrency && /^[A-Za-z]{3}$/.test(saleCurrency)
        ? money(sale['price'], saleCurrency)
        : undefined,
    );
    set('useDate', str(p['use_date']));
    set('useExpirationDate', str(p['use_expiration_date']));
    set('durationDays', duration > 0 ? duration : undefined);
    set('ticketType', str(p['ticket_type']));
    set(
      'cancellationRefundable',
      typeof policy['cancellable'] === 'boolean' ? policy['cancellable'] : undefined,
    );
    set('voucherUrl', voucherUrl);
    return [out];
  });
}
