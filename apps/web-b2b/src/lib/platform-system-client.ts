import { parseSystemJobs, systemErrorMessage, type SystemJobs } from './platform-system';
import { readJson } from './read-json';

/**
 * La llamada del navegador a Sistema › Procesos (`/api/admin/system/jobs`). Devuelve datos ya
 * validados o un mensaje para la pantalla; nunca lanza.
 */

export type SystemResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

export async function loadSystemJobs(): Promise<SystemResult<SystemJobs>> {
  let res: Response;
  try {
    res = await fetch('/api/admin/system/jobs', { cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, message: OFFLINE };
  }
  const body = await readJson<unknown>(res);
  if (!body.ok) return { ok: false, status: res.status, message: body.message };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: systemErrorMessage(res.status, errorOf(body.data)),
    };
  }
  const data = parseSystemJobs(body.data);
  return data === undefined
    ? { ok: false, status: res.status, message: UNREADABLE }
    : { ok: true, data };
}
