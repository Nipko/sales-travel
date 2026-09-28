import type { HotelOrderSubStatus } from '../../database/database.types.js';
import type { Row } from '../../orders/__fixtures__/memory-orders-db.js';
import type {
  HotelBookingVerificationStore,
  HotelVerificationAdvance,
  HotelVerificationCalendar,
  HotelVerificationDueQuery,
  HotelVerificationPosition,
  HotelVerificationTarget,
} from '../hotel-booking-verification.store.js';

/**
 * Doble de `HotelBookingVerificationStore` sobre las filas de `orders` del doble de Postgres
 * (`orders/__fixtures__/memory-orders-db.ts`) y un mapa como `hotel_order_tracking`.
 *
 * Reproduce lo que decide los casos: el alcance por tenant, qué orden está abierta (`pending` y
 * `provider_raw` nulo), el filtro y el orden del barrido (vencidos y huérfanas, sólo hoteles con
 * referencia, por su hora programada) y los CAS —abrir el calendario sólo si no hay uno, y avanzar
 * o postergar sólo desde el paso guardado—.
 * El SQL real se prueba en `hotel-booking-verification.store.test.ts` y contra Postgres.
 */

export interface TrackingFila {
  tenantId: string;
  anchorAt: number | null;
  step: number | null;
  nextAt: number | null;
  subStatus: HotelOrderSubStatus | null;
  providerStatus: string | null;
  providerStatusAt: number | null;
}

type Metodo = 'findTarget' | 'listDue' | 'startCalendar' | 'advance' | 'postpone';

function epoch(value: unknown): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

function vertical(row: Row): unknown {
  const criteria = row['search_criteria'];
  const parsed: unknown = typeof criteria === 'string' ? JSON.parse(criteria) : criteria;
  return (parsed as { vertical?: unknown } | null)?.vertical;
}

export class MemoryVerificationStore implements Pick<HotelBookingVerificationStore, Metodo> {
  readonly tracking = new Map<string, TrackingFila>();
  /** Si se define, el método falla con este error (la base caída). */
  readonly fallas: Partial<Record<Metodo, Error>> = {};

  constructor(private readonly orders: () => Row[]) {}

  findTarget(tenantId: string, orderId: string): Promise<HotelVerificationTarget | undefined> {
    return this.run('findTarget', () => {
      const row = this.orders().find(
        (r) =>
          r['id'] === orderId &&
          r['tenant_id'] === tenantId &&
          r['provider_booking_ref'] !== null &&
          r['provider_booking_ref'] !== undefined,
      );
      return row === undefined ? undefined : this.target(row);
    });
  }

  listDue(tenantId: string, query: HotelVerificationDueQuery): Promise<HotelVerificationTarget[]> {
    return this.run('listDue', () =>
      this.orders()
        .filter(
          (r) =>
            r['tenant_id'] === tenantId &&
            r['status'] === 'pending' &&
            r['provider_raw'] === null &&
            typeof r['provider_booking_ref'] === 'string' &&
            vertical(r) === 'hotels',
        )
        .map((r) => this.target(r))
        .filter(
          (t) =>
            (t.nextAt !== null && t.nextAt <= query.dueBefore) ||
            (t.anchorAt === null && t.updatedAt <= query.orphanBefore),
        )
        .sort((a, b) => (a.nextAt ?? a.updatedAt) - (b.nextAt ?? b.updatedAt))
        .slice(0, query.limit),
    );
  }

  startCalendar(
    tenantId: string,
    orderId: string,
    calendar: HotelVerificationCalendar,
  ): Promise<boolean> {
    return this.run('startCalendar', () => {
      const actual = this.tracking.get(orderId);
      if (actual !== undefined && (actual.tenantId !== tenantId || actual.anchorAt !== null)) {
        return false;
      }
      this.tracking.set(orderId, {
        tenantId,
        providerStatus: null,
        providerStatusAt: null,
        ...actual,
        anchorAt: calendar.anchorAt,
        step: calendar.step,
        nextAt: calendar.nextAt,
        subStatus: 'create-uncertain',
      });
      return true;
    });
  }

  advance(
    tenantId: string,
    orderId: string,
    fromStep: number,
    next: HotelVerificationAdvance,
  ): Promise<boolean> {
    return this.run('advance', () => {
      const actual = this.tracking.get(orderId);
      if (actual === undefined || actual.tenantId !== tenantId || actual.step !== fromStep) {
        return false;
      }
      actual.step = next.step;
      actual.nextAt = next.nextAt;
      if (next.subStatus !== undefined) actual.subStatus = next.subStatus;
      if (next.providerStatus !== undefined) {
        actual.providerStatus = next.providerStatus.value;
        actual.providerStatusAt = next.providerStatus.at;
      }
      return true;
    });
  }

  postpone(
    tenantId: string,
    orderId: string,
    from: HotelVerificationPosition,
    nextAt: number,
  ): Promise<boolean> {
    return this.run('postpone', () => {
      const actual = this.tracking.get(orderId);
      if (
        actual === undefined ||
        actual.tenantId !== tenantId ||
        actual.anchorAt !== from.anchorAt ||
        actual.step !== from.step ||
        actual.nextAt === null
      ) {
        return false;
      }
      actual.nextAt = nextAt;
      return true;
    });
  }

  asStore(): HotelBookingVerificationStore {
    return this as unknown as HotelBookingVerificationStore;
  }

  private run<T>(metodo: Metodo, fn: () => T): Promise<T> {
    const falla = this.fallas[metodo];
    return falla === undefined ? Promise.resolve().then(fn) : Promise.reject(falla);
  }

  private target(row: Row): HotelVerificationTarget {
    const fila = this.tracking.get(String(row['id']));
    return {
      orderId: String(row['id']),
      provider: String(row['provider']),
      userId: String(row['user_id']),
      bookingReference: String(row['provider_booking_ref']),
      providerAccountId: (row['provider_account_id'] as string | null | undefined) ?? null,
      open: row['status'] === 'pending' && row['provider_raw'] === null,
      updatedAt: epoch(row['updated_at']),
      anchorAt: fila?.anchorAt ?? null,
      step: fila?.step ?? null,
      nextAt: fila?.nextAt ?? null,
    };
  }
}
