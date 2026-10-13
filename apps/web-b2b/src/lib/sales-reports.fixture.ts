/**
 * La respuesta de `GET /reports/sales-metrics` de una agencia que vende en COP y en USD, para los
 * tests de `sales-reports.ts` y de la pantalla de Reportes.
 */
export function salesPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    period: { from: '2025-11', to: '2026-10', timeZone: 'America/Bogota' },
    byVertical: [
      { vertical: 'hotels', currency: 'COP', totalAmountMinor: 400_000_00, count: 1 },
      { vertical: 'flights', currency: 'COP', totalAmountMinor: 307_000_00, count: 3 },
      { vertical: 'flights', currency: 'USD', totalAmountMinor: 500_50, count: 1 },
    ],
    monthlyTrend: [
      { month: '2026-01', currency: 'COP', amountMinor: 7_000_00, count: 1 },
      { month: '2026-10', currency: 'COP', amountMinor: 700_000_00, count: 3 },
      { month: '2026-10', currency: 'USD', amountMinor: 500_50, count: 1 },
    ],
    topPerformers: [
      { userId: 'u2', name: 'Bruno Díaz', currency: 'COP', salesMinor: 400_000_00, count: 1 },
      { userId: 'u1', name: 'Ana Ruiz', currency: 'COP', salesMinor: 307_000_00, count: 3 },
      { userId: 'u1', name: 'Ana Ruiz', currency: 'USD', salesMinor: 500_50, count: 1 },
    ],
    ...overrides,
  };
}

/** Sin ventas en el período. */
export const NO_SALES = { byVertical: [], monthlyTrend: [], topPerformers: [] } as const;
