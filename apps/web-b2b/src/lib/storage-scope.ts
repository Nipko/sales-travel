/*
 * Alcance de lo que una pantalla guarda en `localStorage` para la sesión: el usuario y la agencia
 * activa. El navegador es compartido (la PC de la oficina, una agencia y su sub-agencia con el
 * mismo usuario): sin alcance, las búsquedas y tarifas que dejó una sesión las leería la siguiente,
 * con la nacionalidad del pasajero y la divulgación de otra agencia (auditoría de flujos de venta,
 * H6).
 *
 * El layout del panel lo fija en el navegador (`BrowserStorageScope`) con lo que leyó del API. Sin
 * alcance no se guarda ni se lee nada: es una comodidad, y la pantalla ya sabe vivir sin ella.
 * Todo acceso a `localStorage` va en try/catch: puede no estar (modo privado) o tirar.
 */

/** Las claves con alcance: la base más `:` y el alcance. */
export const SCOPED_STORAGE_BASES = ['hoteles:busquedas', 'hoteles:tarifas'] as const;
export type ScopedStorageBase = (typeof SCOPED_STORAGE_BASES)[number];

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

let current: string | undefined;

/** El alcance de un usuario en una agencia, o nada si falta o no tiene forma de identificador. */
export function storageScopeOf(
  userId: string | undefined,
  tenantId: string | undefined,
): string | undefined {
  if (userId === undefined || tenantId === undefined) return undefined;
  return ID_RE.test(userId) && ID_RE.test(tenantId) ? `${userId}.${tenantId}` : undefined;
}

/**
 * Fija el alcance de esta pestaña. Sólo en el navegador: en el servidor el módulo lo comparten
 * todos los pedidos y un alcance fijado ahí sería el de otra persona.
 */
export function setStorageScope(scope: string | undefined): void {
  if (typeof window === 'undefined') return;
  current = scope;
}

/** La clave de `base` para la sesión de esta pestaña, o nada sin alcance. */
export function scopedStorageKey(base: ScopedStorageBase): string | undefined {
  return current === undefined ? undefined : `${base}:${current}`;
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** ¿`key` es de `base`, con o sin alcance (la forma sin alcance es la de antes)? */
function belongsTo(key: string, base: string): boolean {
  return key === base || key.startsWith(`${base}:`);
}

/**
 * Borra las claves de `bases` de toda sesión, salvo `keep`. Lo de otro usuario o agencia ya no
 * sirve en este navegador: las cookies son una sola sesión a la vez.
 */
export function forgetScopedStorage(
  bases: readonly ScopedStorageBase[] = SCOPED_STORAGE_BASES,
  keep?: string,
): void {
  const store = storage();
  if (store === undefined) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key !== keep && bases.some((base) => belongsTo(key, base))) {
        doomed.push(key);
      }
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Almacenamiento bloqueado: no quedó nada que borrar que se pueda leer.
  }
}
