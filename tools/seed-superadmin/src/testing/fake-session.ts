import type { QueryResult, QueryResultRow } from 'pg';
import type { DbSession } from '../cli.js';

/** Lo que la base "tiene" para el doble: cada consulta del seed contesta con esto. */
export interface FakeState {
  privileged?: boolean;
  tenant?: { id: string; tenant_type: string; parent_tenant_id: string | null; status: string };
  /** Slug de OTRA plataforma que ya exista en la base. */
  otherPlatform?: string;
  user?: { id: string; status: string };
  membership?: { id: string; role: string; status: string };
  /** Error con el que la base rechaza la promoción (`UPDATE tenants`). */
  promoteError?: { code: string; constraint?: string; message: string };
  /** La primera sentencia que empiece así falla con `Error('boom')`, como una caída a mitad. */
  failOn?: string;
}

export interface FakeSession extends DbSession {
  /** Las dos primeras palabras de cada sentencia, en orden. */
  readonly sql: string[];
  /** Cada sentencia completa con sus parámetros. */
  readonly calls: { text: string; values: unknown[] }[];
  /** `event_type` y `payload` de cada `domain_event` escrito. */
  readonly events: { type: string; payload: Record<string, unknown> }[];
  ended: boolean;
}

/**
 * Un doble de `pg` que contesta por patrón las consultas del seed. Sirve para probar el orden, las
 * negativas y la salida sin base; el SQL de verdad lo prueba `seed.integration.test.ts`.
 */
export function fakeSession(state: FakeState = {}): FakeSession {
  const session: FakeSession = {
    sql: [],
    calls: [],
    events: [],
    ended: false,
    query<R extends QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
      const flat = text.trim().replace(/\s+/g, ' ');
      session.sql.push(flat.split(' ').slice(0, 2).join(' '));
      session.calls.push({ text: flat, values });
      const rows = answer(flat, values);
      if (rows instanceof Error) return Promise.reject(rows);
      return Promise.resolve({ rows, rowCount: rows.length } as unknown as QueryResult<R>);
    },
    end(): Promise<void> {
      session.ended = true;
      return Promise.resolve();
    },
  };

  function answer(text: string, values: unknown[]): QueryResultRow[] | Error {
    if (state.failOn !== undefined && text.startsWith(state.failOn)) return new Error('boom');
    if (text.includes('rolbypassrls')) return [{ privileged: state.privileged ?? true }];
    if (text.startsWith('SELECT id, tenant_type')) return state.tenant ? [state.tenant] : [];
    if (text.includes("tenant_type = 'platform' AND id IS DISTINCT FROM")) {
      return state.otherPlatform === undefined ? [] : [{ slug: state.otherPlatform }];
    }
    if (text.startsWith('SELECT id, status FROM users')) return state.user ? [state.user] : [];
    if (text.startsWith('INSERT INTO tenants')) return [{ id: 'tenant-new', status: 'active' }];
    if (text.startsWith('UPDATE tenants')) {
      if (state.promoteError === undefined) return [];
      return Object.assign(new Error(state.promoteError.message), state.promoteError);
    }
    if (text.startsWith('INSERT INTO users')) return [{ id: 'user-new', status: 'active' }];
    if (text.startsWith('SELECT id, role, status FROM memberships')) {
      return state.membership ? [state.membership] : [];
    }
    if (text.startsWith('INSERT INTO memberships')) return [{ id: 'membership-new' }];
    if (text.startsWith('UPDATE memberships')) return [{ id: state.membership?.id ?? '?' }];
    if (text.startsWith('INSERT INTO domain_events')) {
      session.events.push({
        type: String(values[1]),
        payload: JSON.parse(String(values[4])) as Record<string, unknown>,
      });
      return [];
    }
    return [];
  }

  return session;
}

/** Las sentencias que escriben algo. */
export function writes(session: FakeSession): string[] {
  return session.sql.filter((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s));
}
