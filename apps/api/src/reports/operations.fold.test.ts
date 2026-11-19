import { describe, expect, it } from 'vitest';
import { OPERATIONS_LIST_LIMIT, foldOperations, type OperationsRows } from './operations.fold.js';

const NOW = new Date('2026-11-19T15:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const EMPTY: OperationsRows = {
  deadlines: [],
  pending: { pending: '0', stuck: '0', oldest_at: null },
  failed: '0',
  quotations: [],
};

describe('foldOperations: Inicio → Hoy', () => {
  it('sin nada que atender, todo en cero y en verde', () => {
    const ops = foldOperations(EMPTY, NOW);
    expect(ops.level).toBe('ok');
    expect(ops.deadlines).toMatchObject({ overdue: 0, within24h: 0, later: 0, items: [] });
    expect(ops.pendingOrders).toEqual({ count: 0, stuck: 0, oldestAt: null });
    expect(ops.generatedAt).toBe(NOW.toISOString());
  });

  it('separa los plazos vencidos, los de 24 h y los demás, y lista el más próximo primero', () => {
    const ops = foldOperations(
      {
        ...EMPTY,
        deadlines: [
          { order_id: 'c', order_number: '30', deadline_at: at(50) },
          { order_id: 'a', order_number: 10, deadline_at: at(-2).toISOString() },
          { order_id: 'b', order_number: '20', deadline_at: at(3) },
        ],
      },
      NOW,
    );
    expect(ops.deadlines).toMatchObject({ overdue: 1, within24h: 1, later: 1 });
    expect(ops.deadlines.items.map((d) => [d.orderNumber, d.overdue])).toEqual([
      [10, true],
      [20, false],
      [30, false],
    ]);
    expect(ops.level).toBe('critical');
  });

  it('una reserva trabada en creación es crítica; una en curso o una fallida, aviso', () => {
    expect(
      foldOperations({ ...EMPTY, pending: { pending: 2, stuck: 1, oldest_at: at(-2) } }, NOW).level,
    ).toBe('critical');
    expect(
      foldOperations({ ...EMPTY, pending: { pending: 1, stuck: 0, oldest_at: at(0) } }, NOW).level,
    ).toBe('warn');
    expect(foldOperations({ ...EMPTY, failed: 3 }, NOW)).toMatchObject({
      level: 'warn',
      failedOrders: { days: 7, count: 3 },
    });
  });

  it('las cotizaciones que vencen son aviso y se listan hasta el límite', () => {
    const quotations = Array.from({ length: OPERATIONS_LIST_LIMIT + 2 }, (_, i) => ({
      quotation_id: `q${String(i)}`,
      quote_number: i + 1,
      expires_at: at(40 - i),
    }));
    const ops = foldOperations({ ...EMPTY, quotations }, NOW);
    expect(ops.level).toBe('warn');
    expect(ops.quotationsExpiring.count).toBe(OPERATIONS_LIST_LIMIT + 2);
    expect(ops.quotationsExpiring.items).toHaveLength(OPERATIONS_LIST_LIMIT);
    expect(ops.quotationsExpiring.items[0]!.quoteNumber).toBe(OPERATIONS_LIST_LIMIT + 2);
  });

  it('descarta fechas ilegibles y conteos raros en vez de inventar', () => {
    const ops = foldOperations(
      {
        deadlines: [{ order_id: 'x', order_number: 1, deadline_at: 'no-es-fecha' }],
        pending: undefined,
        failed: '-4',
        quotations: [],
      },
      NOW,
    );
    expect(ops.deadlines.items).toEqual([]);
    expect(ops.pendingOrders.count).toBe(0);
    expect(ops.failedOrders.count).toBe(0);
    expect(ops.level).toBe('ok');
  });
});
