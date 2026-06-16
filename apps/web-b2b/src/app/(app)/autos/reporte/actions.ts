'use server';

import { api } from '../../../../lib/api';

// ─────────────────────────── Tipos (espejo del contrato /cars/daily-report) ───────────────────────────

export interface DailyReportEntry {
  confirmationCode: string;
  pickUpDate: string;
  dropOffDate: string;
  status: string;
}

export interface DailyReportResult {
  ok: boolean;
  entries: DailyReportEntry[];
  error?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reporte diario de movimientos (recogidas/devoluciones). `date` opcional (YYYY-MM-DD). */
export async function dailyReportAction(date?: string): Promise<DailyReportResult> {
  const d = date?.trim();
  if (d && !DATE_RE.test(d)) {
    return { ok: false, entries: [], error: 'Ingresá una fecha válida (YYYY-MM-DD).' };
  }

  const qs = new URLSearchParams();
  if (d) qs.set('date', d);
  const suffix = qs.toString();

  const res = await api<{ entries: DailyReportEntry[] }>(
    `/cars/daily-report${suffix ? `?${suffix}` : ''}`,
  );
  if (!res.ok) return { ok: false, entries: [], error: res.error.message };
  return { ok: true, entries: res.data.entries };
}
