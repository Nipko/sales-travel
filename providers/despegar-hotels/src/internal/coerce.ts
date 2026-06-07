/** Coacciona number|string|unknown a number (0 si no es finito). Despegar a veces envía montos como string. */
export function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
