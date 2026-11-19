import { describe, expect, it } from 'vitest';
import {
  parseAgencyOperations,
  relativeLabel,
  todayItems,
  type AgencyOperations,
} from './agency-today';
import type { ProviderStatus } from './provider-status';
import type { Wallet } from './wallets';

const NOW = Date.parse('2026-11-19T15:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const QUIET: AgencyOperations = {
  generatedAt: inHours(0),
  level: 'ok',
  deadlines: { windowHours: 72, overdue: 0, within24h: 0, later: 0, items: [] },
  pendingOrders: { count: 0, stuck: 0, oldestAt: null },
  failedOrders: { days: 7, count: 0 },
  quotationsExpiring: { windowHours: 48, count: 0, items: [] },
};

function wallet(over: Partial<Wallet>): Wallet {
  return {
    id: 'w1',
    tenantId: 't1',
    currency: 'COP',
    exponent: 2,
    creditLimitMinor: 1_000_000,
    balanceMinor: 0,
    availableMinor: 1_000_000,
    status: 'active',
    updatedAt: inHours(0),
    ...over,
  };
}

describe('parseAgencyOperations', () => {
  it('acepta la respuesta del API y la devuelve igual', () => {
    const body = {
      ...QUIET,
      deadlines: {
        ...QUIET.deadlines,
        within24h: 1,
        items: [{ orderId: 'o1', orderNumber: 12, deadlineAt: inHours(5), overdue: false }],
      },
    };
    expect(parseAgencyOperations(JSON.parse(JSON.stringify(body)))).toEqual(body);
  });

  it('rechaza conteos negativos, niveles raros y filas incompletas', () => {
    expect(parseAgencyOperations({ ...QUIET, level: 'rojo' })).toBeUndefined();
    expect(
      parseAgencyOperations({ ...QUIET, failedOrders: { days: 7, count: -1 } }),
    ).toBeUndefined();
    expect(
      parseAgencyOperations({
        ...QUIET,
        deadlines: { ...QUIET.deadlines, items: [{ orderId: 'o1' }] },
      }),
    ).toBeUndefined();
    expect(parseAgencyOperations('x')).toBeUndefined();
  });
});

describe('todayItems', () => {
  it('sin nada que atender, la lista está vacía', () => {
    expect(todayItems(QUIET, [wallet({})], [], NOW)).toEqual([]);
  });

  it('lo urgente primero: plazo vencido, plazo de 24 h y reserva trabada; después lo que puede esperar', () => {
    const items = todayItems(
      {
        ...QUIET,
        deadlines: {
          windowHours: 72,
          overdue: 1,
          within24h: 1,
          later: 2,
          items: [
            { orderId: 'vencida', orderNumber: 7, deadlineAt: inHours(-1), overdue: true },
            { orderId: 'pronto', orderNumber: 8, deadlineAt: inHours(5), overdue: false },
          ],
        },
        pendingOrders: { count: 1, stuck: 1, oldestAt: inHours(-2) },
        failedOrders: { days: 7, count: 2 },
        quotationsExpiring: {
          windowHours: 48,
          count: 1,
          items: [{ quotationId: 'q1', quoteNumber: 31, expiresAt: inHours(10) }],
        },
      },
      [],
      [],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual([
      'deadline-overdue',
      'deadline-24h',
      'pending-stuck',
      'deadline-later',
      'quotations',
      'failed',
    ]);
    expect(items[0]?.href).toBe('/reservas/vencida');
    expect(items[1]?.detail).toContain('#8');
    expect(items[1]?.detail).toContain('en 5 h');
    expect(items[4]?.detail).toContain('#31');
  });

  it('una cartera que no deja reservar es urgente; una casi sin cupo, aviso', () => {
    const items = todayItems(
      QUIET,
      [
        wallet({ currency: 'USD', availableMinor: 0 }),
        wallet({ currency: 'COP', availableMinor: 50_000 }),
        wallet({ currency: 'BRL', status: 'suspended' }),
      ],
      [],
      NOW,
    );
    expect(items.map((i) => [i.id, i.tone])).toEqual([
      ['wallet-USD', 'danger'],
      ['wallet-BRL', 'danger'],
      ['wallet-COP', 'warning'],
    ]);
  });

  it('un proveedor que falla avisa sin enlace; uno que opera o sin uso, no', () => {
    const providers: ProviderStatus[] = [
      {
        providerCode: 'tbo-hotels',
        vertical: 'hotels',
        status: 'provider',
        message: 'No responde.',
      },
      { providerCode: 'sabre', vertical: 'flights', status: 'ok', message: '' },
      { providerCode: 'latam-ndc', vertical: 'flights', status: 'idle', message: '' },
    ];
    const items = todayItems(QUIET, [], providers, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tone: 'danger', href: null, detail: 'No responde.' });
  });

  it('sin la lectura de reservas, igual muestra cartera y proveedores', () => {
    expect(todayItems(undefined, [wallet({ availableMinor: -5 })], [], NOW)).toHaveLength(1);
  });
});

describe('relativeLabel', () => {
  it('horas cerca, días lejos, y el pasado con «hace»', () => {
    expect(relativeLabel(inHours(5), NOW)).toBe('en 5 h');
    expect(relativeLabel(inHours(0.2), NOW)).toBe('en menos de 1 h');
    expect(relativeLabel(inHours(72), NOW)).toBe('en 3 días');
    expect(relativeLabel(inHours(-3), NOW)).toBe('hace 3 h');
  });
});
