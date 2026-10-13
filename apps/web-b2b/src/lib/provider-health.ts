import { providerMetaFor } from './provider-display';
import type { EnablementKillLevel, EnablementVertical } from './provider-enablement';
import type { Tone } from './wallets';

/**
 * "¿Está respondiendo cada proveedor?" y las palancas de un incidente — lado del navegador, sólo
 * superadmin (`/admin/providers/health`, el apagado de emergencia de 0077 y cerrar un circuito).
 *
 * Como el resto del panel de proveedores: una respuesta sin la forma completa se rechaza entera, y
 * acá viven las frases que la pantalla necesita. Apagar un proveedor para toda la plataforma no se
 * hace con un dato a medio leer.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderCircuit {
  readonly state: CircuitState;
  readonly failures: number;
  /** ISO 8601; `null` con el circuito cerrado. */
  readonly openedAt: string | null;
  readonly lastFailureAt: string | null;
}

/** Espejo de `PanelKillSwitchView`: el apagado puesto desde el panel. */
export interface PanelKillSwitch {
  readonly level: EnablementKillLevel;
  readonly reason: string;
  readonly setBy: string;
  readonly setByEmail: string | null;
  /** ISO 8601. */
  readonly setAt: string;
  /** ISO 8601; `null` = sin vencimiento. */
  readonly expiresAt: string | null;
}

/** Espejo de `KillSwitchDetail`: el apagado efectivo y de dónde sale. */
export interface KillSwitchDetail {
  readonly effective: EnablementKillLevel | null;
  /** Lo que apaga la variable `PROVIDERS_DISABLED`. */
  readonly env: EnablementKillLevel | null;
  readonly panel: PanelKillSwitch | null;
}

/** Espejo de `ProviderHealthView`. */
export interface ProviderHealth {
  readonly code: string;
  readonly vertical: EnablementVertical;
  readonly circuit: ProviderCircuit;
  readonly suspendedAccounts: number;
  readonly killSwitch: KillSwitchDetail;
  /** `null` = el API no pudo contarlos. */
  readonly accountIssues24h: number | null;
}

// ---------------------------------------------------------------------------------------------
// Lectura de las respuestas
// ---------------------------------------------------------------------------------------------

const VERTICALS: readonly string[] = ['flights', 'hotels', 'cars'];
const STATES: readonly string[] = ['closed', 'open', 'half-open'];
const LEVELS: readonly string[] = ['all', 'sales'];

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): value is T {
  return typeof value === 'string' && allowed.includes(value);
}

function levelOrNull(value: unknown): EnablementKillLevel | null | undefined {
  if (value === null) return null;
  return oneOf<EnablementKillLevel>(value, LEVELS) ? value : undefined;
}

function parseCircuit(value: unknown): ProviderCircuit | undefined {
  if (!isRecord(value)) return undefined;
  const { state, failures, openedAt, lastFailureAt } = value;
  if (!oneOf<CircuitState>(state, STATES) || !isCount(failures)) return undefined;
  if (!isStringOrNull(openedAt) || !isStringOrNull(lastFailureAt)) return undefined;
  return { state, failures, openedAt, lastFailureAt };
}

function parsePanel(value: unknown): PanelKillSwitch | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { level, reason, setBy, setByEmail, setAt, expiresAt } = value;
  if (!oneOf<EnablementKillLevel>(level, LEVELS)) return undefined;
  if (typeof reason !== 'string' || typeof setBy !== 'string' || typeof setAt !== 'string') {
    return undefined;
  }
  if (!isStringOrNull(setByEmail) || !isStringOrNull(expiresAt)) return undefined;
  return { level, reason, setBy, setByEmail, setAt, expiresAt };
}

function parseKillSwitch(value: unknown): KillSwitchDetail | undefined {
  if (!isRecord(value)) return undefined;
  const effective = levelOrNull(value['effective']);
  const env = levelOrNull(value['env']);
  const panel = parsePanel(value['panel']);
  if (effective === undefined || env === undefined || panel === undefined) return undefined;
  // El efectivo es el más amplio de los dos: uno que no cuadra es una respuesta rota.
  const widest = env === 'all' || panel?.level === 'all' ? 'all' : (env ?? panel?.level ?? null);
  if (effective !== widest) return undefined;
  return { effective, env, panel };
}

/** Un proveedor de `GET /admin/providers/health`, o la respuesta de una de sus palancas. */
export function parseProviderHealth(value: unknown): ProviderHealth | undefined {
  if (!isRecord(value)) return undefined;
  const { code, vertical, suspendedAccounts, accountIssues24h } = value;
  if (typeof code !== 'string' || code === '') return undefined;
  if (!oneOf<EnablementVertical>(vertical, VERTICALS)) return undefined;
  if (!isCount(suspendedAccounts)) return undefined;
  if (accountIssues24h !== null && !isCount(accountIssues24h)) return undefined;
  const circuit = parseCircuit(value['circuit']);
  const killSwitch = parseKillSwitch(value['killSwitch']);
  if (circuit === undefined || killSwitch === undefined) return undefined;
  return { code, vertical, circuit, suspendedAccounts, killSwitch, accountIssues24h };
}

export function parseProviderHealthList(value: unknown): ProviderHealth[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parseProviderHealth);
  return parsed.some((p) => p === undefined) ? undefined : (parsed as ProviderHealth[]);
}

// ---------------------------------------------------------------------------------------------
// La salud en palabras
// ---------------------------------------------------------------------------------------------

/** Cada cuánto se relee la salud mientras la pestaña está a la vista. */
export const HEALTH_POLL_MS = 30_000;

export function circuitBadge(circuit: Pick<ProviderCircuit, 'state' | 'failures'>): {
  readonly label: string;
  readonly tone: Tone;
} {
  switch (circuit.state) {
    case 'open':
      return { label: 'No responde: circuito abierto', tone: 'danger' };
    case 'half-open':
      return { label: 'Probando si volvió', tone: 'warning' };
    case 'closed':
      return circuit.failures > 0
        ? { label: `Con fallos (${circuit.failures})`, tone: 'warning' }
        : { label: 'Funcionando', tone: 'success' };
  }
}

/** "Cuentas en pausa: 2", "Avisos de cuenta en 24 h: 3": sólo los que no son cero. */
export function healthCounters(
  health: Pick<ProviderHealth, 'suspendedAccounts' | 'accountIssues24h'>,
): string[] {
  return [
    health.suspendedAccounts > 0 ? `Cuentas en pausa: ${health.suspendedAccounts}` : null,
    health.accountIssues24h !== null && health.accountIssues24h > 0
      ? `Avisos de cuenta en 24 h: ${health.accountIssues24h}`
      : null,
  ].filter((c): c is string => c !== null);
}

export const ENV_KILL_SWITCH_NOTICE =
  'Apagado por la variable PROVIDERS_DISABLED. Se quita desplegando (ver el runbook).';

export const CIRCUIT_RESET_CONFIRM =
  'El proveedor vuelve a recibir llamadas de inmediato. Si sigue fallando, el circuito se abre otra vez.';

export function killLevelPhrase(level: EnablementKillLevel): string {
  return level === 'sales' ? 'solo ventas' : 'todo';
}

function shortDateTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "Apagado desde el panel (solo ventas) · vence 13 oct., 14:00 · por ana@plataforma.co". */
export function panelKillSwitchLine(panel: PanelKillSwitch): string {
  const expires = panel.expiresAt === null ? null : shortDateTime(panel.expiresAt);
  return [
    `Apagado desde el panel (${killLevelPhrase(panel.level)})`,
    panel.expiresAt === null ? 'sin vencimiento' : expires === null ? null : `vence ${expires}`,
    panel.setByEmail === null ? null : `por ${panel.setByEmail}`,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
}

// ---------------------------------------------------------------------------------------------
// El apagado de emergencia
// ---------------------------------------------------------------------------------------------

export const KILL_LEVEL_OPTIONS: readonly {
  readonly value: EnablementKillLevel;
  readonly label: string;
  readonly detail: string;
}[] = [
  {
    value: 'sales',
    label: 'Solo ventas',
    detail:
      'se frenan búsquedas, pre-reservas y reservas nuevas; lo ya vendido se sigue consultando y cancelando.',
  },
  {
    value: 'all',
    label: 'Todo',
    detail: 'también la post-venta (consultas, cancelaciones y conciliación).',
  },
];

/** Los vencimientos que acepta el API; `null` = sin vencimiento. */
export type KillSwitchExpiry = 60 | 240 | 1440 | null;

export const KILL_EXPIRY_OPTIONS: readonly {
  readonly value: KillSwitchExpiry;
  readonly label: string;
}[] = [
  { value: 60, label: 'En 1 hora' },
  { value: 240, label: 'En 4 horas' },
  { value: 1440, label: 'En 24 horas' },
  { value: null, label: 'Sin vencimiento' },
];

/** Motivo obligatorio del apagado y de cerrar un circuito: el mismo rango que el API. */
export const KILL_REASON_MIN = 5;
export const KILL_REASON_MAX = 500;

export function requiredReasonError(raw: string): string | undefined {
  const length = raw.trim().length;
  if (length === 0) return 'Escribe el motivo: queda en la auditoría.';
  if (length < KILL_REASON_MIN) {
    return `El motivo tiene que tener al menos ${KILL_REASON_MIN} caracteres.`;
  }
  if (length > KILL_REASON_MAX) {
    return `El motivo no puede superar los ${KILL_REASON_MAX} caracteres.`;
  }
  return undefined;
}

export interface KillSwitchDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly typedLabel: string;
  readonly confirmLabel: string;
}

export function killSwitchDialogCopy(code: string): KillSwitchDialogCopy {
  const name = providerMetaFor(code).name;
  return {
    title: `Apagado de emergencia de ${name}`,
    description:
      'Corta el proveedor para toda la plataforma, por encima de cualquier ajuste por agencia. No hace falta desplegar.',
    typedLabel: `Escribe ${code} para confirmar`,
    confirmLabel: `Apagar ${name}`,
  };
}

/** ¿Escribió el código del proveedor? Sin espacios alrededor ni mayúsculas que importen. */
export function typedCodeMatches(typed: string, code: string): boolean {
  return typed.trim().toLowerCase() === code.toLowerCase();
}

export function killSwitchSetToast(code: string, level: EnablementKillLevel): string {
  return `${providerMetaFor(code).name} quedó apagado (${killLevelPhrase(level)}).`;
}

/**
 * El aviso tras levantar el apagado del panel. Si la variable PROVIDERS_DISABLED también lo apaga
 * (`remaining`), decir que volvió a operar sería falso: se dice que sigue apagado y por qué.
 */
export function killSwitchClearedToast(
  code: string,
  remaining: EnablementKillLevel | null = null,
): string {
  const name = providerMetaFor(code).name;
  return remaining === null
    ? `${name} volvió a operar.`
    : `Se levantó el apagado del panel, pero ${name} sigue apagado por la variable PROVIDERS_DISABLED.`;
}

export function circuitResetToast(code: string): string {
  return `${providerMetaFor(code).name}: circuito cerrado.`;
}

// ---------------------------------------------------------------------------------------------
// Bordes del proxy
// ---------------------------------------------------------------------------------------------

export type KillSwitchBody = {
  readonly level: EnablementKillLevel;
  readonly reason: string;
  readonly expiresInMinutes: KillSwitchExpiry;
};

const EXPIRIES: readonly KillSwitchExpiry[] = KILL_EXPIRY_OPTIONS.map((o) => o.value);

/** Un motivo obligatorio, recortado, o `undefined` si no cumple el rango del API. */
function requiredReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return requiredReasonError(value) === undefined ? value.trim() : undefined;
}

/**
 * El cuerpo del apagado, reconstruido campo por campo: al API sólo le llegan `level`, `reason` y
 * `expiresInMinutes`. `undefined` = cuerpo inválido (400).
 */
export function parseKillSwitchBody(value: unknown): KillSwitchBody | undefined {
  if (!isRecord(value)) return undefined;
  const { level, expiresInMinutes } = value;
  if (!oneOf<EnablementKillLevel>(level, LEVELS)) return undefined;
  const reason = requiredReason(value['reason']);
  if (reason === undefined) return undefined;
  const expiry = EXPIRIES.find((e) => e === expiresInMinutes);
  if (expiry === undefined && expiresInMinutes !== null) return undefined;
  return { level, reason, expiresInMinutes: expiry ?? null };
}

/** Levantar: motivo opcional, vacío = sin motivo. `undefined` = cuerpo inválido. */
export function parseClearKillSwitchBody(value: unknown): { reason: string | null } | undefined {
  if (value === undefined || value === null) return { reason: null };
  if (!isRecord(value)) return undefined;
  const reason = value['reason'];
  if (reason === undefined || reason === null) return { reason: null };
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();
  if (trimmed.length > KILL_REASON_MAX) return undefined;
  return { reason: trimmed === '' ? null : trimmed };
}

/** Cerrar el circuito: motivo obligatorio. */
export function parseCircuitResetBody(value: unknown): { reason: string } | undefined {
  if (!isRecord(value)) return undefined;
  const reason = requiredReason(value['reason']);
  return reason === undefined ? undefined : { reason };
}
