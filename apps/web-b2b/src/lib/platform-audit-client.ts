import {
  activityErrorMessage,
  activityExportErrorMessage,
  activitySearch,
  effectivePeriod,
  exportFilename,
  parseActivityPage,
  type ActivityFilters,
  type ActivityPage,
} from './platform-audit';
import { readJson } from './read-json';
import { reasonOf, withStepUp, type StepUpAware, type StepUpCancelled } from './step-up';

/**
 * Las llamadas del navegador a Plataforma → Actividad (`/api/admin/audit`): la lista y la
 * exportación. Devuelven datos ya validados o un mensaje para la pantalla; nunca lanzan.
 */

export type ActivityResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string };

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

/**
 * Una página de la actividad con estos filtros; `cursor` para la siguiente. `limit` acorta la página
 * (la actividad reciente de la ficha de un nodo); sin él, la del API.
 */
export async function loadPlatformActivity(
  filters: ActivityFilters,
  now: Date,
  cursor?: string | null,
  limit?: number,
): Promise<ActivityResult<ActivityPage>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/audit?${activitySearch(filters, now, cursor, limit)}`, {
      cache: 'no-store',
    });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const body = await readJson<unknown>(res);
  if (!res.ok) {
    return {
      ok: false,
      message: activityErrorMessage(res.status, body.ok ? errorOf(body.data) : undefined),
    };
  }
  if (!body.ok) return { ok: false, message: UNREADABLE };
  const page = parseActivityPage(body.data);
  return page === undefined ? { ok: false, message: UNREADABLE } : { ok: true, data: page };
}

/** El archivo exportado, listo para guardar. */
export interface ActivityExportFile {
  readonly blob: Blob;
  readonly filename: string;
  readonly rows: number;
  readonly truncated: boolean;
}

async function requestExport(
  filters: ActivityFilters,
  now: Date,
): Promise<StepUpAware<ActivityExportFile>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/audit/export?${activitySearch(filters, now)}`, {
      cache: 'no-store',
    });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  if (!res.ok) {
    const body = await readJson<unknown>(res);
    const reason = body.ok ? reasonOf(body.data) : undefined;
    return {
      ok: false,
      message: activityExportErrorMessage(res.status, body.ok ? errorOf(body.data) : undefined),
      ...(reason ? { reason } : {}),
    };
  }
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return { ok: false, message: OFFLINE };
  }
  const rows = Number(res.headers.get('x-export-rows'));
  return {
    ok: true,
    data: {
      blob,
      filename: exportFilename(
        res.headers.get('content-disposition'),
        effectivePeriod(filters, now),
      ),
      rows: Number.isSafeInteger(rows) && rows >= 0 ? rows : 0,
      truncated: res.headers.get('x-export-truncated') === 'true',
    },
  };
}

/**
 * Exporta la vista filtrada a CSV. Es de alto impacto: si el 2FA de la sesión no es de los últimos
 * minutos, `withStepUp` pide el código y la repite una vez (USR-13). Si se cierra el diálogo, vuelve
 * `StepUpCancelled`.
 */
export function exportPlatformActivity(
  filters: ActivityFilters,
  now: Date,
): Promise<StepUpAware<ActivityExportFile> | StepUpCancelled> {
  return withStepUp(() => requestExport(filters, now));
}

/** Guarda el archivo en el equipo (la descarga del navegador). */
export function saveFile(file: Pick<ActivityExportFile, 'blob' | 'filename'>): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Después de que el navegador tomó la descarga.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
