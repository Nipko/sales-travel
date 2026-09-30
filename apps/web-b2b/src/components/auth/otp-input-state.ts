/**
 * Lógica pura del `OtpInput`: qué dígitos quedan y qué casilla toma el foco después de cada gesto.
 *
 * Vive aparte del componente para poder probarla sin DOM (los tests del panel corren en Node). El
 * componente sólo traduce eventos a estas funciones y mueve el foco a `focus`.
 *
 * Invariante: `digits` tiene siempre `length` elementos y cada uno es `''` o un único dígito ASCII.
 */

export const OTP_DEFAULT_LENGTH = 6;

export interface OtpState {
  readonly digits: readonly string[];
  /** Casilla que tiene que quedar enfocada después del gesto. */
  readonly focus: number;
}

export function emptyOtp(length: number = OTP_DEFAULT_LENGTH): string[] {
  return Array.from({ length }, () => '');
}

/** Dígitos de un valor dado (p. ej. uno inicial), recortado o completado a `length`. */
export function otpDigitsFromValue(value: string, length: number = OTP_DEFAULT_LENGTH): string[] {
  const clean = onlyDigits(value).slice(0, length);
  return Array.from({ length }, (_, i) => clean[i] ?? '');
}

export function otpValue(digits: readonly string[]): string {
  return digits.join('');
}

export function isOtpComplete(digits: readonly string[]): boolean {
  return digits.length > 0 && digits.every((d) => d !== '');
}

/**
 * Sólo los dígitos ASCII de un texto. NFKC primero: algunos teclados (y el pegado desde ciertos
 * mensajes) traen dígitos de ancho completo, `１２３`, que para el usuario son el mismo código.
 */
export function onlyDigits(raw: string): string {
  return raw.normalize('NFKC').replace(/[^0-9]/g, '');
}

export function clampOtpIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/** La primera casilla vacía, o la última si están todas llenas: donde sigue escribiendo el usuario. */
export function firstEmptyIndex(digits: readonly string[]): number {
  const i = digits.findIndex((d) => d === '');
  return i === -1 ? clampOtpIndex(digits.length - 1, digits.length) : i;
}

/**
 * Pegado (Ctrl+V, menú contextual) o cualquier entrada de varios dígitos a la vez.
 *
 * Un código completo reemplaza TODO sin importar en qué casilla cayó: es lo que hace el
 * autocompletado de iOS ("De Mensajes") y el de los gestores de contraseñas, que ponen los 6
 * dígitos en la casilla enfocada, y es lo que espera quien pega el código en la segunda casilla.
 * Un fragmento más corto se escribe desde la casilla actual hacia adelante.
 */
export function applyPaste(digits: readonly string[], index: number, text: string): OtpState {
  const length = digits.length;
  const at = clampOtpIndex(index, length);
  const clean = onlyDigits(text);
  if (clean === '') return { digits: [...digits], focus: at };

  if (clean.length >= length) {
    return { digits: clean.slice(0, length).split(''), focus: clampOtpIndex(length - 1, length) };
  }

  const next = [...digits];
  let written = 0;
  for (const ch of clean) {
    if (at + written >= length) break;
    next[at + written] = ch;
    written += 1;
  }
  return { digits: next, focus: clampOtpIndex(at + written, length) };
}

/**
 * El valor que dejó el navegador en una casilla después de un evento `input`.
 *
 * Llega acá lo que no se resolvió en `keydown`: los teclados virtuales de Android (que reportan la
 * tecla como "Unidentified"), el autocompletado y el dictado. Casos:
 *
 *   - vacío: se borró (retroceso en Android o cortar): se limpia y el foco vuelve una casilla, igual
 *     que {@link applyBackspace} sobre una casilla llena;
 *   - un dígito: se escribe y el foco avanza;
 *   - dos caracteres donde había un dígito: es una tecla escrita junto al dígito anterior (el cursor
 *     no quedó seleccionando el contenido): gana el dígito nuevo;
 *   - cualquier otra cosa: pegado o autocompletado ({@link applyPaste}).
 *
 * Lo que no es dígito se descarta: una letra no cambia nada, ni en una casilla vacía ni junto al
 * dígito que ya había.
 */
export function applyInput(digits: readonly string[], index: number, raw: string): OtpState {
  const length = digits.length;
  const at = clampOtpIndex(index, length);
  const prev = digits[at] ?? '';
  const clean = onlyDigits(raw);

  if (clean === '') {
    // Una letra sobre una casilla vacía llega como '' después de filtrar: no es un borrado.
    if (prev === '' && raw !== '') return { digits: [...digits], focus: at };
    const next = [...digits];
    next[at] = '';
    return { digits: next, focus: prev === '' ? at : clampOtpIndex(at - 1, length) };
  }

  if (clean.length === 1) {
    // "3a": una letra junto al dígito que ya estaba. No se escribió nada.
    if (clean === prev && raw.length > 1) return { digits: [...digits], focus: at };
    const next = [...digits];
    next[at] = clean;
    return { digits: next, focus: clampOtpIndex(at + 1, length) };
  }

  if (clean.length === 2 && prev !== '' && (clean[0] === prev || clean[1] === prev)) {
    const typed = clean[0] === prev ? clean[1]! : clean[0]!;
    const next = [...digits];
    next[at] = typed;
    return { digits: next, focus: clampOtpIndex(at + 1, length) };
  }

  return applyPaste(digits, at, clean);
}

/** Una tecla de dígito resuelta en `keydown` (teclado físico): reemplaza la casilla y avanza. */
export function applyDigit(digits: readonly string[], index: number, digit: string): OtpState {
  const clean = onlyDigits(digit);
  const at = clampOtpIndex(index, digits.length);
  if (clean.length !== 1) return { digits: [...digits], focus: at };
  const next = [...digits];
  next[at] = clean;
  return { digits: next, focus: clampOtpIndex(at + 1, digits.length) };
}

/**
 * Retroceso: en una casilla llena la borra y vuelve una; en una vacía borra la anterior y va a
 * ella. Así, retroceso seguido borra el código de atrás para adelante sin que el usuario tenga que
 * volver a tocar ninguna casilla.
 */
export function applyBackspace(digits: readonly string[], index: number): OtpState {
  const length = digits.length;
  const at = clampOtpIndex(index, length);
  const next = [...digits];
  if (next[at] !== '') {
    next[at] = '';
    return { digits: next, focus: clampOtpIndex(at - 1, length) };
  }
  const prev = clampOtpIndex(at - 1, length);
  next[prev] = '';
  return { digits: next, focus: prev };
}

/** Suprimir: borra la casilla actual y el foco se queda. */
export function applyDelete(digits: readonly string[], index: number): OtpState {
  const at = clampOtpIndex(index, digits.length);
  const next = [...digits];
  next[at] = '';
  return { digits: next, focus: at };
}

export type OtpNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export function isOtpNavigationKey(key: string): key is OtpNavigationKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End';
}

/** A qué casilla lleva una tecla de navegación. Sin vuelta: en los extremos se queda. */
export function navigateOtp(index: number, key: OtpNavigationKey, length: number): number {
  switch (key) {
    case 'ArrowLeft':
      return clampOtpIndex(index - 1, length);
    case 'ArrowRight':
      return clampOtpIndex(index + 1, length);
    case 'Home':
      return 0;
    case 'End':
      return clampOtpIndex(length - 1, length);
  }
}
