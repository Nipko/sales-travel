import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVALS_FILTERS,
  STALE_AFTER_MS,
  appendPage,
  approvalsErrorMessage,
  approvalsSearch,
  emptyCopy,
  financierLabel,
  otherFinancierOf,
  parseDepositApprovals,
  parsePendingDeposits,
  parseQueuedReport,
  pendingBadgeLabel,
  resolvedMessage,
  scopeOptions,
  sinceLabel,
  totalLabel,
  waitingTone,
  withoutReport,
  type QueuedDepositReport,
} from './deposit-approvals';

/** Formas del voseo que podrían colarse en estos textos (el panel va en tú neutro). */
const VOSEO =
  /(?<!\p{L})(?:podés|tenés|querés|hacé|elegí|probá|volvé|ingresá|revisá|esperá|intentá|recargá|verificá|aprobá|rechazá|usá|buscá|cerrá|vos)(?!\p{L})/giu;
const voseoIn = (text: string): string[] => [...text.matchAll(VOSEO)].map((m) => m[0]);

const NODE = '10000000-0000-4000-8000-000000000001';
const CONSOLIDATOR = '10000000-0000-4000-8000-0000000000c1';
const PLATFORM = '10000000-0000-4000-8000-0000000000f1';
const REPORT = '30000000-0000-4000-8000-000000000001';
const WALLET = '20000000-0000-4000-8000-000000000002';

const API_REPORT = {
  id: REPORT,
  tenantId: NODE,
  portfolioId: WALLET,
  currency: 'COP',
  exponent: 2,
  amountMinor: 75_000_000,
  reference: 'TRX-889',
  depositedOn: '2026-10-10',
  notes: 'Consignación Bancolombia',
  status: 'pending',
  reportedBy: '40000000-0000-4000-8000-000000000001',
  reportedByName: 'Ana',
  reportedAt: '2026-10-10T15:00:00.000Z',
  resolvedBy: null,
  resolvedByName: null,
  resolvedAt: null,
  resolutionReason: null,
  portfolioTransactionId: null,
  tenant: {
    id: NODE,
    name: 'Agencia Sur',
    slug: 'agencia-sur',
    tenantType: 'agency',
    isBranch: false,
    status: 'active',
  },
  financier: { id: CONSOLIDATOR, name: 'Consolidador Andino', tenantType: 'consolidator' },
  financedByPlatform: false,
};

describe('parseDepositApprovals', () => {
  it('lee la página, sus totales y el cursor', () => {
    const view = parseDepositApprovals({
      status: 'pending',
      reports: [API_REPORT],
      nextCursor: 'abc_-1',
      totals: [{ currency: 'COP', exponent: 2, count: 1, amountMinor: 75_000_000 }],
    });
    expect(view?.nextCursor).toBe('abc_-1');
    expect(view?.totals).toEqual([
      { currency: 'COP', exponent: 2, count: 1, amountMinor: 75_000_000 },
    ]);
    expect(view?.reports[0]).toMatchObject({
      id: REPORT,
      tenantId: NODE,
      amountMinor: 75_000_000,
      tenant: { name: 'Agencia Sur', tenantType: 'agency', isBranch: false },
      financier: { name: 'Consolidador Andino' },
      financedByPlatform: false,
    });
  });

  it('descarta el informe con forma rota, no la página', () => {
    const view = parseDepositApprovals({
      status: 'pending',
      reports: [
        API_REPORT,
        { ...API_REPORT, id: 'x' },
        { ...API_REPORT, tenant: null },
        { ...API_REPORT, financier: { id: 'x' } },
        { ...API_REPORT, financedByPlatform: 'sí' },
      ],
      nextCursor: null,
      totals: [
        { currency: 'cop', count: 1, amountMinor: 1 },
        { currency: 'USD', exponent: null, count: 2, amountMinor: 10 },
      ],
    });
    expect(view?.reports).toHaveLength(1);
    expect(view?.totals).toEqual([{ currency: 'USD', exponent: null, count: 2, amountMinor: 10 }]);
  });

  it('un informe sin financiador (la raíz) se lee con `financier: null`', () => {
    expect(
      parseQueuedReport({ ...API_REPORT, financier: null, financedByPlatform: true }),
    ).toMatchObject({
      financier: null,
      financedByPlatform: true,
    });
  });

  it.each([
    ['sin estado', { reports: [], totals: [], nextCursor: null }],
    ['un estado raro', { status: 'held', reports: [], totals: [], nextCursor: null }],
    ['sin lista', { status: 'pending', totals: [], nextCursor: null }],
    ['un cursor que no es texto', { status: 'pending', reports: [], totals: [], nextCursor: 3 }],
    ['nada', null],
  ])('rechaza la respuesta %s', (_caso, body) => {
    expect(parseDepositApprovals(body)).toBeUndefined();
  });

  it('el contador', () => {
    expect(parsePendingDeposits({ total: 3, platform: 2, network: 1 })).toEqual({
      total: 3,
      platform: 2,
      network: 1,
    });
    expect(parsePendingDeposits({ total: -1, platform: 0, network: 0 })).toBeUndefined();
    expect(parsePendingDeposits({ total: 1 })).toBeUndefined();
  });
});

describe('approvalsSearch', () => {
  it('por omisión pide los pendientes que financia Planetour', () => {
    expect(approvalsSearch(DEFAULT_APPROVALS_FILTERS)).toBe('status=pending&financedBy=platform');
  });

  it('toda la red no manda alcance; la moneda, la búsqueda y el cursor sí', () => {
    expect(
      approvalsSearch(
        { status: 'approved', financedBy: 'all', currency: 'USD', q: '  Sur & Co ' },
        'cur_1',
      ),
    ).toBe('status=approved&currency=USD&q=Sur+%26+Co&cursor=cur_1');
  });

  it('una moneda inválida o una búsqueda vacía no viajan, y la búsqueda se corta a 100', () => {
    const q = approvalsSearch({
      ...DEFAULT_APPROVALS_FILTERS,
      currency: 'usd',
      q: 'x'.repeat(150),
    });
    expect(new URLSearchParams(q).get('currency')).toBeNull();
    expect(new URLSearchParams(q).get('q')).toHaveLength(100);
    expect(approvalsSearch({ ...DEFAULT_APPROVALS_FILTERS, q: '   ' }, null)).not.toContain('q=');
  });
});

describe('appendPage', () => {
  it('no repite un informe que ya se ve', () => {
    const a = parseQueuedReport(API_REPORT)!;
    const b = parseQueuedReport({ ...API_REPORT, id: '30000000-0000-4000-8000-000000000002' })!;
    expect(appendPage([a], [a, b]).map((r) => r.id)).toEqual([a.id, b.id]);
  });
});

describe('withoutReport', () => {
  const a = parseQueuedReport(API_REPORT)!;
  const b = parseQueuedReport({
    ...API_REPORT,
    id: '30000000-0000-4000-8000-000000000002',
    amountMinor: 5_000_000,
  })!;
  const usd = parseQueuedReport({
    ...API_REPORT,
    id: '30000000-0000-4000-8000-000000000003',
    currency: 'USD',
    amountMinor: 12_000,
  })!;
  const view = {
    status: 'pending' as const,
    reports: [a, b, usd],
    nextCursor: 'next',
    totals: [
      { currency: 'COP', exponent: 2, count: 2, amountMinor: 80_000_000 },
      { currency: 'USD', exponent: 2, count: 1, amountMinor: 12_000 },
    ],
  };

  it('saca el informe y lo descuenta de su moneda, sin tocar el cursor', () => {
    const next = withoutReport(view, a);
    expect(next.reports.map((r) => r.id)).toEqual([b.id, usd.id]);
    expect(next.totals).toEqual([
      { currency: 'COP', exponent: 2, count: 1, amountMinor: 5_000_000 },
      { currency: 'USD', exponent: 2, count: 1, amountMinor: 12_000 },
    ]);
    expect(next.nextCursor).toBe('next');
  });

  it('una moneda que se queda sin informes desaparece de los totales', () => {
    expect(withoutReport(view, usd).totals.map((t) => t.currency)).toEqual(['COP']);
  });

  it('uno que no está en la vista no cambia nada', () => {
    expect(withoutReport(view, { id: 'otro', currency: 'COP', amountMinor: 1 })).toBe(view);
  });
});

describe('textos', () => {
  const report = parseQueuedReport(API_REPORT)!;
  const platformReport: QueuedDepositReport = {
    ...report,
    financier: { id: PLATFORM, name: 'Planetour', tenantType: 'platform' },
    financedByPlatform: true,
  };

  it('quién financia: Planetour o el nodo, con su tipo', () => {
    expect(financierLabel(platformReport)).toBe('Lo financia Planetour');
    expect(financierLabel(report)).toBe('Lo financia Consolidador Andino (consolidador)');
    expect(otherFinancierOf(platformReport)).toBeUndefined();
    expect(otherFinancierOf(report)).toBe('Consolidador Andino');
  });

  it('desde cuándo espera, y se resalta pasadas 48 horas', () => {
    const at = Date.parse(API_REPORT.reportedAt);
    expect(sinceLabel(API_REPORT.reportedAt, at + 20_000)).toBe('hace un momento');
    expect(sinceLabel(API_REPORT.reportedAt, at + 5 * 60_000)).toBe('hace 5 minutos');
    expect(sinceLabel(API_REPORT.reportedAt, at + 3 * 3_600_000)).toBe('hace 3 horas');
    expect(sinceLabel(API_REPORT.reportedAt, at + 4 * 86_400_000)).toBe('hace 4 días');
    expect(sinceLabel('no-es-fecha', at)).toBe('');
    expect(waitingTone(API_REPORT.reportedAt, at + STALE_AFTER_MS - 1)).toBe('neutral');
    expect(waitingTone(API_REPORT.reportedAt, at + STALE_AFTER_MS)).toBe('warning');
  });

  it('los totales por moneda dicen cuántos y cuánto', () => {
    expect(totalLabel({ currency: 'USD', exponent: 2, count: 1, amountMinor: 12_000 })).toMatch(
      /^1 depósito · US\$\s?120$/,
    );
    expect(totalLabel({ currency: 'COP', exponent: 2, count: 3, amountMinor: 75_000_000 })).toMatch(
      /^3 depósitos · \$\s?750\.000$/,
    );
  });

  it('los alcances llevan su contador sólo en la cola de pendientes', () => {
    const counts = { total: 5, platform: 3, network: 2 };
    expect(scopeOptions(counts, true).map((o) => [o.value, o.count])).toEqual([
      ['platform', 3],
      ['network', 2],
      ['all', 5],
    ]);
    expect(scopeOptions(counts, false).every((o) => o.count === undefined)).toBe(true);
    expect(scopeOptions(null, true).every((o) => o.count === undefined)).toBe(true);
  });

  it('el vacío dice por qué no hay nada', () => {
    expect(emptyCopy(DEFAULT_APPROVALS_FILTERS).title).toBe('No hay depósitos por aprobar.');
    expect(emptyCopy({ ...DEFAULT_APPROVALS_FILTERS, financedBy: 'network' }).title).toBe(
      'Ningún depósito espera a otro nodo.',
    );
    expect(emptyCopy({ ...DEFAULT_APPROVALS_FILTERS, status: 'approved' }).title).toMatch(
      /aprobados/,
    );
    expect(emptyCopy({ ...DEFAULT_APPROVALS_FILTERS, status: 'rejected' }).title).toMatch(
      /rechazados/,
    );
    expect(emptyCopy({ ...DEFAULT_APPROVALS_FILTERS, q: 'sur' }).title).toBe(
      'No encontramos depósitos con esos filtros.',
    );
  });

  it('errores, avisos y contador del menú, en tú', () => {
    const texts = [
      approvalsErrorMessage(401),
      approvalsErrorMessage(403),
      approvalsErrorMessage(400),
      approvalsErrorMessage(502),
      resolvedMessage('approve', report),
      resolvedMessage('reject', report),
      pendingBadgeLabel(1),
      pendingBadgeLabel(4),
      ...Object.values(emptyCopy(DEFAULT_APPROVALS_FILTERS)),
    ];
    expect(texts.flatMap(voseoIn)).toEqual([]);
    expect(approvalsErrorMessage(401)).toBe('Tu sesión venció. Vuelve a iniciar sesión.');
    expect(resolvedMessage('approve', report)).toMatch(
      /^Depósito aprobado: se acreditaron \$\s?750\.000 a Agencia Sur\.$/,
    );
    expect(pendingBadgeLabel(1)).toBe('1 depósito por aprobar');
    expect(pendingBadgeLabel(4)).toBe('4 depósitos por aprobar');
  });
});
