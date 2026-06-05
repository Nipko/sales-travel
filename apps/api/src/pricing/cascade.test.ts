import { describe, expect, it } from 'vitest';
import { applyCascade, type ApplicableRule } from './pricing.service.js';

/** Paridad con el test SQL de compute_price_waterfall (0016): misma semántica de cascada. */
describe('applyCascade (JS waterfall, paridad con compute_price_waterfall)', () => {
  it('cascades ancestor→descendant: 100000 → +10% → +5% → +2000 = 117500', () => {
    const rules: ApplicableRule[] = [
      { tenantId: 'c', tenantName: 'cons', level: 1, ruleType: 'percentage', valueMinor: 1000 },
      { tenantId: 'a', tenantName: 'agency', level: 2, ruleType: 'percentage', valueMinor: 500 },
      { tenantId: 's', tenantName: 'sub', level: 3, ruleType: 'fixed', valueMinor: 2000 },
    ];
    const w = applyCascade(100000, rules);
    expect(w.netMinor).toBe(100000);
    expect(w.finalMinor).toBe(117500); // 100000 → 110000 → 115500 → 117500
    expect(w.totalMarkupMinor).toBe(17500);
    expect(w.breakdown).toHaveLength(3);
    expect(w.breakdown[0]?.addedMinor).toBe(10000);
    expect(w.breakdown[1]?.addedMinor).toBe(5500);
    expect(w.breakdown[2]?.addedMinor).toBe(2000);
  });

  it('no rules → final = net (sin markup)', () => {
    const w = applyCascade(50000, []);
    expect(w.finalMinor).toBe(50000);
    expect(w.totalMarkupMinor).toBe(0);
    expect(w.breakdown).toHaveLength(0);
  });
});
