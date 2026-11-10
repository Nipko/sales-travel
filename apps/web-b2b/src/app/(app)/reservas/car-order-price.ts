/** Un monto en unidades menores con su moneda. */
interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Lo que guarda la reserva de auto (`cars.service.ts`, `persistOrder`). Todo opcional: las viejas no lo traen. */
export interface CarOrderPriceInput {
  readonly totalAmount: number;
  readonly currency: string;
  /** El JSON guardado: se lee campo a campo, sin confiar en su forma. */
  readonly selectedOffer?: object | null;
}

export interface CarOrderPrice {
  readonly total: Money;
  /** Lo que se pagó al reservar: el total menos lo del mostrador. Ausente si todo es en destino. */
  readonly payNow?: Money;
  /** Lo que se paga en el mostrador de la arrendadora. */
  readonly atCounter?: Money;
  readonly counterCharges: readonly { name: string; amount: Money }[];
}

function moneyOf(value: unknown): Money | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const amountMinor = record['amountMinor'];
  const currency = record['currency'];
  return typeof amountMinor === 'number' &&
    Number.isFinite(amountMinor) &&
    typeof currency === 'string'
    ? { amountMinor, currency }
    : undefined;
}

/**
 * El precio de una reserva de auto como se vio al reservar: lo que se pagó al reservar y lo que se
 * paga en el mostrador, con los cargos que informó la arrendadora.
 *
 * Misma regla que el checkout (`car-checkout-model.ts`, `priceBreakdown`): lo del mostrador pasa tal
 * cual porque lo cobra la arrendadora, y el markup queda en lo que se paga al reservar. En pago en
 * destino (`pod`) todo se paga en el mostrador. Una reserva anterior a que se guardara el reparto
 * sólo muestra el total.
 */
export function carOrderPrice(order: CarOrderPriceInput): CarOrderPrice {
  const total: Money = { amountMinor: order.totalAmount, currency: order.currency };
  const offer = (order.selectedOffer ?? {}) as Readonly<Record<string, unknown>>;
  const charges = Array.isArray(offer['counterCharges'])
    ? (offer['counterCharges'] as unknown[]).flatMap((charge: unknown) => {
        if (typeof charge !== 'object' || charge === null) return [];
        const record = charge as Record<string, unknown>;
        const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
        const amount = moneyOf(record['amount']);
        return name && amount && amount.amountMinor > 0 ? [{ name, amount }] : [];
      })
    : [];

  if (offer['paymentType'] === 'pod') return { total, atCounter: total, counterCharges: charges };

  const tax = moneyOf(offer['tax']);
  if (tax === undefined || tax.currency !== total.currency || tax.amountMinor <= 0) {
    return { total, counterCharges: [] };
  }
  const atCounterMinor = Math.min(tax.amountMinor, total.amountMinor);
  return {
    total,
    payNow: { amountMinor: total.amountMinor - atCounterMinor, currency: total.currency },
    atCounter: { amountMinor: atCounterMinor, currency: total.currency },
    counterCharges: charges,
  };
}
