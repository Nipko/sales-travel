import {
  announcementErrorMessage,
  parseAdminAnnouncement,
  parseAdminAnnouncements,
  type AdminAnnouncement,
} from './announcements';
import { readJson } from './read-json';

/**
 * Las llamadas del navegador a Plataforma → Sistema › Anuncios (`/api/admin/announcements`).
 * Devuelven datos ya validados o un mensaje para la pantalla; nunca lanzan.
 */

export type AnnouncementsResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

async function call<T>(
  url: string,
  init: RequestInit,
  parse: (raw: unknown) => T | undefined,
): Promise<AnnouncementsResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, status: 0, message: OFFLINE };
  }
  const body = await readJson<unknown>(res);
  if (!body.ok) return { ok: false, status: res.status, message: body.message };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: announcementErrorMessage(res.status, errorOf(body.data)),
    };
  }
  const data = parse(body.data);
  return data === undefined
    ? { ok: false, status: res.status, message: UNREADABLE }
    : { ok: true, data };
}

function json(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function loadAnnouncements(): Promise<AnnouncementsResult<AdminAnnouncement[]>> {
  return call('/api/admin/announcements', {}, parseAdminAnnouncements);
}

export function createAnnouncement(
  body: Record<string, unknown>,
): Promise<AnnouncementsResult<AdminAnnouncement>> {
  return call('/api/admin/announcements', json('POST', body), parseAdminAnnouncement);
}

export function updateAnnouncement(
  id: string,
  patch: Record<string, unknown>,
): Promise<AnnouncementsResult<AdminAnnouncement>> {
  return call(
    `/api/admin/announcements/${encodeURIComponent(id)}`,
    json('PATCH', patch),
    parseAdminAnnouncement,
  );
}

export function archiveAnnouncement(id: string): Promise<AnnouncementsResult<AdminAnnouncement>> {
  return call(
    `/api/admin/announcements/${encodeURIComponent(id)}/archive`,
    { method: 'POST' },
    parseAdminAnnouncement,
  );
}
