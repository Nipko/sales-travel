/**
 * Coacciona number|string|unknown a number (0 si no es finito). AgentCars envía montos como string,
 * y los montos convertidos a moneda local con separador de miles por coma (ej: "1,180,729"). Se
 * eliminan las comas antes de parsear (AgentCars usa '.' decimal y ',' de miles en sus respuestas).
 */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    // AgentCars usa "Si"/"No" (y a veces "Yes"/"1") para flags como aire acondicionado.
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'si' || s === 'sí' || s === 'yes' || s === 's';
  }
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
