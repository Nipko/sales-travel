/**
 * Derivación de los tokens de tema a partir del color que elige cada agencia.
 *
 * Antes, AppShell inyectaba el hex crudo en `--color-primary` y ADEMÁS en
 * `--color-primary-hover`, con lo que el estado hover quedaba muerto en cuanto un tenant
 * configuraba su color. Tampoco derivaba `--color-primary-fg`: el texto encima del color
 * era blanco fijo, así que una agencia que eligiera amarillo o lima terminaba con botones
 * ilegibles y sin ninguna advertencia.
 *
 * Acá se derivan hover y foreground del color elegido, y se informa el ratio de contraste
 * para poder avisar en la UI cuando una marca no llega a WCAG AA.
 */

export interface BrandTokens {
  primary: string;
  primaryHover: string;
  primaryFg: string;
  /** Contraste real de primaryFg sobre primary. AA para texto normal exige 4.5. */
  contrastRatio: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Sólo hex de 6 dígitos: es lo que emite el input de color y lo que valida la API. */
export function isValidHex(value: string | null | undefined): value is string {
  return typeof value === 'string' && HEX.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).padStart(6, '0')}`;
}

/** Canal sRGB a lineal (WCAG 2.x §relative luminance). */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Texto legible sobre un fondo dado: blanco o el gris casi negro del design system,
 * el que dé más contraste. Evita el blanco-sobre-amarillo.
 */
export function readableForeground(background: string): string {
  const onWhite = contrastRatio(background, '#ffffff');
  const onInk = contrastRatio(background, '#141519');
  return onWhite >= onInk ? '#ffffff' : '#141519';
}

/** Oscurece (o aclara, si ya es muy oscuro) para el estado hover. */
function shiftForHover(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  if (relativeLuminance(hex) < 0.12) {
    // Aclarado ADITIVO, no multiplicativo: con negro puro cualquier factor deja 0 y el
    // hover quedaría idéntico al color base, que es justo el bug que esto arregla.
    const lift = 38;
    return rgbToHex(r + lift, g + lift, b + lift);
  }
  return rgbToHex(r * 0.86, g * 0.86, b * 0.86);
}

export function deriveBrandTokens(primary: string): BrandTokens {
  const primaryFg = readableForeground(primary);
  return {
    primary,
    primaryHover: shiftForHover(primary),
    primaryFg,
    contrastRatio: contrastRatio(primary, primaryFg),
  };
}

/**
 * CSS de las variables del tenant, con alcance `:root`.
 *
 * `:root` y no el style de un div: los Portals de React (toasts de sonner, diálogos)
 * se montan fuera del árbol del shell, así que con un style inline se quedaban con los
 * colores de la plataforma en lugar de los de la agencia.
 *
 * Los valores se re-validan acá aunque la API ya los valide: esta cadena se interpola en
 * un <style>, así que un valor que no sea un hex estricto no debe llegar nunca al DOM.
 */
export function brandStyleSheet(
  primary: string | null | undefined,
  accent: string | null | undefined,
): string | null {
  const decls: string[] = [];

  if (isValidHex(primary)) {
    const t = deriveBrandTokens(primary);
    decls.push(
      `--color-primary:${t.primary}`,
      `--color-primary-hover:${t.primaryHover}`,
      `--color-primary-fg:${t.primaryFg}`,
    );
  }
  if (isValidHex(accent)) {
    decls.push(`--color-accent:${accent}`, `--color-accent-fg:${readableForeground(accent)}`);
  }

  return decls.length > 0 ? `:root{${decls.join(';')}}` : null;
}
