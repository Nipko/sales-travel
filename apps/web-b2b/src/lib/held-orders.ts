/**
 * Las reservas con saldo retenido en la cartera (vuelos y autos confirmados, a la espera de la
 * emisión), como las muestra Cartera B2B. Sin I/O: lee `GET /orders` sin confiar en su forma.
 */

export interface HeldOrder {
  readonly id: string;
  readonly orderNumber: number | null;
  readonly totalAmountMinor: number;
  readonly currency: string;
  readonly provider: string | null;
  readonly searchCriteria: unknown;
  readonly passengerNames: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** "Ana Pérez, Luis Gómez". Un JSON guardado como texto también se lee. */
export function passengerNames(passengers: unknown): string {
  let list: unknown = passengers;
  if (typeof passengers === 'string') {
    try {
      list = JSON.parse(passengers) as unknown;
    } catch {
      return 'Pasajeros';
    }
  }
  if (!Array.isArray(list)) return 'Pasajeros';
  const names = list
    .map((p) => {
      const r = asRecord(p);
      const first = typeof r?.['firstName'] === 'string' ? r['firstName'].trim() : '';
      const last = typeof r?.['lastName'] === 'string' ? r['lastName'].trim() : '';
      return `${first} ${last}`.trim();
    })
    .filter((n) => n !== '');
  return names.length > 0 ? names.join(', ') : 'Pasajeros';
}

/** Las órdenes con retención pendiente de emisión (`status: 'pending'`) de `GET /orders`. */
export function heldOrdersOf(value: unknown): HeldOrder[] {
  const list = asRecord(value)?.['orders'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const r = asRecord(item);
    if (r === undefined || r['status'] !== 'pending') return [];
    const id = r['id'];
    const total = r['totalAmount'];
    const currency = r['currency'];
    if (typeof id !== 'string' || typeof currency !== 'string') return [];
    if (typeof total !== 'number' || !Number.isSafeInteger(total)) return [];
    const orderNumber = r['orderNumber'];
    const provider = r['provider'];
    return [
      {
        id,
        orderNumber: typeof orderNumber === 'number' ? orderNumber : null,
        totalAmountMinor: total,
        currency,
        provider: typeof provider === 'string' ? provider : null,
        searchCriteria: r['searchCriteria'],
        passengerNames: passengerNames(r['passengers']),
      },
    ];
  });
}
