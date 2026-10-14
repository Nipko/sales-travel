/**
 * Cómo se nombra a la persona en la barra de arriba: su nombre visible (Mi cuenta → Perfil) y, si
 * lo tiene, el correo debajo en el menú. Sin nombre (una cuenta vieja), el correo; sin ninguno de
 * los dos, "Usuario". Se pinta como texto: React lo escapa.
 */
export interface AccountDisplay {
  /** Lo que se lee primero: en el botón de la barra y arriba en el menú. */
  readonly primary: string;
  /** El correo, si `primary` es el nombre. */
  readonly secondary?: string;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function accountDisplay(
  name: string | undefined,
  email: string | undefined,
): AccountDisplay {
  const n = present(name);
  const e = present(email);
  if (n !== undefined) return e === undefined ? { primary: n } : { primary: n, secondary: e };
  return { primary: e ?? 'Usuario' };
}
