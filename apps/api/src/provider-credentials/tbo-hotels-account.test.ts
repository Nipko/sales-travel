import { randomBytes } from 'node:crypto';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { decryptCredentials, encryptCredentials } from './credentials-cipher.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';

/**
 * La cuenta `tbo-hotels` en la bóveda, por la puerta pública del servicio (docs/tbo/08 RF-37;
 * 09 PR-2.2): nace `sandbox`, guarda la contraseña sin recortar y el listado nunca la devuelve.
 *
 * Con el compilador REAL de Postgres de Kysely: se afirma sobre lo que recibiría la base —columnas
 * y parámetros—, no sobre una cadena de métodos.
 */
const USERNAME = 'usuario-tbo-consolidador';
// Espacios en los bordes a propósito: pueden ser parte de la contraseña (Q-06).
const PASSWORD = '  cl4ve de TBO  ';
const TEST_CONFIG = {
  environment: 'test',
  baseUrl: 'http://api.tbotechnology.in/TBOHolidays_HotelAPI',
};

beforeAll(() => {
  process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
});

/** Servicio cuyo `upsert` corre contra un driver que graba cada consulta compilada. */
function servicioQueGraba(opts: { existente: boolean }): {
  service: ProviderCredentialsService;
  consultas: CompiledQuery[];
} {
  const consultas: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      const base = await super.acquireConnection();
      return {
        executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> => {
          consultas.push(q);
          const filas = q.sql.startsWith('select')
            ? opts.existente
              ? [{ id: 'acc-existente' }]
              : []
            : q.sql.startsWith('insert')
              ? [{ id: 'acc-nueva' }]
              : [];
          return Promise.resolve({ rows: filas as unknown as R[] });
        },
        streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
      };
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const fake = {
    withTenant: <T>(_tenantId: string, fn: (trx: unknown) => Promise<T>): Promise<T> =>
      db.transaction().execute((trx) => fn(trx)),
  };
  return { service: new ProviderCredentialsService(fake as unknown as DatabaseService), consultas };
}

/** Columna → parámetro de un INSERT o un UPDATE compilado. */
function valoresEscritos(q: CompiledQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const insert = /^insert into "provider_accounts" \(([^)]+)\) values \(([^)]+)\)/.exec(q.sql);
  if (insert?.[1] !== undefined && insert[2] !== undefined) {
    const columnas = insert[1].split(', ').map((c) => c.replaceAll('"', ''));
    const marcas = insert[2].split(', ');
    columnas.forEach((col, i) => {
      out[col] = q.parameters[Number(marcas[i]?.slice(1)) - 1];
    });
    return out;
  }
  for (const [, col, n] of q.sql.matchAll(/"(\w+)" = \$(\d+)/g)) {
    if (col !== undefined) out[col] = q.parameters[Number(n) - 1];
  }
  return out;
}

function escritura(consultas: readonly CompiledQuery[]): Record<string, unknown> {
  const q = consultas.find((c) => c.sql.startsWith('insert') || c.sql.startsWith('update'));
  if (!q) throw new Error('el upsert no escribió nada');
  return valoresEscritos(q);
}

const ALTA = {
  tenantId: 'consolidador-1',
  providerCode: 'tbo-hotels',
  credentials: { username: USERNAME, password: PASSWORD },
  config: TEST_CONFIG,
};

describe('upsert de una cuenta tbo-hotels', () => {
  it('una cuenta nueva sin estado nace `sandbox`: no habilita TBO hasta promoverla', async () => {
    const { service, consultas } = servicioQueGraba({ existente: false });

    await expect(service.upsert(ALTA)).resolves.toEqual({ id: 'acc-nueva' });
    expect(escritura(consultas)['status']).toBe('sandbox');
  });

  it('reguardarla sin estado también la deja en `sandbox`: promover exige mandar `active`', async () => {
    // Es lo que obliga al panel a mandar siempre el estado elegido: el default del API no es
    // "dejala como estaba".
    const { service, consultas } = servicioQueGraba({ existente: true });
    await service.upsert(ALTA);
    expect(escritura(consultas)['status']).toBe('sandbox');

    const promovida = servicioQueGraba({ existente: true });
    await promovida.service.upsert({ ...ALTA, status: 'active' });
    expect(escritura(promovida.consultas)['status']).toBe('active');
  });

  it('usuario y contraseña van SÓLO en el blob cifrado, y la contraseña sin recortar', async () => {
    const { service, consultas } = servicioQueGraba({ existente: false });
    await service.upsert(ALTA);

    const fila = escritura(consultas);
    expect(fila['config']).toBe(JSON.stringify(TEST_CONFIG));
    // Nada de la credencial en claro en ningún parámetro que llega a la base.
    const enClaro = JSON.stringify(consultas.map((q) => q.parameters));
    expect(enClaro).not.toContain(USERNAME);
    expect(enClaro).not.toContain(PASSWORD.trim());

    const blob = fila['credentials_enc'];
    if (!Buffer.isBuffer(blob)) throw new Error('credentials_enc tiene que ser el blob cifrado');
    expect(JSON.parse(decryptCredentials(blob))).toEqual({
      username: USERNAME,
      password: PASSWORD,
    });
  });
});

describe('listSafe de una cuenta tbo-hotels', () => {
  function servicioConCuenta(
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ): ProviderCredentialsService {
    const fila = {
      id: 'acc-tbo',
      provider_code: 'tbo-hotels',
      label: 'default',
      config,
      credentials_enc: encryptCredentials(JSON.stringify(credentials)),
      is_inheritable: true,
      status: 'sandbox',
      created_at: new Date('2026-09-25T00:00:00Z'),
      updated_at: new Date('2026-09-25T00:00:00Z'),
    };
    const db = { withTenant: () => Promise.resolve([fila]) } as unknown as DatabaseService;
    return new ProviderCredentialsService(db);
  }

  it('devuelve entorno y URL, y NUNCA el usuario ni la contraseña', async () => {
    const service = servicioConCuenta(TEST_CONFIG, { username: USERNAME, password: PASSWORD });
    const [cuenta] = await service.listSafe('consolidador-1');

    expect(cuenta?.config).toEqual(TEST_CONFIG);
    expect(cuenta?.configVerified).toBe(true);
    expect(cuenta?.status).toBe('sandbox');
    const serializado = JSON.stringify(cuenta);
    expect(serializado).not.toContain(USERNAME);
    expect(serializado).not.toContain(PASSWORD.trim());
  });

  it('un usuario metido en `config` por API se oculta y se nombra, no se devuelve', async () => {
    const service = servicioConCuenta(
      { ...TEST_CONFIG, username: USERNAME },
      { username: USERNAME, password: PASSWORD },
    );
    const [cuenta] = await service.listSafe('consolidador-1');

    expect(cuenta?.redactedConfigKeys).toEqual(['username']);
    expect(JSON.stringify(cuenta)).not.toContain(USERNAME);
  });

  it('dice si está completa con los NOMBRES de lo que falta', async () => {
    const completa = servicioConCuenta(TEST_CONFIG, { username: USERNAME, password: PASSWORD });
    const [ok] = await completa.listSafe('consolidador-1');
    expect(ok?.readiness).toBe('complete');

    const sinClave = servicioConCuenta(TEST_CONFIG, { username: USERNAME });
    const [incompleta] = await sinClave.listSafe('consolidador-1');
    expect(incompleta?.readiness).toBe('incomplete');
    expect(incompleta?.missingRequiredFields).toEqual(['password']);
  });
});
