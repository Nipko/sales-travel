import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { encryptCredentials } from './credentials-cipher.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';

/**
 * `listSafe` por su puerta pública, con la base sustituida por las filas que devolvería.
 *
 * La avería de MEDIA 2 vive en el mapeo fila → respuesta, no en el SQL: `config` salía verbatim.
 * Sustituir `withTenant` deja ese mapeo intacto y ejercitado — incluido el descifrado real del
 * blob, que es lo que permite contestar si la cuenta está completa.
 */
const EPR = 'EPR-DE-LA-OFICINA';
const PASSWORD = 'p4ssw0rd-de-la-oficina';

interface FilaCuenta {
  provider_code: string;
  config: Record<string, unknown>;
  credentials: Record<string, unknown> | 'ilegible';
  status?: string;
}

function servicioCon(filas: readonly FilaCuenta[]): ProviderCredentialsService {
  const rows = filas.map((f, i) => ({
    id: `acc-${i}`,
    provider_code: f.provider_code,
    label: 'default',
    config: f.config,
    credentials_enc:
      f.credentials === 'ilegible'
        ? Buffer.alloc(40)
        : encryptCredentials(JSON.stringify(f.credentials)),
    is_inheritable: true,
    status: f.status ?? 'active',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  }));

  const db = { withTenant: () => Promise.resolve(rows) } as unknown as DatabaseService;
  return new ProviderCredentialsService(db);
}

describe('listSafe — `config` no sale verbatim', () => {
  beforeAll(() => {
    process.env['PROVIDER_CREDENTIALS_KEY'] ??= randomBytes(32).toString('base64');
  });

  it('un `epr` o una contraseña metidos en `config` por API NO viajan al navegador', async () => {
    // Por el formulario no puede pasar; por API sí, y por API es como se carga Sabre hoy.
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: { environment: 'cert', epr: EPR, password: PASSWORD },
        credentials: { epr: EPR, password: PASSWORD, homePcc: 'AB1C' },
      },
    ]);

    const [cuenta] = await service.listSafe('t1');
    const serializado = JSON.stringify(cuenta);
    expect(serializado).not.toContain(EPR);
    expect(serializado).not.toContain(PASSWORD);
  });

  it('lo que se oculta se DICE por nombre: la pantalla no cree que la config está limpia', async () => {
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: { environment: 'cert', epr: EPR, password: PASSWORD },
        credentials: { epr: EPR, password: PASSWORD, homePcc: 'AB1C' },
      },
    ]);

    const [cuenta] = await service.listSafe('t1');
    expect(cuenta?.redactedConfigKeys).toEqual(['epr', 'password']);
    expect(cuenta?.configVerified).toBe(true);
  });

  it('las claves declaradas siguen saliendo, y con su tipo original', async () => {
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: { environment: 'cert', mock: true, agencyIata: '12345678' },
        credentials: { epr: EPR, password: PASSWORD, homePcc: 'AB1C' },
      },
    ]);

    const [cuenta] = await service.listSafe('t1');
    expect(cuenta?.config).toEqual({ environment: 'cert', mock: true, agencyIata: '12345678' });
  });

  it('la lista blanca devuelve las opciones de shop Sabre y no las marca como pérdidas', async () => {
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: {
          brandedFares: 'single',
          brandLadderRounds: '2',
          upsellLimit: '3',
          multipleFares: 'off',
        },
        credentials: { epr: EPR, password: PASSWORD, homePcc: 'AB1C' },
      },
    ]);

    const [cuenta] = await service.listSafe('t1');
    expect(cuenta?.config).toEqual({
      brandedFares: 'single',
      brandLadderRounds: '2',
      upsellLimit: '3',
      multipleFares: 'off',
    });
    expect(cuenta?.redactedConfigKeys).toEqual([]);
    expect(cuenta?.configVerified).toBe(true);
  });

  it('un proveedor SIN lista blanca no afirma que su config esté vacía: la marca sin verificar', async () => {
    const service = servicioCon([
      {
        provider_code: 'proveedor-nuevo',
        config: { loQueSea: 'valor-que-podria-ser-secreto' },
        credentials: { token: 'x' },
      },
    ]);

    const [cuenta] = await service.listSafe('t1');
    expect(cuenta?.config).toEqual({});
    expect(cuenta?.redactedConfigKeys).toEqual(['loQueSea']);
    expect(cuenta?.configVerified).toBe(false);
    expect(JSON.stringify(cuenta)).not.toContain('valor-que-podria-ser-secreto');
  });

  it('los proveedores que ya guardaban cuentas siguen mostrando su config', async () => {
    const service = servicioCon([
      { provider_code: 'latam-ndc', config: { apiUrl: 'https://x.test' }, credentials: { a: '1' } },
      {
        provider_code: 'email',
        config: { host: 'smtp.x.test', port: 587 },
        credentials: { a: '1' },
      },
    ]);

    const cuentas = await service.listSafe('t1');
    expect(cuentas[0]?.config).toEqual({ apiUrl: 'https://x.test' });
    expect(cuentas[1]?.config).toEqual({ host: 'smtp.x.test', port: 587 });
  });
});

describe('listSafe — completitud: nombres de campo, nunca valores', () => {
  it('una cuenta de Sabre a la que le falta un obligatorio se declara INCOMPLETA', async () => {
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: {},
        credentials: { epr: EPR, password: PASSWORD },
      },
    ]);

    const [cuenta] = await service.listSafe('t1');
    expect(cuenta?.readiness).toBe('incomplete');
    expect(cuenta?.missingRequiredFields).toEqual(['homePcc']);
  });

  it('con las tres credenciales se declara completa', async () => {
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: {},
        credentials: { epr: EPR, password: PASSWORD, homePcc: 'AB1C' },
      },
    ]);

    expect((await service.listSafe('t1'))[0]?.readiness).toBe('complete');
  });

  it('cuenta un obligatorio que vive en `config`, porque el factory lo lee de ahí', async () => {
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: { homePcc: 'AB1C' },
        credentials: { epr: EPR, password: PASSWORD },
      },
    ]);

    expect((await service.listSafe('t1'))[0]?.readiness).toBe('complete');
  });

  it('una cuenta declarada mock no se hace pasar por completa', async () => {
    const service = servicioCon([
      { provider_code: 'sabre', config: { mock: true }, credentials: { placeholder: 'x' } },
    ]);

    expect((await service.listSafe('t1'))[0]?.readiness).toBe('simulated');
  });

  it('un proveedor sin reglas declaradas responde `unknown`, no `complete`', async () => {
    const service = servicioCon([
      { provider_code: 'latam-ndc', config: {}, credentials: { apiKey: 'k' } },
    ]);

    const [cuenta] = await service.listSafe('t1');
    expect(cuenta?.readiness).toBe('unknown');
    expect(cuenta?.missingRequiredFields).toEqual([]);
  });

  it('un blob ilegible es `unknown` y no tumba el listado ni escupe el blob al log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = servicioCon([
      { provider_code: 'sabre', config: {}, credentials: 'ilegible' },
      {
        provider_code: 'sabre',
        config: {},
        credentials: { epr: EPR, password: PASSWORD, homePcc: 'AB1C' },
      },
    ]);

    const cuentas = await service.listSafe('t1');
    const logueado = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    warn.mockRestore();

    expect(cuentas[0]?.readiness).toBe('unknown');
    // La segunda cuenta se sigue listando: una credencial rota no puede cerrar la pantalla
    // desde la que se arregla.
    expect(cuentas[1]?.readiness).toBe('complete');
    expect(logueado).toContain('sabre');
    expect(logueado).not.toContain(PASSWORD);
  });

  it('el listado nunca contiene el valor de una credencial, ni siquiera para calcular esto', async () => {
    const service = servicioCon([
      {
        provider_code: 'sabre',
        config: {},
        credentials: { epr: EPR, password: PASSWORD, homePcc: 'AB1C' },
      },
    ]);

    expect(JSON.stringify(await service.listSafe('t1'))).not.toContain(PASSWORD);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
