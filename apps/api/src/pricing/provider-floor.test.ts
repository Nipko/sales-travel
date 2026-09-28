import { describe, expect, it } from 'vitest';
import {
  PROVIDER_FLOOR_RULE_TYPE,
  applyCascade,
  applyProviderFloor,
  toTenantView,
  type ApplicableRule,
  type WaterfallResult,
} from './pricing.service.js';

/**
 * Piso de precio del proveedor en la cascada (PR-2.5; RF-12 con D-TBO-16 A).
 *
 * Los números son los del ejemplo de docs/tbo/02 §9.5, con el pack de p. 17 del PDF de TBO:
 * `TotalFare` 305.75 y `RecommendedSellingRate` 321.34, ambos en USD.
 */

const CONSOLIDADOR = 'tenant-consolidador';
const AGENCIA = 'tenant-agencia';
const SUB_AGENCIA = 'tenant-sub-agencia';

const NETO = 30_575;
const PISO = 32_134;

const MAS_3_CONSOLIDADOR: ApplicableRule = {
  tenantId: CONSOLIDADOR,
  tenantName: 'Consolidador',
  level: 1,
  ruleType: 'percentage',
  valueMinor: 300,
};
const MAS_1_AGENCIA: ApplicableRule = {
  tenantId: AGENCIA,
  tenantName: 'Agencia',
  level: 2,
  ruleType: 'percentage',
  valueMinor: 100,
};

/** La vista del tenant que vende siempre cuadra: su costo más su margen es el precio de venta. */
function cuadra(w: WaterfallResult, vendedor: string): void {
  const vista = toTenantView(w, vendedor, 'USD');
  expect(vista.costMinor + vista.ownMarkupMinor).toBe(vista.finalMinor);
}

describe('applyProviderFloor — RF-12 CA 1: el ejemplo de 02 §9.5', () => {
  const cascada = applyCascade(NETO, [MAS_3_CONSOLIDADOR, MAS_1_AGENCIA]);
  const conPiso = applyProviderFloor(cascada, PISO, AGENCIA);

  it('la cascada da 318.07: 305.75 → +3 % (9.17) → +1 % (3.15)', () => {
    expect(cascada.finalMinor).toBe(31_807);
    expect(cascada.breakdown.map((s) => s.addedMinor)).toEqual([917, 315]);
  });

  it('el piso de 321.34 la supera: el precio de venta es el piso', () => {
    expect(conPiso.netMinor).toBe(NETO);
    expect(conPiso.finalMinor).toBe(PISO);
    expect(conPiso.totalMarkupMinor).toBe(PISO - NETO);
  });

  it('el aporte del piso, 3.27, es un paso propio atribuido a la agencia que vende', () => {
    expect(conPiso.breakdown).toHaveLength(3);
    expect(conPiso.breakdown.slice(0, 2)).toEqual(cascada.breakdown);
    expect(conPiso.breakdown[2]).toEqual({
      tenantId: AGENCIA,
      ruleType: PROVIDER_FLOOR_RULE_TYPE,
      addedMinor: 327,
    });
  });

  it('la agencia ve el piso como margen suyo; su costo sigue siendo neto + consolidador', () => {
    expect(toTenantView(conPiso, AGENCIA, 'USD')).toEqual({
      costMinor: 31_492,
      finalMinor: PISO,
      ownMarkupMinor: 315 + 327,
      currency: 'USD',
    });
    cuadra(conPiso, AGENCIA);
  });

  it('no muta la cascada que recibe', () => {
    expect(cascada.finalMinor).toBe(31_807);
    expect(cascada.breakdown).toHaveLength(2);
  });
});

describe('applyProviderFloor — RF-12 CA 2: tenant sin reglas', () => {
  it('el precio de venta es el piso si supera al neto, y la diferencia es del tenant que vende', () => {
    const w = applyProviderFloor(applyCascade(NETO, []), PISO, AGENCIA);

    expect(w.finalMinor).toBe(PISO);
    expect(w.breakdown).toEqual([
      { tenantId: AGENCIA, ruleType: PROVIDER_FLOOR_RULE_TYPE, addedMinor: PISO - NETO },
    ]);
    expect(toTenantView(w, AGENCIA, 'USD')).toEqual({
      costMinor: NETO,
      finalMinor: PISO,
      ownMarkupMinor: PISO - NETO,
      currency: 'USD',
    });
  });

  it('un piso por debajo del neto no baja el precio: la venta es el neto', () => {
    const sinReglas = applyCascade(NETO, []);
    expect(applyProviderFloor(sinReglas, NETO - 1, AGENCIA)).toBe(sinReglas);
  });
});

describe('toTenantView — RF-12 CA 3: el piso no es margen de los ancestros', () => {
  // La agencia no tiene regla propia: todo lo que hay por encima del 3 % es el piso.
  const w = applyProviderFloor(applyCascade(NETO, [MAS_3_CONSOLIDADOR]), PISO, AGENCIA);

  it('la vista del consolidador cuenta su 3 % y nada más: el piso no es margen suyo', () => {
    expect(toTenantView(w, CONSOLIDADOR, 'USD')).toEqual({
      costMinor: NETO,
      finalMinor: PISO,
      ownMarkupMinor: 917,
      currency: 'USD',
    });
  });

  it('el piso tampoco entra al costo de la agencia: paga el neto más el 3 % de su red', () => {
    expect(toTenantView(w, AGENCIA, 'USD')).toEqual({
      costMinor: NETO + 917,
      finalMinor: PISO,
      ownMarkupMinor: PISO - NETO - 917,
      currency: 'USD',
    });
    cuadra(w, AGENCIA);
  });

  it('con tres niveles, la agencia intermedia no ve el piso de su sub-agencia como margen suyo', () => {
    const conSub = applyProviderFloor(
      applyCascade(NETO, [
        MAS_3_CONSOLIDADOR,
        MAS_1_AGENCIA,
        { tenantId: SUB_AGENCIA, tenantName: 'Sub', level: 3, ruleType: 'fixed', valueMinor: 100 },
      ]),
      PISO,
      SUB_AGENCIA,
    );

    // 30 575 → +917 → +315 → +100 = 31 907; el piso aporta 227 a la sub-agencia.
    expect(conSub.breakdown.at(-1)).toEqual({
      tenantId: SUB_AGENCIA,
      ruleType: PROVIDER_FLOOR_RULE_TYPE,
      addedMinor: 227,
    });
    expect(toTenantView(conSub, AGENCIA, 'USD').ownMarkupMinor).toBe(315);
    expect(toTenantView(conSub, SUB_AGENCIA, 'USD')).toEqual({
      costMinor: NETO + 917 + 315,
      finalMinor: PISO,
      ownMarkupMinor: 100 + 227,
      currency: 'USD',
    });
    cuadra(conSub, SUB_AGENCIA);
  });

  it('el consolidador que vende directo sí cobra el piso: es el tenant que vende', () => {
    const directo = applyProviderFloor(
      applyCascade(NETO, [MAS_3_CONSOLIDADOR]),
      PISO,
      CONSOLIDADOR,
    );

    expect(toTenantView(directo, CONSOLIDADOR, 'USD')).toEqual({
      costMinor: NETO,
      finalMinor: PISO,
      ownMarkupMinor: PISO - NETO,
      currency: 'USD',
    });
  });
});

describe('applyProviderFloor — sin piso o con la cascada por encima, no cambia nada', () => {
  const cascada = applyCascade(NETO, [MAS_3_CONSOLIDADOR, MAS_1_AGENCIA]);

  it('sin `minimumSellingPrice` no hay piso: devuelve la misma cascada', () => {
    expect(applyProviderFloor(cascada, undefined, AGENCIA)).toBe(cascada);
  });

  it('cascada por encima del piso: la misma cascada, sin paso `provider_floor`', () => {
    const w = applyProviderFloor(cascada, 30_000, AGENCIA);
    expect(w).toBe(cascada);
    expect(w.breakdown.some((s) => s.ruleType === PROVIDER_FLOOR_RULE_TYPE)).toBe(false);
  });

  it('cascada exactamente en el piso: tampoco hay paso', () => {
    expect(applyProviderFloor(cascada, cascada.finalMinor, AGENCIA)).toBe(cascada);
  });

  it('la vista de un waterfall sin piso es la de siempre', () => {
    expect(toTenantView(applyProviderFloor(cascada, undefined, AGENCIA), AGENCIA, 'USD')).toEqual(
      toTenantView(cascada, AGENCIA, 'USD'),
    );
  });
});
