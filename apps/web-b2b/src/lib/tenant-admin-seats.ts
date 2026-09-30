import { deviceLabel } from './tenant-admin-format';

/**
 * Puestos simultáneos e inactividad de un nodo (decisiones del founder, 2026-09-29): cuántas
 * sesiones a la vez admite su cupo, de quién lo hereda y quiénes lo ocupan ahora. Sin I/O.
 *
 * Un nodo sin cupo propio consume el del ancestro más cercano que lo tenga, y si ninguno lo tiene
 * no hay límite; la inactividad se hereda igual, con 30 min por defecto. Lo fija sólo el
 * superadmin; el admin del nodo sólo lo ve y puede desconectar a alguien de su subárbol.
 */

/** Rangos del API (`PATCH /admin/tenants/:id/seats`) y de los CHECK de 0055. */
export const SEATS_MIN = 1;
export const SEATS_MAX = 10_000;
export const IDLE_MIN = 5;
export const IDLE_MAX = 480;
export const DEFAULT_IDLE_MINUTES = 30;

/** Las opciones de cierre por inactividad que ofrece el panel, en minutos. */
export const IDLE_OPTIONS: readonly number[] = [5, 10, 15, 30, 60, 120, 240, 480];

/** Una sesión que ocupa un puesto del cupo (`GET /tenants/:id/seats`). */
export interface SeatSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly name: string | null;
  readonly email: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly issuedAt: string;
  readonly lastSeenAt: string;
  readonly ip: string | null;
  /** El user-agent tal como lo registró el API. */
  readonly device: string | null;
  /** Es la sesión de quien mira: no se puede desconectar a sí mismo desde acá. */
  readonly current: boolean;
}

export interface SeatsView {
  /** El nodo cuyo cupo se consume: el propio o el ancestro que lo fija. `null` = sin límite. */
  readonly poolTenantId: string | null;
  readonly poolTenantName: string | null;
  /** El cupo viene de un ancestro, no del nodo. */
  readonly inherited: boolean;
  readonly limit: number | null;
  readonly inUse: number;
  readonly idleTimeoutMinutes: number;
  readonly idleInherited: boolean;
  /** Lo que el nodo fija por sí mismo; `null` = hereda. */
  readonly ownSeats: number | null;
  readonly ownIdleTimeoutMinutes: number | null;
  readonly sessions: readonly SeatSession[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return count(value);
}

function parseSession(value: unknown): SeatSession | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const sessionId = str(r['sessionId']);
  const userId = str(r['userId']);
  const email = str(r['email']);
  const lastSeenAt = str(r['lastSeenAt']);
  if (sessionId === undefined || userId === undefined || email === undefined) return undefined;
  if (lastSeenAt === undefined) return undefined;
  return {
    sessionId,
    userId,
    name: nullableStr(r['name']),
    email,
    tenantId: str(r['tenantId']) ?? '',
    tenantName: str(r['tenantName']) ?? '',
    issuedAt: str(r['issuedAt']) ?? lastSeenAt,
    lastSeenAt,
    ip: nullableStr(r['ip']),
    device: nullableStr(r['device']) ?? nullableStr(r['userAgent']),
    current: r['current'] === true,
  };
}

/**
 * La vista de `GET /tenants/:id/seats`. `undefined` si la forma no es la esperada: un error no se
 * muestra como "nadie conectado". Una sesión incompleta se descarta, no tumba la tarjeta.
 */
export function parseSeatsView(value: unknown): SeatsView | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const inUse = count(r['inUse']);
  const limit = nullableCount(r['limit']);
  const ownSeats = nullableCount(r['ownSeats']);
  const ownIdle = nullableCount(r['ownIdleTimeoutMinutes']);
  const idle = count(r['idleTimeoutMinutes']);
  const sessions = r['sessions'];
  if (inUse === undefined || limit === undefined || ownSeats === undefined) return undefined;
  if (ownIdle === undefined || !Array.isArray(sessions)) return undefined;
  return {
    poolTenantId: nullableStr(r['poolTenantId']),
    poolTenantName: nullableStr(r['poolTenantName']),
    inherited: r['inherited'] === true,
    limit,
    inUse,
    idleTimeoutMinutes: idle !== undefined && idle > 0 ? idle : DEFAULT_IDLE_MINUTES,
    idleInherited: r['idleInherited'] === true,
    ownSeats,
    ownIdleTimeoutMinutes: ownIdle,
    sessions: sessions.flatMap((s) => {
      const parsed = parseSession(s);
      return parsed === undefined ? [] : [parsed];
    }),
  };
}

/** "30 min", "1 h", "8 h". */
export function idleLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export type SeatTone = 'ok' | 'warn' | 'full' | 'unlimited';

export interface SeatUsage {
  /** "3 de 5 en uso" o "Sin límite". */
  readonly headline: string;
  /** Lo que se lee junto al número: los puestos libres, o que sin límite no se cuentan. */
  readonly detail: string;
  /** Para la barra: `undefined` sin límite. Acotado a 0..1 aunque haya más en uso que el cupo. */
  readonly ratio: number | undefined;
  readonly tone: SeatTone;
  /** El texto accesible del medidor. */
  readonly valueText: string;
  /** "Compartido con Consolidador Andino" si el cupo es de un ancestro. */
  readonly shared: string | undefined;
  /** "Se cierra tras 30 min sin actividad", con de dónde sale. */
  readonly idle: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Lo que dice la tarjeta "Puestos simultáneos". */
export function seatUsage(view: SeatsView): SeatUsage {
  const idle = `Se cierra tras ${idleLabel(view.idleTimeoutMinutes)} sin actividad${
    view.idleInherited ? ' (heredado)' : ''
  }.`;
  const shared =
    view.inherited && view.poolTenantName !== null
      ? `Compartido con ${view.poolTenantName}`
      : undefined;
  if (view.limit === null) {
    // Sin cupo las sesiones no ocupan puesto y el API no las cuenta: `inUse` llega en 0 y
    // `sessions` vacío aunque haya gente trabajando. Dar ese número sería afirmar que no hay nadie.
    return {
      headline: 'Sin límite',
      detail: 'Este nodo no cuenta puestos: se puede conectar cualquier cantidad de personas.',
      ratio: undefined,
      tone: 'unlimited',
      valueText: 'Sin límite de puestos.',
      shared: undefined,
      idle,
    };
  }
  const free = Math.max(0, view.limit - view.inUse);
  const ratio = view.limit > 0 ? Math.min(1, view.inUse / view.limit) : 1;
  const tone: SeatTone = free === 0 ? 'full' : ratio >= 0.8 ? 'warn' : 'ok';
  return {
    headline: `${view.inUse} de ${view.limit} en uso`,
    detail:
      free === 0
        ? 'Cupo lleno: nadie más puede ingresar hasta que se libere un puesto.'
        : `${plural(free, 'puesto libre', 'puestos libres')}.`,
    ratio,
    tone,
    valueText: `${view.inUse} de ${view.limit} puestos en uso`,
    shared,
    idle,
  };
}

/** Las sesiones en el orden en que se leen: la más reciente arriba, la propia primero. */
export function orderedSessions(sessions: readonly SeatSession[]): SeatSession[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  });
}

/** El nombre con que se muestra a quien ocupa un puesto. */
export function sessionPerson(session: Pick<SeatSession, 'name' | 'email'>): string {
  return session.name?.trim() || session.email;
}

/** La confirmación de "Desconectar". */
export function releaseConfirm(session: SeatSession): {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
} {
  const who = sessionPerson(session);
  return {
    title: `Desconectar a ${who}`,
    description: `Se cierra su sesión en ${deviceLabel(session.device)} y se libera el puesto. Si estaba trabajando, pierde lo que no haya guardado y tiene que volver a ingresar.`,
    confirmLabel: 'Desconectar',
  };
}

/**
 * El mensaje de un "Desconectar" rechazado. Un 404 es que la sesión ya se cerró sola (salió, venció
 * o la liberó otro admin): no es un fallo, la lista se refresca.
 */
export function seatReleaseError(status: number, message: string | undefined): string {
  const text = message?.trim() ?? '';
  if (status === 401) return 'Tu sesión venció. Volvé a iniciar sesión.';
  if (status === 404) return 'Esa sesión ya se había cerrado. Actualizamos la lista.';
  if (status === 403) {
    return text !== ''
      ? `No lo pudimos hacer: ${text}`
      : 'No administrás el nodo de esa sesión: pedíselo a quien lo administra.';
  }
  if (text !== '') return text;
  return status >= 500
    ? 'No pudimos desconectarla. Probá de nuevo en unos minutos.'
    : 'No pudimos desconectarla.';
}

// ── Política de puestos e inactividad (lo edita el superadmin) ────────────────────────────────

/** El borrador del formulario. `''` en inactividad = heredar. */
export interface SeatPolicyDraft {
  readonly seatsMode: 'inherit' | 'own';
  readonly seats: string;
  readonly idle: string;
}

export interface SeatPolicyPayload {
  readonly concurrentSeats: number | null;
  readonly idleTimeoutMinutes: number | null;
}

export type SeatPolicyErrors = Partial<Record<'seats' | 'idle', string>>;

/** Un entero de puestos escrito por una persona: sólo dígitos, dentro del rango del API. */
export function parseSeats(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= SEATS_MIN && n <= SEATS_MAX ? n : undefined;
}

/**
 * Minutos de inactividad: un entero en el rango del API. El panel ofrece `IDLE_OPTIONS`, pero un
 * nodo puede tener guardado otro valor (el PATCH acepta cualquiera entre 5 y 480): si se rechazara,
 * ese nodo no se podría volver a guardar sin cambiarle la inactividad.
 */
export function parseIdle(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= IDLE_MIN && n <= IDLE_MAX ? n : undefined;
}

/**
 * Las opciones del select de inactividad: las del panel y, si el nodo tiene guardado otro valor,
 * también ése. Sin él, el `<select>` no encuentra su valor y muestra la primera opción ("Heredar"),
 * que no es lo que rige. Sale de lo guardado y no del borrador, para que elegir otra opción no haga
 * desaparecer la que tenía.
 */
export function idleChoices(saved: number | null): readonly number[] {
  if (saved === null || saved < IDLE_MIN || saved > IDLE_MAX || IDLE_OPTIONS.includes(saved)) {
    return IDLE_OPTIONS;
  }
  return [...IDLE_OPTIONS, saved].sort((a, b) => a - b);
}

export function seatsError(raw: string, required: boolean): string | undefined {
  if (raw.trim() === '') return required ? 'Indicá cuántos puestos simultáneos tiene.' : undefined;
  if (parseSeats(raw) !== undefined) return undefined;
  return `Un número entero entre ${SEATS_MIN} y ${SEATS_MAX.toLocaleString('es-CO')}.`;
}

export function idleError(raw: string): string | undefined {
  if (raw === '' || parseIdle(raw) !== undefined) return undefined;
  return 'Elegí uno de los tiempos de la lista.';
}

/** El borrador a partir de lo que el nodo fija hoy. */
export function seatPolicyDraftOf(
  view: Pick<SeatsView, 'ownSeats' | 'ownIdleTimeoutMinutes'>,
): SeatPolicyDraft {
  return {
    seatsMode: view.ownSeats === null ? 'inherit' : 'own',
    seats: view.ownSeats === null ? '' : String(view.ownSeats),
    idle: view.ownIdleTimeoutMinutes === null ? '' : String(view.ownIdleTimeoutMinutes),
  };
}

export function validateSeatPolicy(draft: SeatPolicyDraft): SeatPolicyErrors {
  const errors: SeatPolicyErrors = {};
  const seats = draft.seatsMode === 'own' ? seatsError(draft.seats, true) : undefined;
  if (seats !== undefined) errors.seats = seats;
  const idle = idleError(draft.idle);
  if (idle !== undefined) errors.idle = idle;
  return errors;
}

/** Lo que va en el PATCH; `undefined` si el borrador no es válido. */
export function seatPolicyPayload(draft: SeatPolicyDraft): SeatPolicyPayload | undefined {
  if (Object.keys(validateSeatPolicy(draft)).length > 0) return undefined;
  return {
    concurrentSeats: draft.seatsMode === 'own' ? (parseSeats(draft.seats) ?? null) : null,
    idleTimeoutMinutes: draft.idle === '' ? null : (parseIdle(draft.idle) ?? null),
  };
}

/** ¿El borrador cambia algo respecto de lo guardado? */
export function seatPolicyChanged(
  draft: SeatPolicyDraft,
  view: Pick<SeatsView, 'ownSeats' | 'ownIdleTimeoutMinutes'>,
): boolean {
  const payload = seatPolicyPayload(draft);
  if (payload === undefined) return true;
  return (
    payload.concurrentSeats !== view.ownSeats ||
    payload.idleTimeoutMinutes !== view.ownIdleTimeoutMinutes
  );
}

/**
 * El aviso cuando el cupo propio baja por debajo de los que hoy lo ocupan: nadie se desconecta por
 * eso (el límite se controla al ingresar), pero nadie más entra hasta que se liberen puestos.
 *
 * Sólo si el cupo que rige hoy es el del propio nodo. Si lo hereda, `inUse` es el del cupo del
 * ancestro, y esas sesiones siguen contando allá hasta cerrarse: cada una guarda el cupo con que
 * entró (`seat_tenant_id`), así que un cupo propio nuevo arranca vacío y nadie queda afuera.
 */
export function loweredSeatsNotice(
  draft: SeatPolicyDraft,
  view: Pick<SeatsView, 'ownSeats' | 'inherited' | 'inUse'>,
): string | undefined {
  if (draft.seatsMode !== 'own' || view.ownSeats === null || view.inherited) return undefined;
  const seats = parseSeats(draft.seats);
  const { inUse } = view;
  if (seats === undefined || seats >= inUse) return undefined;
  return `Hoy hay ${plural(inUse, 'persona conectada', 'personas conectadas')}. Nadie se desconecta por el cambio, pero no va a poder ingresar nadie más hasta que queden menos de ${seats}.`;
}

/**
 * La opción "Heredar" dicha con lo que se heredaría. Sólo se conoce el valor heredado cuando el
 * nodo ya hereda (la vista trae el efectivo); si tiene uno propio, se nombra a quién se hereda.
 */
export function inheritSeatsLabel(
  view: Pick<SeatsView, 'ownSeats' | 'limit' | 'poolTenantName'>,
  parentName: string | null,
): string {
  if (parentName === null) return 'Sin límite (no tiene de quién heredar)';
  if (view.ownSeats !== null) return `Heredar de ${parentName}`;
  if (view.limit === null) return `Heredar de ${parentName} (hoy sin límite)`;
  const from = view.poolTenantName ?? parentName;
  return `Heredar de ${parentName} (hoy comparte los ${view.limit} de ${from})`;
}

export function inheritIdleLabel(
  view: Pick<SeatsView, 'ownIdleTimeoutMinutes' | 'idleTimeoutMinutes'>,
  parentName: string | null,
): string {
  if (parentName === null) return `Por defecto (${idleLabel(DEFAULT_IDLE_MINUTES)})`;
  if (view.ownIdleTimeoutMinutes !== null) return `Heredar de ${parentName}`;
  return `Heredar de ${parentName} (hoy ${idleLabel(view.idleTimeoutMinutes)})`;
}

/** El aviso tras guardar. */
export function seatPolicySavedMessage(payload: SeatPolicyPayload, nodeName: string): string {
  const seats =
    payload.concurrentSeats === null
      ? 'hereda los puestos'
      : `tiene ${plural(payload.concurrentSeats, 'puesto', 'puestos')}`;
  const idle =
    payload.idleTimeoutMinutes === null
      ? 'hereda la inactividad'
      : `cierra tras ${idleLabel(payload.idleTimeoutMinutes)} sin actividad`;
  return `${nodeName} ${seats} y ${idle}.`;
}
