import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlightSearchCriteriaSchema, type FlightSearchCriteria } from '@sales-travel/domain';
import { LatamCredentialsMissingError, LatamNdcFlightSearchAdapter } from '@sales-travel/latam-ndc';
import { SabreConfigError, SabreFlightSearchAdapter } from '@sales-travel/sabre';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import { LatamNdcProviderFactory } from '../providers-latam/latam-ndc.factory.js';
import { SabreProviderFactory } from '../providers-sabre/sabre.factory.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderFlagsPort } from '../providers/provider.types.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { MemoryCacheAdapter } from './memory-cache.adapter.js';
import type { SearchTelemetryService } from './search-telemetry.service.js';
import { SearchService } from './search.service.js';
import type { PricingService } from '../pricing/pricing.service.js';

/**
 * NADA puede fabricar una oferta en producción.
 *
 * Este fichero tiene dos carriles que prueban cosas distintas y ninguno sustituye al otro:
 *
 *  1. **Comportamiento** — el camino real (factories BYOC → registry → \`SearchService\`) con un
 *     tenant sin credenciales: cero ofertas, cero llamadas al cable, y el proveedor nombrado
 *     como ausente en el parte. Es la propiedad que le importa al vendedor.
 *  2. **Alcanzabilidad** — desde el módulo del endpoint (\`search.controller.ts\`), el cierre
 *     transitivo de imports de producción no llega a ningún constructor de ofertas sintéticas.
 *     Es la propiedad que le importa a quien edite esto dentro de seis meses: un fixture puede
 *     volver a existir para los tests, pero no puede volver a ser alcanzable desde el endpoint.
 *
 * El carril 2 no se apoya en un comentario ni en una convención de nombres de directorio: lee
 * los imports y sigue el grafo, cruzando también a los paquetes de \`providers/\` por su fuente.
 * Este repositorio tiene una cicatriz entera hecha de código que producción sí ejecutaba sin que
 * nadie lo creyera.
 */

// ---------------------------------------------------------------------------------------------
// 1. Comportamiento: sin credenciales no sale ni una oferta
// ---------------------------------------------------------------------------------------------

const TENANT = '11111111-1111-4111-8111-111111111111';

function criteria(): FlightSearchCriteria {
  return FlightSearchCriteriaSchema.parse({
    origin: 'BOG',
    destination: 'LIM',
    departureDate: '2026-09-11',
    paxCount: { adults: 1, children: 0, infants: 0 },
    currency: 'USD',
  });
}

const FLAGS_ENCENDIDOS: ProviderFlagsPort = { isEnabledForTenant: () => Promise.resolve(true) };

/**
 * El servicio de búsqueda REAL sobre los factories REALES de los dos proveedores de vuelos.
 *
 * Sólo se doblan las piezas que no tienen que ver con esta propiedad (telemetría, pricing) y la
 * bóveda de credenciales, que es justo la entrada que se quiere controlar.
 */
function servicio(resolve: ProviderCredentialsService['resolve']): SearchService {
  const creds = { resolve } as unknown as ProviderCredentialsService;
  const registry = new FlightProviderRegistry(
    [new LatamNdcProviderFactory(creds), new SabreProviderFactory(creds)],
    FLAGS_ENCENDIDOS,
  );
  const telemetry = {
    assertWithinQuota: () => Promise.resolve(),
    instrument: (_meta: unknown, run: () => Promise<unknown>) => run(),
  } as unknown as SearchTelemetryService;

  return new SearchService(
    registry,
    { getApplicableRules: () => Promise.resolve([]) } as unknown as PricingService,
    telemetry,
    new CircuitBreakerService(),
    new MemoryCacheAdapter(),
  );
}

describe('sin credenciales usables no sale ni una oferta, y la ausencia se explica', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Cualquier salida al cable es un fallo de este test: sin credenciales no hay a quién
    // llamar, y el modo que respondía sin red es justo el que se retiró.
    fetchSpy = vi.fn(() => Promise.reject(new Error('ninguna búsqueda debería salir al cable')));
    vi.stubGlobal('fetch', fetchSpy);
    // El entorno también vacío: la plataforma no puede prestar lo que no tiene.
    for (const clave of [
      'LATAM_API_KEY',
      'LATAM_API_SECRET',
      'LATAM_AGENCY_ID',
      'LATAM_AGENCY_IATA',
      'LATAM_COUNTRY',
      'LATAM_FORCE_MOCK',
    ]) {
      vi.stubEnv(clave, '');
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('un tenant sin ninguna cuenta: cero ofertas, cero red, los dos proveedores ausentes', async () => {
    const service = servicio(() => Promise.reject(new NotFoundException('sin cuenta')));

    const res = await service.searchFlights(criteria(), TENANT);

    expect(res.offers).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.providers.map((p) => [p.code, p.status])).toEqual([
      ['latam-ndc', 'unavailable'],
      ['sabre', 'unavailable'],
    ]);
    // Y la ausencia llega con algo que la pantalla pueda decirle al vendedor.
    for (const parte of res.providers) {
      expect(parte.count).toBe(0);
      expect(parte.simulated).toBe(false);
      expect(parte.unavailableReason).toBeDefined();
      expect(parte.reason).toEqual(expect.stringContaining('Credenciales'));
    }
    expect(res.simulated).toBe(false);
  });

  it('cuentas ACTIVAS pero incompletas: tampoco se cuela una oferta, y se dice qué falta', async () => {
    // Es el caso caro: la agencia cargó credenciales a medias y creía estar vendiendo. Antes,
    // los dos ACL caían a fixtures y devolvían tarifas con forma real.
    const service = servicio((_tenantId: string, providerCode: string) =>
      Promise.resolve({
        id: 'acc-1',
        ownerTenantId: TENANT,
        providerCode,
        label: 'default',
        config: {},
        // A LATAM le falta todo menos la apiKey; a Sabre, la contraseña.
        credentials:
          providerCode === 'sabre' ? { epr: '500001', homePcc: 'ZZZZ' } : { apiKey: 'k' },
        inherited: false,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      } as Awaited<ReturnType<ProviderCredentialsService['resolve']>>),
    );

    const res = await service.searchFlights(criteria(), TENANT);

    expect(res.offers).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const parte of res.providers) {
      expect(parte.status).toBe('unavailable');
      expect(parte.unavailableReason).toBe('incomplete-account');
    }
    expect(res.providers.find((p) => p.code === 'sabre')?.reason).toContain('password');
    expect(res.providers.find((p) => p.code === 'latam-ndc')?.reason).toContain('apiSecret');
  });

  it('ni el entorno ni el JSONB de la cuenta pueden reencender la simulación', async () => {
    // Los dos interruptores que existían, puestos a la vez, sobre cuentas sin credenciales.
    vi.stubEnv('LATAM_FORCE_MOCK', 'true');
    const service = servicio((_tenantId: string, providerCode: string) =>
      Promise.resolve({
        id: 'acc-1',
        ownerTenantId: TENANT,
        providerCode,
        label: 'default',
        config: { mock: true },
        credentials: {},
        inherited: false,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      } as Awaited<ReturnType<ProviderCredentialsService['resolve']>>),
    );

    const res = await service.searchFlights(criteria(), TENANT);

    expect(res.offers).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.providers.every((p) => p.status === 'unavailable')).toBe(true);
    expect(res.providers.every((p) => p.simulated === false)).toBe(true);
  });
});

describe('la segunda barrera: los ACL no se dejan construir sin credenciales', () => {
  /**
   * La puerta de los factories es la que produce una ausencia EXPLICADA; ésta es la que impide
   * que exista un adapter capaz de responder sin proveedor detrás. Se prueban por separado
   * porque protegen de cosas distintas: la primera de una mala experiencia, la segunda de un
   * llamador futuro que construya el ACL desde otro sitio y se olvide de comprobar nada.
   */
  it('LATAM: sin las cinco credenciales, el constructor lanza y NOMBRA lo que falta', () => {
    expect(() => new LatamNdcFlightSearchAdapter({ apiUrl: 'https://example.test' })).toThrowError(
      LatamCredentialsMissingError,
    );
    const err = (() => {
      try {
        return new LatamNdcFlightSearchAdapter({
          apiUrl: 'https://example.test',
          apiKey: 'k',
          apiSecret: 'secreto-de-la-agencia',
          agencyId: 'A',
          country: 'CO',
        });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(LatamCredentialsMissingError);
    expect((err as LatamCredentialsMissingError).missing).toEqual(['agencyIata']);
    expect((err as Error).message).not.toContain('secreto-de-la-agencia');
  });

  it('Sabre: sin las tres credenciales, el constructor lanza', () => {
    expect(
      () => new SabreFlightSearchAdapter({ host: 'https://api.cert.platform.sabre.com' }),
    ).toThrowError(SabreConfigError);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Alcanzabilidad: el endpoint no llega a ningún fabricante de ofertas
// ---------------------------------------------------------------------------------------------

/** Raíz del monorepo: el primer ancestro con un `pnpm-workspace.yaml`. */
function raizDelRepo(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const padre = dirname(dir);
    if (padre === dir) throw new Error('no se encontró la raíz del monorepo desde el cwd');
    dir = padre;
  }
}

const REPO = raizDelRepo();

/** `from './x'`, `export * from './x'`, `require('./x')`, `import('./x')`. */
const ESPECIFICADOR = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

const EXTENSIONES = ['.ts', '.tsx', '.json'] as const;

function resolverRelativo(desde: string, especificador: string): string | null {
  const base = resolvePath(dirname(desde), especificador);
  // Bajo NodeNext la FUENTE escribe `./x.js` para un fichero que en disco es `x.ts`.
  const raices = base.endsWith('.js') ? [base.slice(0, -'.js'.length), base] : [base];
  for (const raiz of raices) {
    const candidatos = [
      ...EXTENSIONES.map((ext) => raiz + ext),
      ...EXTENSIONES.map((ext) => join(raiz, `index${ext}`)),
      raiz,
    ];
    for (const candidato of candidatos) {
      if (existsSync(candidato) && statSync(candidato).isFile()) return candidato;
    }
  }
  return null;
}

/**
 * Entrada de FUENTE de un paquete del workspace. Se busca `src/index.ts` a propósito y no el
 * `exports.types` del `package.json`: en `@sales-travel/sabre` eso apunta a `dist/`, que es un
 * artefacto de build y puede estar rancio o no existir. Lo que se audita es el programa que se
 * compila, no el que quedó de la última vez.
 */
function resolverPaquete(especificador: string): string | null {
  const nombre = especificador.replace(/^@sales-travel\//, '').split('/')[0];
  if (nombre === undefined || especificador === nombre) return null;
  for (const carpeta of ['providers', 'packages']) {
    const entry = join(REPO, carpeta, nombre, 'src', 'index.ts');
    if (existsSync(entry)) return entry;
  }
  return null;
}

/** Cierre transitivo de imports de PRODUCCIÓN desde un entry. Los `*.test.ts` no cuentan. */
function alcanzableDesde(entry: string): string[] {
  const vistos = new Set<string>();
  const pendientes = [entry];
  for (;;) {
    const fichero = pendientes.pop();
    if (fichero === undefined) break;
    if (vistos.has(fichero) || fichero.endsWith('.test.ts')) continue;
    vistos.add(fichero);
    if (fichero.endsWith('.json')) continue;

    for (const match of readFileSync(fichero, 'utf8').matchAll(ESPECIFICADOR)) {
      const especificador = match[1];
      if (especificador === undefined) continue;
      const destino = especificador.startsWith('.')
        ? resolverRelativo(fichero, especificador)
        : especificador.startsWith('@sales-travel/')
          ? resolverPaquete(especificador)
          : null;
      if (destino !== null && !vistos.has(destino)) pendientes.push(destino);
    }
  }
  return [...vistos];
}

const relativoAlRepo = (absoluto: string): string =>
  relative(REPO, absoluto).split(sep).join(posix.sep);

/**
 * El CÓDIGO de un módulo, sin sus comentarios.
 *
 * Se escanea el código y no el texto entero porque los comentarios de esta tanda NOMBRAN a
 * propósito lo que se retiró, para que quien lea el fichero dentro de un año sepa qué había ahí
 * y por qué ya no está. Un escáner que no distinga las dos cosas obliga a elegir entre la sonda
 * y la documentación, y lo que se acaba borrando es la documentación.
 *
 * El `//` sólo se corta cuando abre comentario de verdad (principio de línea o tras un espacio,
 * nunca pegado a `:`), para no partir un `'https://…'`. Es un recorte aproximado y basta: lo
 * peor que puede pasar es que sobreviva texto de más, y eso produce un fallo RUIDOSO, nunca un
 * pase silencioso. Que no se coma el código lo comprueba la aserción de control de abajo.
 */
function codigoSinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Los módulos `.ts` del cierre, ya sin comentarios. */
function codigoDelCierre(cierre: readonly string[]): { fichero: string; codigo: string }[] {
  return cierre
    .filter((fichero) => fichero.endsWith('.ts'))
    .map((fichero) => ({ fichero, codigo: codigoSinComentarios(readFileSync(fichero, 'utf8')) }));
}

/**
 * Los constructores de ofertas sintéticas que este repositorio llegó a ejecutar en producción,
 * por su nombre exacto, más los dos interruptores que los encendían.
 *
 * Una lista de nombres no puede ver un fabricante nuevo con nombre nuevo — de eso responde el
 * carril de comportamiento de arriba, que no depende de ningún nombre. Lo que esta lista sí
 * hace, y el otro carril no puede, es impedir que ESTOS vuelvan por la puerta del entry: es la
 * regresión concreta que se está cerrando, no una hipótesis.
 */
const FABRICANTES = [
  'buildMockOffers',
  'isMockMode',
  'LATAM_FORCE_MOCK',
  'SABRE_MOCK_OFFER_REF_PREFIX',
] as const;

describe('desde el endpoint de búsqueda no se alcanza ningún fabricante de ofertas', () => {
  const entry = join(REPO, 'apps', 'api', 'src', 'search', 'search.controller.ts');
  const cierre = alcanzableDesde(entry);
  const codigo = codigoDelCierre(cierre);

  it('la sonda ve el programa de verdad (si no, todo lo demás sería vacuo)', () => {
    const nombres = cierre.map(relativoAlRepo);

    // Anti-vacuidad en tres niveles: el fichero del endpoint, un módulo de `apps/api` al que
    // sólo se llega por varios saltos, y el ACL de cada proveedor —al otro lado de una
    // frontera de paquete, que es donde un caminante mal escrito se para—.
    expect(nombres).toContain('apps/api/src/search/search.controller.ts');
    expect(nombres).toContain('apps/api/src/providers/flight-provider.registry.ts');
    expect(nombres).toContain('providers/sabre/src/sabre-flight-search.adapter.ts');
    expect(nombres).toContain('providers/latam-ndc/src/latam-flight-search.adapter.ts');
    expect(cierre.length).toBeGreaterThan(40);
  });

  it('la sonda LEE el código de los módulos del cierre, no sólo sus rutas', () => {
    // Control positivo del escáner de abajo Y del recorte de comentarios: sin esto, un
    // `readFileSync` vacío —o un `codigoSinComentarios` que devolviera ''— dejaría la aserción
    // de FABRICANTES verde para siempre.
    expect(codigo.some((m) => m.codigo.includes('buildSabreShopRequest'))).toBe(true);
    expect(codigo.some((m) => m.codigo.includes('buildAirShoppingRequest'))).toBe(true);
    // Y sobrevive la mayor parte del programa: el recorte no es un `return ''` disfrazado.
    expect(codigo.reduce((n, m) => n + m.codigo.length, 0)).toBeGreaterThan(100_000);
  });

  it.each(FABRICANTES)('%s no aparece en el código de ningún módulo alcanzable', (simbolo) => {
    const culpables = codigo
      .filter((modulo) => modulo.codigo.includes(simbolo))
      .map((modulo) => relativoAlRepo(modulo.fichero));

    expect(
      culpables,
      `'${simbolo}' es alcanzable desde POST /search/flights a través de: ${culpables.join(', ')}. ` +
        `Un fixture puede existir para los tests, pero no puede estar en el cierre de imports ` +
        `del endpoint: ahí deja de ser un dato de prueba y pasa a ser una tarifa que un ` +
        `vendedor cotiza.`,
    ).toEqual([]);
  });

  it('los módulos de fixtures de los dos ACL ya no existen en `src/`', () => {
    // Fijar la ausencia y no sólo la inalcanzabilidad: un fichero que se compila y se publica
    // es superficie que nadie audita, aunque hoy nadie lo importe.
    expect(existsSync(join(REPO, 'providers', 'sabre', 'src', 'fixtures.ts'))).toBe(false);
    expect(existsSync(join(REPO, 'providers', 'latam-ndc', 'src', 'fixtures.ts'))).toBe(false);
  });

  it('lo que queda en `providers/sabre/src/__fixtures__` son respuestas, no ofertas', () => {
    // Estos fixtures SÍ son legítimos y se conservan: son payloads de Sabre que los mappers
    // convierten. No fabrican una `Offer`; la derivan de una respuesta real del proveedor. Por
    // eso son `.json` y no `.ts`: un JSON no puede ejecutarse ni entrar en el cierre de
    // imports como código.
    const dir = join(REPO, 'providers', 'sabre', 'src', '__fixtures__');
    const noJson = readdirSync(dir).filter((nombre) => !nombre.endsWith('.json'));
    expect(noJson).toEqual([]);
  });
});
