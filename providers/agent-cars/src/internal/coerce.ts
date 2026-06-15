/** Coacciona number|string|unknown a number (0 si no es finito). AgentCars a veces envía montos como string. */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  return false;
}

/** Convierte hora militar HHMM a display "HH:MM". */
export function militaryToDisplay(hhmm: string): string {
  const padded = hhmm.padStart(4, '0');
  return `${padded.slice(0, 2)}:${padded.slice(2)}`;
}

/** Convierte hora HH:MM a formato militar HHMM. */
export function displayToMilitary(time: string): string {
  return time.replace(':', '');
}
