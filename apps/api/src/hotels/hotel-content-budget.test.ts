import { describe, expect, it } from 'vitest';
import { SlidingWindowBudget } from './hotel-content-budget.js';

describe('SlidingWindowBudget: el tope por minuto de las llamadas extra de los lotes', () => {
  it('deja pasar hasta el tope dentro de la ventana y, lleno, no toma nada', () => {
    let now = 0;
    const budget = new SlidingWindowBudget(2, 60_000, () => now);

    expect([budget.tryTake('tbo'), budget.tryTake('tbo'), budget.tryTake('tbo')]).toEqual([
      true,
      true,
      false,
    ]);
    // Un rechazo no ocupa lugar: al vencer el primero, entra uno y sólo uno.
    now = 60_000;
    expect([budget.tryTake('tbo'), budget.tryTake('tbo')]).toEqual([true, true]);
    expect(budget.tryTake('tbo')).toBe(false);
  });

  it('cada proveedor tiene su ventana', () => {
    const budget = new SlidingWindowBudget(1, 60_000, () => 0);
    expect(budget.tryTake('tbo-hotels')).toBe(true);
    expect(budget.tryTake('tbo-hotels')).toBe(false);
    expect(budget.tryTake('otro-hotels')).toBe(true);
  });
});
