import { directorySearch, type DirectoryFilters } from './platform-users';
import { readJson } from './read-json';
import { reasonOf, withStepUp, type StepUpAware, type StepUpCancelled } from './step-up';

/**
 * Exportar la lista de usuarios a CSV (USR-16): el directorio de la plataforma con los filtros de la
 * pantalla, o el equipo de un nodo. Los textos (sin I/O) y las llamadas del navegador a las rutas del
 * panel, que nunca lanzan: devuelven el archivo o un mensaje para la pantalla.
 *
 * Exportar es de alto impacto: si el 2FA de la sesión no es de los últimos minutos, `withStepUp` pide
 * el código y repite el pedido una vez (USR-13). Quién puede lo decide el API.
 */

/** Qué se exporta: el directorio de toda la plataforma o el equipo de un nodo. */
export type UsersExportScope = 'platform' | 'node';

/** Como mucho tantas personas por archivo (USER_EXPORT_MAX_USERS del API). */
export const USERS_EXPORT_MAX = 10_000;

/** La nota bajo el botón del directorio. */
export const PLATFORM_EXPORT_NOTE =
  'Se exportan hasta 10.000 personas con estos filtros, una fila por cada nodo.';

/** Lo que dice el botón de Equipo a quien lo toca o lo enfoca: los filtros de la lista no aplican. */
export const TEAM_EXPORT_HINT = 'Descarga un CSV con todo el equipo de este nodo, sin los filtros.';

/** El archivo exportado, listo para guardar. */
export interface UsersExportFile {
  readonly blob: Blob;
  readonly filename: string;
  /** Personas en el archivo. */
  readonly users: number;
  readonly truncated: boolean;
}

function people(n: number): string {
  return n === 1 ? '1 persona' : `${n.toLocaleString('es-CO')} personas`;
}

/** "Exportamos 12 personas." y, si se cortó en el tope, qué quedó afuera. */
export function usersExportDoneMessage(
  file: Pick<UsersExportFile, 'users' | 'truncated'>,
  scope: UsersExportScope,
): string {
  if (file.users === 0) {
    return scope === 'platform'
      ? 'Exportamos el archivo: no hay personas con estos filtros.'
      : 'Exportamos el archivo: este nodo no tiene miembros.';
  }
  if (file.truncated) {
    return scope === 'platform'
      ? `Exportamos ${people(file.users)}: las altas más recientes. Acota los filtros para ver el resto.`
      : `Exportamos ${people(file.users)}: las primeras en sumarse al nodo.`;
  }
  return scope === 'platform'
    ? `Exportamos ${people(file.users)}.`
    : `Exportamos el equipo: ${people(file.users)}.`;
}

/**
 * Por qué no salió el archivo. Los 403 traen su motivo en castellano (el 2FA, "No administras este
 * nodo.", sólo el superadmin) y se muestran tal cual.
 */
export function usersExportErrorMessage(
  status: number,
  apiMessage: string | undefined,
  scope: UsersExportScope,
): string {
  const fromApi = apiMessage?.trim() ?? '';
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) {
    if (fromApi !== '') return fromApi;
    return scope === 'platform'
      ? 'Exportar el directorio es sólo para el superadmin.'
      : 'No tienes permiso para exportar el equipo de este nodo.';
  }
  if (status === 429)
    return 'Exportaste varias veces seguidas. Espera un minuto y vuelve a intentarlo.';
  if (status === 400) return fromApi || 'Los filtros no son válidos. Recarga la página.';
  return 'No pudimos exportar la lista. Inténtalo de nuevo en unos segundos.';
}

/** El nombre del archivo que mandó el API (`attachment; filename="…"`), limpio; si no, uno propio. */
export function usersExportFilename(disposition: string | null, scope: UsersExportScope): string {
  const name = /filename="([^"]+)"/.exec(disposition ?? '')?.[1];
  if (name !== undefined && /^[A-Za-z0-9._-]{1,100}\.csv$/.test(name)) return name;
  return scope === 'platform' ? 'usuarios.csv' : 'equipo.csv';
}

const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

async function download(
  url: string,
  scope: UsersExportScope,
): Promise<StepUpAware<UsersExportFile>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  if (!res.ok) {
    const body = await readJson<unknown>(res);
    const reason = body.ok ? reasonOf(body.data) : undefined;
    return {
      ok: false,
      message: usersExportErrorMessage(res.status, body.ok ? errorOf(body.data) : undefined, scope),
      ...(reason ? { reason } : {}),
    };
  }
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const users = Number(res.headers.get('x-export-users'));
  return {
    ok: true,
    data: {
      blob,
      filename: usersExportFilename(res.headers.get('content-disposition'), scope),
      users: Number.isSafeInteger(users) && users >= 0 ? users : 0,
      truncated: res.headers.get('x-export-truncated') === 'true',
    },
  };
}

/**
 * Exporta el directorio con los filtros de la pantalla (la misma consulta que la lista, sin paginar).
 * Si se cierra el diálogo del código, vuelve `StepUpCancelled`.
 */
export function exportPlatformUsers(
  filters: DirectoryFilters,
): Promise<StepUpAware<UsersExportFile> | StepUpCancelled> {
  const search = directorySearch(filters);
  const url = search === '' ? '/api/admin/exports/users' : `/api/admin/exports/users?${search}`;
  return withStepUp(() => download(url, 'platform'));
}

/** Exporta el equipo entero del nodo. Si se cierra el diálogo del código, `StepUpCancelled`. */
export function exportTeam(
  tenantId: string,
): Promise<StepUpAware<UsersExportFile> | StepUpCancelled> {
  return withStepUp(() =>
    download(`/api/tenants/${encodeURIComponent(tenantId)}/members-export`, 'node'),
  );
}
