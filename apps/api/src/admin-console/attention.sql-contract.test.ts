import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_PRIORITY,
  ATTENTION_THRESHOLDS,
  ORDER_ATTENTION_REASONS,
  attentionRank,
  isOrderAttentionReason,
} from './attention.js';

/**
 * El vocabulario de `admin_order_attention()` vive en dos lados: la migración que lo emite y la API
 * que lo lee. Si uno cambia sin el otro, una reserva con problemas desaparecería del Resumen sin que
 * nadie lo note. Este test lee la migración tal como se aplica.
 */
const MIGRATIONS = join(__dirname, '..', '..', '..', '..', 'db', 'migrations');
const MIGRATION = readFileSync(join(MIGRATIONS, '0075_platform_console_reads.sql'), 'utf8');
/** Reservas de la red: marca cada fila con el motivo más grave, por un CASE propio. */
const ORDERS_CONSOLE = readFileSync(join(MIGRATIONS, '0076_admin_orders_console.sql'), 'utf8');

function functionBody(name: string): string {
  const start = MIGRATION.indexOf(`CREATE FUNCTION ${name}(`);
  expect(start, `${name} no está en 0075`).toBeGreaterThanOrEqual(0);
  const open = MIGRATION.indexOf('$$', start);
  const close = MIGRATION.indexOf('$$', open + 2);
  return MIGRATION.slice(open + 2, close);
}

describe('admin_order_attention (0075) y attention.ts', () => {
  const body = functionBody('admin_order_attention');

  it('la base emite exactamente los motivos de ORDER_ATTENTION_REASONS', () => {
    const emitted = [...body.matchAll(/SELECT [^\n]*?'([a-z-]+)'(?:::text AS why)?,/g)]
      .map((m) => m[1])
      .sort();
    expect(emitted).toEqual([...ORDER_ATTENTION_REASONS].sort());
  });

  it('cada motivo tiene su prioridad, sin repetir', () => {
    expect([...ATTENTION_PRIORITY].sort()).toEqual([...ORDER_ATTENTION_REASONS].sort());
    expect(new Set(ATTENTION_PRIORITY).size).toBe(ATTENTION_PRIORITY.length);
    expect(attentionRank('hold-orphan')).toBe(0);
    expect(attentionRank('verifying-long')).toBe(ATTENTION_PRIORITY.length - 1);
  });

  it('los umbrales de la migración son los de ATTENTION_THRESHOLDS', () => {
    for (const [name, interval] of Object.entries(ATTENTION_THRESHOLDS)) {
      expect(body, `${name} = ${interval}`).toContain(`interval '${interval}'`);
    }
    const intervals = [...body.matchAll(/interval '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(intervals)).toEqual(new Set(Object.values(ATTENTION_THRESHOLDS)));
  });

  it('el encabezado y el COMMENT documentan los mismos motivos', () => {
    const comment = /COMMENT ON FUNCTION admin_order_attention\(\) IS\s+'([^']+)'/.exec(MIGRATION);
    for (const reason of ORDER_ATTENTION_REASONS) {
      expect(comment?.[1]).toContain(reason);
    }
  });

  it('isOrderAttentionReason sólo acepta el vocabulario', () => {
    expect(isOrderAttentionReason('review')).toBe(true);
    expect(isOrderAttentionReason('otra-cosa')).toBe(false);
    expect(isOrderAttentionReason(undefined)).toBe(false);
  });
});

describe('admin_search_orders (0076) y ATTENTION_PRIORITY', () => {
  const start = ORDERS_CONSOLE.indexOf('CREATE FUNCTION admin_search_orders(');
  const open = ORDERS_CONSOLE.indexOf('$$', start);
  const body = ORDERS_CONSOLE.slice(open + 2, ORDERS_CONSOLE.indexOf('$$', open + 2));

  it('el motivo de cada fila es el más grave, con el orden de ATTENTION_PRIORITY', () => {
    const ranked = [...body.matchAll(/WHEN '([a-z-]+)'\s+THEN (\d+)/g)].map((m) => ({
      reason: m[1],
      rank: Number(m[2]),
    }));
    expect(ranked.map((r) => r.reason)).toEqual([...ATTENTION_PRIORITY]);
    expect(ranked.map((r) => r.rank)).toEqual(ATTENTION_PRIORITY.map((_, i) => i));
  });

  it('lee los motivos de admin_order_attention, no una lista propia', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toContain('public.admin_order_attention()');
  });
});
