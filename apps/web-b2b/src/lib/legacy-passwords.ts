import type { Loaded } from './provider-enablement-client';
import { readJson } from './read-json';
import {
  isStepUpCancelled,
  reasonOf,
  withStepUp,
  type StepUpAware,
  type StepUpCancelled,
} from './step-up';

/**
 * Cuentas heredadas con una contraseña que eligió un admin (USR-14, founder D3 = B), en Plataforma →
 * Usuarios: qué trae el API, cómo se dice cada resultado y las llamadas del navegador, que nunca
 * lanzan.
 *
 * Son las cuentas que nacieron antes del alta por invitación (2026-09-30) con la contraseña que
 * escribió un admin y que nadie cambió. El superadmin las revisa, elige cuáles y les fuerza el
 * cambio: se cierran sus sesiones, no pueden ingresar hasta elegir una contraseña nueva y cada una
 * recibe su propio enlace en su correo. Quién puede (sólo el superadmin) lo decide el API.
 */

/** Cuántas cuentas van por pedido. Espejo de LEGACY_RESET_BATCH_MAX del API (tenants/dto.ts). */
export const LEGACY_RESET_BATCH_MAX = 50;

/** Una cuenta heredada (`GET /admin/legacy-passwords`). */
export interface LegacyAccount {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly activeNodes: number;
  readonly origin: {
    readonly tenantId: string;
    readonly tenantName: string;
    /** Quien eligió la contraseña; `null` si esa cuenta ya no existe. */
    readonly createdByEmail: string | null;
  };
}

export interface LegacyAccountsList {
  readonly users: readonly LegacyAccount[];
  /** Había más que el tope de la lista: al terminar con éstas, aparecen las demás. */
  readonly truncated: boolean;
}

export type LegacySkipReason =
  | 'self'
  | 'suspended'
  | 'already_required'
  | 'password_changed'
  | 'not_candidate';

/** Qué pasó con cada cuenta pedida. */
export type LegacyResetResult =
  | {
      readonly userId: string;
      readonly status: 'sent' | 'email_failed';
      readonly revokedSessions: number;
    }
  | { readonly userId: string; readonly status: 'skipped'; readonly reason: LegacySkipReason }
  /** El API no pudo aplicarlo: la cuenta quedó como estaba. */
  | { readonly userId: string; readonly status: 'failed' }
  /** Su lote no respondió (se cortó la conexión o el servidor): pudo aplicarse o no. */
  | { readonly userId: string; readonly status: 'unknown' }
  /** No se llegó a pedir: un lote anterior falló o se cerró el diálogo del código. */
  | { readonly userId: string; readonly status: 'not_processed' };

/** Una corrida entera, de todos sus lotes. `error`: por qué se detuvo antes de terminar. */
export interface LegacyResetRun {
  readonly results: readonly LegacyResetResult[];
  readonly error: string | null;
}

// ─────────────────────────── Lo que trae el API ───────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseLegacyAccount(value: unknown): LegacyAccount | undefined {
  const r = asRecord(value);
  const origin = asRecord(r?.['origin']);
  const id = str(r?.['id']);
  const email = str(r?.['email']);
  const createdAt = str(r?.['createdAt']);
  const tenantId = str(origin?.['tenantId']);
  const tenantName = str(origin?.['tenantName']);
  if (r === undefined || id === undefined || email === undefined || createdAt === undefined) {
    return undefined;
  }
  if (tenantId === undefined || tenantName === undefined) return undefined;
  return {
    id,
    email,
    name: nullableStr(r['name']) ?? null,
    createdAt,
    lastLoginAt: nullableStr(r['lastLoginAt']) ?? null,
    activeNodes: count(r['activeNodes']) ?? 0,
    origin: {
      tenantId,
      tenantName,
      createdByEmail: nullableStr(origin?.['createdByEmail']) ?? null,
    },
  };
}

/** La lista; `undefined` si la forma no es la esperada (un error, no una lista vacía). */
export function parseLegacyAccountsList(value: unknown): LegacyAccountsList | undefined {
  const r = asRecord(value);
  const users = r?.['users'];
  if (r === undefined || !Array.isArray(users)) return undefined;
  const parsed: LegacyAccount[] = [];
  for (const u of users) {
    const account = parseLegacyAccount(u);
    if (account !== undefined) parsed.push(account);
  }
  return { users: parsed, truncated: r['truncated'] === true };
}

const SKIP_REASONS: readonly LegacySkipReason[] = [
  'self',
  'suspended',
  'already_required',
  'password_changed',
  'not_candidate',
];

function parseResult(value: unknown): LegacyResetResult | undefined {
  const r = asRecord(value);
  const userId = str(r?.['userId']);
  const status = r?.['status'];
  if (r === undefined || userId === undefined) return undefined;
  if (status === 'sent' || status === 'email_failed') {
    return { userId, status, revokedSessions: count(r['revokedSessions']) ?? 0 };
  }
  if (status === 'skipped') {
    const reason = SKIP_REASONS.find((s) => s === r['reason']) ?? 'not_candidate';
    return { userId, status, reason };
  }
  if (status === 'failed') return { userId, status };
  return undefined;
}

/** Los resultados de un lote (`{ results, counts }`); `undefined` si no se entienden. */
export function parseLegacyResetBatch(value: unknown): LegacyResetResult[] | undefined {
  const results = asRecord(value)?.['results'];
  if (!Array.isArray(results)) return undefined;
  const out: LegacyResetResult[] = [];
  for (const item of results) {
    const parsed = parseResult(item);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

/** `items` en grupos de hasta `size`, en orden. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─────────────────────────── Cómo se dice ───────────────────────────

export function legacyAccountName(account: Pick<LegacyAccount, 'name' | 'email'>): string {
  return account.name?.trim() || account.email;
}

function cuentas(n: number): string {
  return n === 1 ? '1 cuenta' : `${n.toLocaleString('es-CO')} cuentas`;
}

/** El aviso en Plataforma → Usuarios. Sin cuentas, nada que decir. */
export function legacyCalloutText(list: LegacyAccountsList): string | null {
  const n = list.users.length;
  if (n === 0) return null;
  if (list.truncated) {
    return `Hay más de ${cuentas(n)} con una contraseña que eligió un admin antes del alta por invitación.`;
  }
  return n === 1
    ? 'Hay 1 cuenta con una contraseña que eligió un admin antes del alta por invitación.'
    : `Hay ${cuentas(n)} con una contraseña que eligió un admin antes del alta por invitación.`;
}

export const LEGACY_DIALOG_COPY = {
  title: 'Contraseñas elegidas por un admin',
  description:
    'Estas cuentas se crearon antes del alta por invitación (30 de septiembre de 2026) con una contraseña que escribió un admin, y nadie la cambió desde entonces. Elige a cuáles forzarles el cambio: cada persona recibe un enlace en su correo para elegir la suya.',
  truncated:
    'Mostramos las 500 más recientes. Cuando termines con éstas, vuelve a abrir la lista para ver las demás.',
  selectAll: 'Seleccionar todas',
  empty: 'No quedan cuentas con una contraseña elegida por un admin.',
  close: 'Cerrar',
  cancel: 'Cancelar',
} as const;

/** El botón que fuerza: dice a cuántas. */
export function legacySubmitLabel(selected: number): string {
  return selected === 0 ? 'Elige al menos una cuenta' : `Forzar el cambio a ${cuentas(selected)}`;
}

export interface LegacyConfirmCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

/** La confirmación, con lo que corta. */
export function legacyConfirmCopy(selected: number): LegacyConfirmCopy {
  return {
    title: `Forzar el cambio de contraseña a ${cuentas(selected)}`,
    description:
      selected === 1
        ? 'Se cierran sus sesiones y recibe un enlace para elegir una contraseña nueva. No puede ingresar hasta hacerlo.'
        : 'Se cierran sus sesiones y cada persona recibe un enlace para elegir una contraseña nueva. No pueden ingresar hasta hacerlo.',
    confirmLabel: 'Forzar el cambio',
  };
}

/** Mientras corre: cuántas van de cuántas. */
export function legacyProgressLabel(done: number, total: number): string {
  return `Forzando el cambio… ${done} de ${total}`;
}

export type LegacyResultTone = 'ok' | 'warn' | 'danger' | 'muted';

export interface LegacyResultView {
  readonly label: string;
  readonly hint: string | null;
  readonly tone: LegacyResultTone;
}

const SKIP_LABELS: Readonly<Record<LegacySkipReason, string>> = {
  self: 'Omitida: es tu cuenta',
  suspended: 'Omitida: la cuenta está suspendida',
  already_required: 'Omitida: ya tenía el cambio pendiente',
  password_changed: 'Omitida: ya eligió su propia contraseña',
  not_candidate: 'Omitida: ya no es una cuenta heredada',
};

/** Cómo se dice el resultado de una cuenta, y qué hacer si hace falta. */
export function legacyResultView(result: LegacyResetResult): LegacyResultView {
  switch (result.status) {
    case 'sent':
      return { label: 'Enlace enviado', hint: null, tone: 'ok' };
    case 'email_failed':
      return {
        label: 'Cambio forzado, pero el correo no salió',
        hint: 'Al intentar ingresar le llega otro enlace. Revisa el correo de su nodo.',
        tone: 'warn',
      };
    case 'skipped':
      return { label: SKIP_LABELS[result.reason], hint: null, tone: 'muted' };
    case 'failed':
      return {
        label: 'No pudimos forzar el cambio',
        hint: 'Su cuenta quedó como estaba. Inténtalo de nuevo.',
        tone: 'danger',
      };
    case 'unknown':
      return {
        label: 'Sin confirmar',
        hint: 'El servidor no respondió a tiempo: vuelve a abrir la lista para ver si quedó forzada.',
        tone: 'warn',
      };
    case 'not_processed':
      return { label: 'Sin procesar', hint: null, tone: 'muted' };
  }
}

/** El aviso al terminar: cuántas quedaron obligadas y cuántas no. */
export function legacyDoneMessage(run: LegacyResetRun): string {
  let forced = 0;
  let skipped = 0;
  let mailFailed = 0;
  let unknown = 0;
  for (const r of run.results) {
    if (r.status === 'sent' || r.status === 'email_failed') forced += 1;
    if (r.status === 'email_failed') mailFailed += 1;
    if (r.status === 'skipped') skipped += 1;
    if (r.status === 'unknown') unknown += 1;
  }
  const parts: string[] = [];
  if (forced === 1) parts.push('Listo: 1 cuenta tiene que elegir una contraseña nueva.');
  else if (forced > 1) {
    parts.push(`Listo: ${cuentas(forced)} tienen que elegir una contraseña nueva.`);
  } else if (unknown === 0) parts.push('No se forzó el cambio a ninguna cuenta.');
  // Sin respuesta pudo aplicarse: decir "ninguna" sería falso.
  if (unknown > 0) {
    parts.push(
      unknown === 1
        ? '1 cuenta quedó sin confirmar.'
        : `${cuentas(unknown)} quedaron sin confirmar.`,
    );
  }
  if (skipped > 0) parts.push(skipped === 1 ? '1 se omitió.' : `${skipped} se omitieron.`);
  if (mailFailed > 0) {
    parts.push(
      mailFailed === 1
        ? 'A 1 no le llegó el correo: al intentar ingresar le llega otro.'
        : `A ${mailFailed} no les llegó el correo: al intentar ingresar les llega otro.`,
    );
  }
  return parts.join(' ');
}

/** Por qué no cargó la lista. */
export function legacyLoadError(status: number, message: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return message?.trim() || 'Esta pantalla es sólo para el superadmin.';
  if (status >= 500) {
    return 'No pudimos cargar las cuentas: el servidor no respondió. Inténtalo de nuevo en unos minutos.';
  }
  return message?.trim() || 'No pudimos cargar las cuentas. Inténtalo de nuevo.';
}

/** Por qué no se aplicó un lote. Los 4xx traen su motivo en castellano. */
export function legacyResetError(status: number, message: string | undefined): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 429)
    return 'Forzaste varios lotes seguidos. Espera un minuto y vuelve a intentarlo.';
  if (status >= 500) {
    return 'El servidor no respondió a tiempo. Vuelve a abrir la lista para ver qué cuentas quedaron forzadas.';
  }
  return (
    message?.trim() ||
    (status === 403
      ? 'Esta acción es sólo para el superadmin.'
      : 'No pudimos forzar el cambio. Inténtalo de nuevo.')
  );
}

// ─────────────────────────── Las llamadas ───────────────────────────

const UNREADABLE = 'El servidor respondió algo que no pudimos leer. Recarga la página.';
const OFFLINE = 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
const STOPPED = 'No confirmaste el código: las demás cuentas quedaron sin procesar.';

/** El fallo lleva el `reason` del API cuando vino, y el estado (0 sin conexión). */
type Called<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly reason?: string;
      readonly status: number;
    };

async function call<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
  errorMessage: (status: number, message: string | undefined) => string,
): Promise<Called<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { ok: false, message: OFFLINE, status: 0 };
  }
  const read = await readJson<unknown>(res);
  if (!res.ok) {
    const reason = read.ok ? reasonOf(read.data) : undefined;
    const message = read.ok ? str(asRecord(read.data)?.['error']) : undefined;
    return {
      ok: false,
      message: errorMessage(res.status, message),
      status: res.status,
      ...(reason ? { reason } : {}),
    };
  }
  if (!read.ok) return { ok: false, message: read.message, status: res.status };
  const data = parse(read.data);
  return data === undefined
    ? { ok: false, message: UNREADABLE, status: res.status }
    : { ok: true, data };
}

/** La lista para revisar. */
export async function loadLegacyAccounts(): Promise<Loaded<LegacyAccountsList>> {
  const res = await call(
    '/api/admin/legacy-passwords',
    {},
    parseLegacyAccountsList,
    legacyLoadError,
  );
  return res.ok ? res : { ok: false, message: res.message };
}

function postBatch(userIds: readonly string[]): Promise<Called<LegacyResetResult[]>> {
  return call(
    '/api/admin/legacy-passwords/require-reset',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userIds }),
    },
    parseLegacyResetBatch,
    legacyResetError,
  );
}

/**
 * Fuerza el cambio a las cuentas elegidas, en lotes de {@link LEGACY_RESET_BATCH_MAX} y de a uno.
 * Es de alto impacto: si el 2FA de la sesión no es de los últimos minutos, `withStepUp` pide el
 * código y repite el lote una vez (USR-13).
 *
 * Si el API rechaza el primer lote (o se cierra el diálogo del código), no se hizo nada: vuelve el
 * error (o `StepUpCancelled`). Si un lote no tiene respuesta (sin conexión, 5xx o el corte del borde
 * a los 100 s), la corrida se detiene y lo dice: las de ese lote quedan `unknown` (el servidor pudo
 * aplicarlo, también si es el primero) y las de los siguientes `not_processed`. Si el API rechaza
 * uno posterior, ése y los siguientes quedan `not_processed`.
 *
 * `onProgress` recibe cuántas cuentas ya tienen respuesta.
 */
export async function requireLegacyResets(
  userIds: readonly string[],
  onProgress?: (done: number) => void,
): Promise<StepUpAware<LegacyResetRun> | StepUpCancelled> {
  const batches = chunk(userIds, LEGACY_RESET_BATCH_MAX);
  const results: LegacyResetResult[] = [];
  for (const [i, batch] of batches.entries()) {
    const res = await withStepUp(() => postBatch(batch));
    if (isStepUpCancelled(res) || !res.ok) {
      const uncertain = !isStepUpCancelled(res) && (res.status === 0 || res.status >= 500);
      // Sin respuesta, ni siquiera el primero se da por no hecho: el servidor sigue aunque el borde
      // corte, y la lista que quedó abierta ya no dice la verdad.
      if (i === 0 && !uncertain) {
        if (isStepUpCancelled(res)) return res;
        return { ok: false, message: res.message, ...(res.reason ? { reason: res.reason } : {}) };
      }
      for (const userId of batch) {
        results.push({ userId, status: uncertain ? 'unknown' : 'not_processed' });
      }
      for (const rest of batches.slice(i + 1)) {
        for (const userId of rest) results.push({ userId, status: 'not_processed' });
      }
      return {
        ok: true,
        data: { results, error: isStepUpCancelled(res) ? STOPPED : res.message },
      };
    }
    // Uno por cuenta pedida, en su orden: lo que el API no devolvió no se da por hecho.
    const byId = new Map(res.data.map((r) => [r.userId.toLowerCase(), r]));
    for (const userId of batch) {
      results.push(byId.get(userId.toLowerCase()) ?? { userId, status: 'unknown' });
    }
    onProgress?.(results.length);
  }
  return { ok: true, data: { results, error: null } };
}
