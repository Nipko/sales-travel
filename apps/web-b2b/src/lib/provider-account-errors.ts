import type { Notice } from './provider-forms';

/*
 * El rechazo de guardar una cuenta de proveedor que todavía tiene reservas vivas (docs/tbo/08
 * RF-29 CA 2; 04 §11, HARD-4): `POST /provider-accounts` responde 409 `PROVIDER_ACCOUNT_IN_USE` si
 * el cambio la desactiva, la apunta a otra cuenta del proveedor o deja de heredarla, porque es la
 * única con la que el proveedor deja consultar y cancelar esas reservas.
 *
 * No es un error del formulario ni de conexión: la cuenta sigue como estaba y hay algo que el
 * operador sí puede hacer (rotar la contraseña del mismo usuario, o esperar a que terminen). Por eso
 * se muestra como aviso, con el motivo, y no en rojo como "Error al guardar".
 */

export const PROVIDER_ACCOUNT_IN_USE = 'PROVIDER_ACCOUNT_IN_USE';

export type ProviderAccountSaveError =
  | { readonly kind: 'in-use'; readonly notice: Notice }
  | { readonly kind: 'error'; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(body: Record<string, unknown>): string | undefined {
  const m = body['message'];
  if (typeof m === 'string' && m.trim()) return m.trim();
  if (Array.isArray(m)) {
    const joined = m.filter((x): x is string => typeof x === 'string').join(', ');
    if (joined) return joined;
  }
  const e = body['error'];
  return typeof e === 'string' && e.trim() ? e.trim() : undefined;
}

/** Cuántas reservas activas informó el API, o `null` si no pudo contarlas (o no lo dijo). */
function activeOrdersOf(body: Record<string, unknown>): number | null {
  const details = body['details'];
  const n = isRecord(details) ? details['activeOrders'] : undefined;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * El error de guardar una cuenta, leído de la respuesta de `POST /api/provider-accounts`. El motivo
 * sólo se reconoce por su código, nunca por el texto: el texto lo redacta el API según el cambio
 * (desactivar, cambiar de usuario, dejar de heredar) y se muestra tal cual.
 */
export function providerAccountSaveError(
  status: number,
  body: unknown,
  fallback: string,
): ProviderAccountSaveError {
  const b = isRecord(body) ? body : {};
  const message = messageOf(b);
  if (status === 409 && b['reason'] === PROVIDER_ACCOUNT_IN_USE) {
    const active = activeOrdersOf(b);
    return {
      kind: 'in-use',
      notice: {
        tone: 'warn',
        title:
          active === null
            ? 'No se guardó: no pudimos comprobar si la cuenta tiene reservas activas'
            : `No se guardó: la cuenta tiene ${active} ${active === 1 ? 'reserva activa' : 'reservas activas'}`,
        body:
          message ??
          'Mientras haya reservas activas hechas con esta cuenta no se puede desactivar, cambiar de usuario ni dejar de heredar. Podés actualizar la contraseña del mismo usuario.',
      },
    };
  }
  return { kind: 'error', message: message ?? fallback };
}
