import { sql } from '../api/support/cliente';

/**
 * INF-5 (docs/qa/01 §7): el reloj de las pruebas. Nada espera minutos ni días: se mueve en la base
 * la fecha que decide el vencimiento. Sólo las columnas de la lista, para que un typo no reescriba
 * otra cosa.
 */
const VENCIMIENTOS = {
  mfa_challenges: 'expires_at',
  password_reset_tokens: 'expires_at',
  user_invitations: 'expires_at',
  quotations: 'expires_at',
  sessions: 'last_seen_at',
  users: 'locked_until',
} as const;

export type TablaConVencimiento = keyof typeof VENCIMIENTOS;

/**
 * Corre hacia atrás la fecha de vencimiento de las filas que cumplen `donde` (SQL con `$1…`), como
 * si hubiera pasado `intervalo` (`'2 hours'`, `'8 days'`). Devuelve cuántas filas movió.
 */
export async function atrasar(
  tabla: TablaConVencimiento,
  intervalo: string,
  donde: string,
  params: unknown[] = [],
): Promise<number> {
  const columna = VENCIMIENTOS[tabla];
  const n = params.length + 1;
  const filas = await sql<{ id: unknown }>(
    `UPDATE ${tabla} SET ${columna} = ${columna} - $${n}::interval WHERE ${donde} RETURNING 1 AS id`,
    [...params, intervalo],
  );
  return filas.length;
}

/** Deja vencido ya (un segundo atrás) lo que cumple `donde`. */
export async function vencer(
  tabla: TablaConVencimiento,
  donde: string,
  params: unknown[] = [],
): Promise<number> {
  const columna = VENCIMIENTOS[tabla];
  const filas = await sql<{ id: unknown }>(
    `UPDATE ${tabla} SET ${columna} = now() - interval '1 second' WHERE ${donde} RETURNING 1 AS id`,
    params,
  );
  return filas.length;
}
