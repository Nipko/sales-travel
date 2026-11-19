import type { Route } from 'next';
import type { Tone } from './wallets';

/** Adonde entra el superadmin: el Estado, antes que el Resumen (founder 2026-11-19). */
export const PLATFORM_LANDING: Route = '/admin/plataforma/estado';

/**
 * Plataforma → Estado (`GET /admin/status`): el semáforo por área y los pendientes del proyecto. La
 * regla de cada nivel vive en el API (`platform-status.fold.ts`); aquí sólo se valida y se rotula.
 */

export type StatusLevel = 'ok' | 'warn' | 'critical';
export type PendingLevel = 'critical' | 'high' | 'medium' | 'low';
export type PendingOwner = 'founder' | 'claude';

export interface StatusArea {
  readonly id: string;
  readonly label: string;
  readonly level: StatusLevel;
  readonly summary: string;
  readonly details: readonly string[];
  readonly href: string;
}

export interface PendingStep {
  readonly owner: PendingOwner;
  readonly text: string;
}

export interface Pending {
  readonly id: string;
  readonly title: string;
  readonly since: string;
  readonly daysOpen: number;
  readonly level: PendingLevel;
  readonly why: string;
  readonly steps: readonly PendingStep[];
  readonly links: readonly { readonly label: string; readonly href: string }[];
}

export interface PlatformStatus {
  readonly generatedAt: string;
  readonly overall: StatusLevel;
  readonly areas: readonly StatusArea[];
  readonly runtime: { readonly version: string; readonly startedAt: string };
  readonly pendings: readonly Pending[];
}

const LEVELS: readonly StatusLevel[] = ['ok', 'warn', 'critical'];
const PENDING_LEVELS: readonly PendingLevel[] = ['critical', 'high', 'medium', 'low'];
const OWNERS: readonly PendingOwner[] = ['founder', 'claude'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function parseArea(raw: unknown): StatusArea | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, label, level, summary, details, href } = raw;
  if (!isString(id) || !isString(label) || !isString(summary) || !isString(href)) return undefined;
  if (!LEVELS.includes(level as StatusLevel) || !isStringList(details)) return undefined;
  // Sólo rutas de la propia app: el enlace no puede sacar al superadmin a otro sitio.
  if (!href.startsWith('/')) return undefined;
  return { id, label, level: level as StatusLevel, summary, details, href };
}

function parsePending(raw: unknown): Pending | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, title, since, daysOpen, level, why, steps, links } = raw;
  if (!isString(id) || !isString(title) || !isString(since) || !isString(why)) return undefined;
  if (typeof daysOpen !== 'number' || !Number.isInteger(daysOpen) || daysOpen < 0) return undefined;
  if (!PENDING_LEVELS.includes(level as PendingLevel)) return undefined;
  if (!Array.isArray(steps) || !Array.isArray(links)) return undefined;
  const parsedSteps: PendingStep[] = [];
  for (const s of steps) {
    if (!isRecord(s) || !OWNERS.includes(s['owner'] as PendingOwner) || !isString(s['text'])) {
      return undefined;
    }
    parsedSteps.push({ owner: s['owner'] as PendingOwner, text: s['text'] });
  }
  const parsedLinks: { label: string; href: string }[] = [];
  for (const l of links) {
    if (!isRecord(l) || !isString(l['label']) || !isString(l['href'])) return undefined;
    if (!l['href'].startsWith('https://')) return undefined;
    parsedLinks.push({ label: l['label'], href: l['href'] });
  }
  return {
    id,
    title,
    since,
    daysOpen,
    level: level as PendingLevel,
    why,
    steps: parsedSteps,
    links: parsedLinks,
  };
}

/** Valida lo que llega del API; `undefined` si algo no tiene la forma esperada. */
export function parsePlatformStatus(body: unknown): PlatformStatus | undefined {
  if (!isRecord(body)) return undefined;
  const { generatedAt, overall, areas, runtime, pendings } = body;
  if (!isString(generatedAt) || !LEVELS.includes(overall as StatusLevel)) return undefined;
  if (!Array.isArray(areas) || !Array.isArray(pendings) || !isRecord(runtime)) return undefined;
  if (!isString(runtime['version']) || !isString(runtime['startedAt'])) return undefined;
  const parsedAreas = areas.map(parseArea);
  const parsedPendings = pendings.map(parsePending);
  if (parsedAreas.some((a) => a === undefined) || parsedPendings.some((p) => p === undefined)) {
    return undefined;
  }
  return {
    generatedAt,
    overall: overall as StatusLevel,
    areas: parsedAreas as StatusArea[],
    runtime: { version: runtime['version'], startedAt: runtime['startedAt'] },
    pendings: parsedPendings as Pending[],
  };
}

export const LEVEL_TONE: Record<StatusLevel, Tone> = {
  ok: 'success',
  warn: 'warning',
  critical: 'danger',
};

export const LEVEL_LABEL: Record<StatusLevel, string> = {
  ok: 'En orden',
  warn: 'Revisar',
  critical: 'Urgente',
};

export const OVERALL_HEADLINE: Record<StatusLevel, string> = {
  ok: 'Todo en orden',
  warn: 'Hay cosas para revisar',
  critical: 'Hay algo roto o urgente',
};

export const PENDING_TONE: Record<PendingLevel, Tone> = {
  critical: 'danger',
  high: 'warning',
  medium: 'neutral',
  low: 'neutral',
};

export const PENDING_LABEL: Record<PendingLevel, string> = {
  critical: 'Crítico',
  high: 'Alto',
  medium: 'Medio',
  low: 'Bajo',
};

export const OWNER_LABEL: Record<PendingOwner, string> = {
  founder: 'Founder',
  claude: 'Claude',
};

/** «hoy», «hace 1 día», «hace 14 días». */
export function daysOpenLabel(days: number): string {
  if (days <= 0) return 'desde hoy';
  return days === 1 ? 'hace 1 día' : `hace ${String(days)} días`;
}

/** `AAAA-MM-DD` → «5 nov 2026». */
export function sinceLabel(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return at.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** El commit desplegado, corto; `dev` u otra etiqueta, tal cual. */
export function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}

export type OwnerFilter = 'all' | PendingOwner;

/** Los pendientes en los que le toca algo a ese responsable. */
export function pendingsFor(pendings: readonly Pending[], owner: OwnerFilter): Pending[] {
  return owner === 'all'
    ? [...pendings]
    : pendings.filter((p) => p.steps.some((s) => s.owner === owner));
}

/** Cuántos pendientes por nivel, para el encabezado. */
export function countByLevel(pendings: readonly Pending[]): Record<PendingLevel, number> {
  const out: Record<PendingLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const p of pendings) out[p.level] += 1;
  return out;
}
