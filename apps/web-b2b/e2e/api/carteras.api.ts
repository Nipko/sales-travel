import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { como, nodo } from './support/cliente';

/**
 * Carteras B2B (docs/qa/01 §5 CAR) por HTTP. El consolidador financia a la agencia A:
 *
 * - CAR-01: habilitar una moneda (ISO con 2 decimales, motivo); repetida → PORTFOLIO_ALREADY_ENABLED.
 * - CAR-02: depósito con Idempotency-Key; monto 0 o sin clave → 400; la misma clave no duplica.
 * - CAR-03: ajuste de cero → 400; un débito y su crédito se registran (sin tope por el cupo: QA-M-09).
 * - CAR-05: quien no financia el nodo no ve ni toca sus carteras.
 *
 * Usa EUR en la agencia A, que no usa ningún otro caso.
 */
interface Cartera {
  id: string;
  currency: string;
  balanceMinor: number;
}

test('CAR-01 / CAR-02 / CAR-03 / CAR-05 el financiador opera la cartera; nadie más', async () => {
  const cons = await como('consolidador');
  const nodoA = await nodo('e2e-agencia-a');
  const base = `/tenants/${nodoA}/portfolios`;
  const malas: string[] = [];

  // CAR-01
  const habilitar = (body: unknown) => cons.post<{ portfolio?: Cartera }>(base, body);
  for (const [caso, body] of [
    ['moneda sin decimales (JPY)', { currency: 'JPY', reason: 'QA CAR-01' }],
    ['moneda inventada', { currency: 'ZZZ', reason: 'QA CAR-01' }],
    ['motivo corto', { currency: 'EUR', reason: 'ab' }],
  ] as const) {
    const r = await habilitar(body);
    if (r.status !== 400) malas.push(`CAR-01 ${caso} → ${r.status}`);
  }
  const primera = await habilitar({ currency: 'EUR', creditLimitMinor: 0, reason: 'QA CAR-01' });
  if (primera.status >= 300 && !primera.text.includes('PORTFOLIO_ALREADY_ENABLED')) {
    malas.push(`CAR-01 habilitar EUR → ${primera.status} ${primera.text.slice(0, 80)}`);
  }
  const repetida = await habilitar({ currency: 'EUR', reason: 'QA CAR-01 otra vez' });
  if (!repetida.text.includes('PORTFOLIO_ALREADY_ENABLED')) {
    malas.push(`CAR-01 repetida → ${repetida.status} ${repetida.text.slice(0, 80)}`);
  }
  const lista = await cons.get<{ portfolios?: Cartera[] }>(base);
  const eur = (lista.body.portfolios ?? []).find((p) => p.currency === 'EUR');
  expect(eur, `la agencia A tiene cartera EUR: ${lista.text.slice(0, 200)}`).toBeDefined();

  // CAR-02
  const depositar = (body: unknown, key: string | null) =>
    cons.pedir<{ portfolio?: Cartera }>('POST', `${base}/${eur!.id}/deposits`, {
      body,
      ...(key === null ? {} : { headers: { 'idempotency-key': key } }),
    });
  for (const [caso, body, key] of [
    ['monto 0', { amountMinor: 0, reason: 'QA CAR-02' }, randomUUID()],
    ['sin clave', { amountMinor: 1000, reason: 'QA CAR-02' }, null],
    ['clave que no es UUID', { amountMinor: 1000, reason: 'QA CAR-02' }, 'clave-1'],
  ] as const) {
    const r = await depositar(body, key);
    if (r.status !== 400) malas.push(`CAR-02 ${caso} → ${r.status}`);
  }
  const key = randomUUID();
  const d1 = await depositar({ amountMinor: 1000, reason: 'QA CAR-02' }, key);
  const d2 = await depositar({ amountMinor: 1000, reason: 'QA CAR-02' }, key);
  if (d1.status >= 300) malas.push(`CAR-02 depósito → ${d1.status} ${d1.text.slice(0, 80)}`);
  if (d2.status < 300 && d2.body.portfolio?.balanceMinor !== d1.body.portfolio?.balanceMinor) {
    malas.push('CAR-02 la misma clave sumó dos veces');
  }

  // CAR-03
  const ajustar = (amountMinor: number) =>
    cons.pedir('POST', `${base}/${eur!.id}/adjustments`, {
      body: { amountMinor, reason: 'QA CAR-03' },
      headers: { 'idempotency-key': randomUUID() },
    });
  const cero = await ajustar(0);
  if (cero.status !== 400) malas.push(`CAR-03 ajuste 0 → ${cero.status}`);
  // Un débito y su crédito: los dos se registran. No hay tope por el cupo en un ajuste (QA-M-09).
  const debito = await ajustar(-500);
  const credito = await ajustar(500);
  if (debito.status >= 300 || credito.status >= 300) {
    malas.push(`CAR-03 ajuste ±500 → ${debito.status} / ${credito.status}`);
  }

  // CAR-05
  const adminB = await como('adminB');
  const vendedorA = await como('vendedorA');
  for (const [quien, api] of [
    ['admin de la agencia B', adminB],
    ['vendedor de la agencia A', vendedorA],
  ] as const) {
    const r = await api.get(base);
    if (r.status !== 403 && r.status !== 404) malas.push(`CAR-05 ${quien} ve → ${r.status}`);
    const dep = await api.pedir('POST', `${base}/${eur!.id}/deposits`, {
      body: { amountMinor: 1000, reason: 'QA CAR-05' },
      headers: { 'idempotency-key': randomUUID() },
    });
    if (dep.status !== 403 && dep.status !== 404)
      malas.push(`CAR-05 ${quien} deposita → ${dep.status}`);
  }

  expect(malas, malas.join('\n')).toEqual([]);
});
