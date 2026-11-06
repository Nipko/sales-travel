/*
 * Pagar una reserva sin pagar con las formas de pago que el superadmin habilitó para la red
 * (`docs/platform/17-opciones-de-pago.md`). La pantalla sólo ofrece lo que devuelve
 * `GET /orders/:id/payment-options`; el API vuelve a comprobarlo al pagar (403 si no está habilitada).
 *
 * Aquí vive lo que no depende de React: leer la respuesta, ordenar y elegir la forma por defecto,
 * armar los cuerpos y traducir lo que responde el API a algo que el vendedor pueda leer.
 */

export type PaymentPciScope = 'none' | 'saq-a' | 'out-of-scope';

/** Las dos maneras de pagar una orden sin pagar que conoce la pantalla. */
export type OrderPaymentUse = 'order-pay' | 'order-payment-link';

export interface OrderPaymentMethod {
  readonly code: string;
  readonly use: OrderPaymentUse;
  readonly label: string;
  readonly description: string;
  readonly pci: PaymentPciScope;
}

export interface OrderPaymentOptions {
  readonly provider: string;
  readonly methods: readonly OrderPaymentMethod[];
}

/** `PaymentInfo.type` que espera `POST /orders/:id/pay` para cada forma sin tarjeta. */
export type AccountPaymentType = 'Cash' | 'GOV';

/** Código del catálogo de gobierno → `type` del cuerpo de `/pay`. La tarjeta tiene su formulario. */
const ORDER_PAY_TYPES: Readonly<Record<string, AccountPaymentType | 'Credit Card'>> = {
  cash: 'Cash',
  gov: 'GOV',
  card: 'Credit Card',
};

/**
 * Orden en que se ofrecen: primero lo que no pone una tarjeta en nuestro servidor (el enlace del
 * proveedor, luego las formas de agencia) y al final la tarjeta digitada, fuera de PCI SAQ-A.
 */
const DISPLAY_ORDER: readonly string[] = ['payment_link', 'cash', 'gov', 'card'];

/** Lo que el vendedor lee en cada tarjeta de opción. */
const CHOICE_LABELS: Readonly<Record<string, string>> = {
  payment_link: 'Enviar enlace de pago',
  cash: 'Efectivo / BSP',
  gov: 'GOV',
  card: 'Tarjeta',
};

export const PAYMENT_MESSAGES = {
  loading: 'Buscando las formas de pago habilitadas…',
  loadFailed: 'No pudimos cargar las formas de pago. Cierra y vuelve a intentarlo en unos minutos.',
  none: 'Tu red no tiene formas de pago habilitadas para este proveedor. Pide al administrador de la plataforma que las habilite.',
  linkExplain:
    'LATAM le envía un enlace al pagador para pagar en su sitio; la tarjeta no pasa por la plataforma.',
  invalidEmail: 'Escribe un correo válido para enviar el enlace.',
  cardOutOfScope:
    'El número y el CVV de la tarjeta pasan por la plataforma hacia la aerolínea. Si puedes, usa el enlace de pago.',
  accountNote: 'Se registra el pago con la cuenta de tu agencia, por el total de la reserva.',
  sendFailed:
    'No pudimos confirmar el envío. Revisa la reserva con «Consultar estado» antes de repetir.',
  payFailed: 'No se pudo procesar el pago.',
  paid: 'Pago procesado exitosamente',
  forbidden: 'Esta forma de pago no está habilitada para tu red.',
} as const;

export function linkSentMessage(email: string): string {
  return `Enlace enviado a ${email}. Cuando el cliente pague, usa «Consultar estado» para ver la reserva emitida.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPci(value: unknown): value is PaymentPciScope {
  return value === 'none' || value === 'saq-a' || value === 'out-of-scope';
}

/** Una forma que la pantalla sabe cobrar; cualquier otra se descarta en vez de ofrecer algo roto. */
function methodOf(raw: unknown): OrderPaymentMethod | null {
  if (!isRecord(raw)) return null;
  const { code, use, label, description, pci } = raw;
  if (typeof code !== 'string' || code === '') return null;
  if (use === 'order-payment-link') {
    if (code !== 'payment_link') return null;
  } else if (use === 'order-pay') {
    if (ORDER_PAY_TYPES[code] === undefined) return null;
  } else {
    return null;
  }
  return {
    code,
    use,
    label: typeof label === 'string' ? label : code,
    description: typeof description === 'string' ? description : '',
    pci: isPci(pci) ? pci : 'none',
  };
}

function rank(code: string): number {
  const i = DISPLAY_ORDER.indexOf(code);
  return i === -1 ? DISPLAY_ORDER.length : i;
}

/** La respuesta de `payment-options`, ordenada y sin duplicados; `null` si no se puede leer. */
export function parsePaymentOptions(raw: unknown): OrderPaymentOptions | null {
  if (!isRecord(raw) || !Array.isArray(raw['methods'])) return null;
  const seen = new Set<string>();
  const methods: OrderPaymentMethod[] = [];
  for (const item of raw['methods']) {
    const method = methodOf(item);
    if (method === null || seen.has(method.code)) continue;
    seen.add(method.code);
    methods.push(method);
  }
  methods.sort((a, b) => rank(a.code) - rank(b.code));
  return {
    provider: typeof raw['provider'] === 'string' ? raw['provider'] : '',
    methods,
  };
}

/** La primera en el orden de la pantalla: la que menos expone la tarjeta. */
export function defaultPaymentMethod(methods: readonly OrderPaymentMethod[]): string | null {
  return methods[0]?.code ?? null;
}

export function choiceLabel(method: OrderPaymentMethod): string {
  return CHOICE_LABELS[method.code] ?? method.label;
}

/** Qué formulario pinta cada forma. */
export type PaymentChoiceKind = 'link' | 'account' | 'card';

export function choiceKind(method: OrderPaymentMethod): PaymentChoiceKind {
  if (method.use === 'order-payment-link') return 'link';
  return method.code === 'card' ? 'card' : 'account';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** El correo como lo valida el API (recortado, con forma de correo, ≤ 254); `null` si no sirve. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export function paymentLinkBody(email: string): { email: string } | null {
  const clean = normalizeEmail(email);
  return clean === null ? null : { email: clean };
}

export interface AccountPaymentBody {
  readonly payment: {
    readonly type: AccountPaymentType;
    readonly amount: number;
    readonly currency: string;
  };
}

/** Cuerpo de `/pay` para efectivo o GOV: sin tarjeta, por el total y la moneda de la orden. */
export function accountPaymentBody(
  code: string,
  order: { readonly totalAmount: number; readonly currency: string },
): AccountPaymentBody | null {
  const type = ORDER_PAY_TYPES[code];
  if (type !== 'Cash' && type !== 'GOV') return null;
  return { payment: { type, amount: order.totalAmount, currency: order.currency } };
}

/** El texto de error de un cuerpo de Nest (`message`, a veces lista) o del proxy (`error`). */
export function errorMessageOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const message = body['message'] ?? body['error'];
  if (typeof message === 'string' && message.trim() !== '') return message.trim();
  if (Array.isArray(message)) {
    const parts = message.filter((m): m is string => typeof m === 'string' && m.trim() !== '');
    if (parts.length > 0) return parts.join('. ');
  }
  return null;
}

/** Un mensaje del API que el vendedor pueda leer; los genéricos de Nest se cambian por uno en tú. */
function rejectionMessage(status: number, body: unknown, fallback: string): string {
  const message = errorMessageOf(body);
  if (status === 403 && (message === null || message === 'Forbidden')) {
    return PAYMENT_MESSAGES.forbidden;
  }
  return message ?? fallback;
}

export type PaymentOutcome =
  | { readonly ok: true; readonly warnings: readonly string[]; readonly status?: string }
  | { readonly ok: false; readonly message: string };

function warningsOf(body: Record<string, unknown>): string[] {
  const raw = body['warnings'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w) => {
    if (typeof w === 'string') return [w];
    if (isRecord(w) && typeof w['message'] === 'string') return [w['message']];
    return [];
  });
}

/** Lo que respondió `POST /payment-link`: enviado, o por qué no. */
export function paymentLinkOutcomeOf(status: number, body: unknown): PaymentOutcome {
  if (status >= 200 && status < 300 && isRecord(body)) {
    if (body['success'] === true) return { ok: true, warnings: warningsOf(body) };
    return { ok: false, message: errorMessageOf(body) ?? PAYMENT_MESSAGES.sendFailed };
  }
  return { ok: false, message: rejectionMessage(status, body, PAYMENT_MESSAGES.sendFailed) };
}

/** Lo que respondió `POST /pay`: pagado (con el estado nuevo, si vino), o por qué no. */
export function payOutcomeOf(status: number, body: unknown): PaymentOutcome {
  if (status >= 200 && status < 300 && isRecord(body)) {
    if (body['success'] === true) {
      const next = body['status'];
      return typeof next === 'string'
        ? { ok: true, warnings: warningsOf(body), status: next }
        : { ok: true, warnings: warningsOf(body) };
    }
    return { ok: false, message: errorMessageOf(body) ?? PAYMENT_MESSAGES.payFailed };
  }
  return { ok: false, message: rejectionMessage(status, body, PAYMENT_MESSAGES.payFailed) };
}
