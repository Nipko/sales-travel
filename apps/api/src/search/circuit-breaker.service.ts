import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { KillSwitchStore } from '../provider-enablement/kill-switch.store.js';

/** Fallos consecutivos antes de abrir el circuito. */
const FAILURE_THRESHOLD = 5;
/** Cuánto permanece abierto antes de dejar pasar una sonda. */
const OPEN_MS = 30_000;

/**
 * Cuánto queda suspendida una cuenta tras un `OPEN_ACCOUNT`, según el `kind` del fallo.
 *
 * Un bloqueo de la cuenta (`ACCOUNT_BLOCKED`) lo levanta el proveedor, no la agencia: volver a
 * probar cada pocos minutos sólo suma rechazos. Una credencial rechazada la corrige la agencia en
 * el panel, y al rotarla cambia el `accountRef` y la llamada sale por otro circuito, así que la
 * ventana corta sólo pesa si nadie la tocó. Cifras del plan de hoteles multi-proveedor, PR-0.6
 * (INFERIDO: ningún proveedor publica cuánto dura su bloqueo).
 */
const ACCOUNT_OPEN_MS_BY_KIND: ReadonlyMap<string, number> = new Map([
  ['ACCOUNT_BLOCKED', 15 * 60_000],
]);
const ACCOUNT_OPEN_MS = 5 * 60_000;

type State = 'closed' | 'open' | 'half-open';

interface Circuit {
  failures: number;
  state: State;
  openedAt: number;
  /** Cuándo sumó el último fallo (0 = nunca). Sólo para el panel: no decide nada. */
  lastFailureAt: number;
}

/** El circuito de un proveedor como lo ve el panel de la plataforma. */
export interface AdminCircuitView {
  readonly state: State;
  readonly failures: number;
  /** `null` con el circuito cerrado. */
  readonly openedAt: Date | null;
  readonly lastFailureAt: Date | null;
  /** Cuántas cuentas del proveedor están suspendidas ahora. Sólo el número, nunca cuáles. */
  readonly suspendedAccounts: number;
}

/**
 * Qué hace un fallo con el circuito. Lo declara el ACL de cada proveedor en `failure.circuit`
 * (como `SabreCircuitEffect`):
 *
 * - `COUNT`: suma al circuito del código. Es una caída del proveedor (red, 5xx, cuerpo roto).
 * - `IGNORE`: no suma. El proveedor respondió: negocio, configuración del tenant, bug nuestro o
 *   cupo, y cinco de esos no dicen que esté caído.
 * - `OPEN_ACCOUNT`: suspende sólo la cuenta con la que salió la llamada (credencial rechazada,
 *   cuenta bloqueada). Una BYOC mala no apaga al proveedor para el resto de la red.
 * - `OPEN_NOW`: abre el circuito del código al instante, sin esperar al umbral. Sabre lo declara
 *   para 503, 504 y la respuesta inválida del gateway (docs/sabre/10 RNF-03).
 */
export const CIRCUIT_EFFECTS = ['COUNT', 'IGNORE', 'OPEN_ACCOUNT', 'OPEN_NOW'] as const;
export type CircuitEffect = (typeof CIRCUIT_EFFECTS)[number];

/**
 * Qué parte del proveedor usa la llamada, para el kill-switch de dos niveles.
 *
 * - `sales`: Search, PreBook y Book, y lo que sólo sirve para llegar a ellos (sugerencias,
 *   detalle de tarifas, medios de pago, confirmación de un salto de precio).
 * - `post-sale`: leer, cancelar o conciliar lo que ya se vendió.
 */
export type CallScope = 'sales' | 'post-sale';

/**
 * Lo que el factory de un proveedor declara sobre cómo pasan por el breaker las llamadas hechas
 * con UN adapter resuelto. Viaja con el proveedor resuelto hasta cada llamada: quien llama no
 * conoce ni la cuenta ni los errores del ACL.
 */
export interface ProviderCircuitOptions {
  /**
   * Huella de la cuenta con la que sale la llamada (digest del dueño y del usuario de la
   * credencial), NUNCA el id del tenant: con la cuenta heredada, el id del tenant no dice qué
   * credencial falló, y al rotar la credencial la huella cambia y la cuenta sale por un circuito
   * nuevo. Sin ella, un `OPEN_ACCOUNT` no tiene a quién suspender y cuenta como antes en el
   * circuito del código.
   */
  readonly accountRef?: string;
  /**
   * Efecto que el proveedor le asigna a un error, por encima de lo que diga su forma. Existe para
   * los errores que el ACL lanza ANTES del cable (credenciales, construcción del request, cupo
   * local) y que no traen `failure.circuit`: sin esto contarían como caída, y cinco búsquedas mal
   * armadas de una agencia cortarían el proveedor para toda la red (RNF-03 punto 4).
   * `undefined` = el proveedor no opina y se lee la forma del error.
   */
  readonly effectOf?: (err: unknown) => CircuitEffect | undefined;
}

export interface CircuitCallOptions extends ProviderCircuitOptions {
  /**
   * Por defecto `sales`: una llamada que se olvida de declararse queda del lado que
   * `código:ventas` apaga. Al revés, olvidarse dejaría vendiendo a un proveedor que operaciones
   * quiso frenar.
   */
  readonly scope?: CallScope;
  /**
   * La llamada respeta el kill-switch, el circuito abierto y la cuenta suspendida, pero no mueve
   * el circuito: ni su fallo suma ni su éxito lo cierra, y no gasta la sonda de un half-open. Es
   * para lecturas secundarias por otro endpoint del proveedor (contenido de un hotel): que
   * responda no dice que la búsqueda ande, y un éxito suyo reabriría el paso a búsquedas que
   * esperarían su timeout entero contra un Search caído.
   */
  readonly passive?: boolean;
}

/** Por qué el breaker no dejó salir la llamada. */
export type BreakerRejectionReason = 'kill-switch' | 'provider-circuit' | 'account-circuit';

/**
 * El breaker cortó la llamada ANTES de que saliera al proveedor.
 *
 * Sigue siendo el 503 de siempre, con el mismo mensaje, pero con tipo y con la marca
 * `sentToProvider: false`: quien decide qué hacer después de un fallo necesita saber si hubo
 * envío. En una cancelación, el rechazo sin tipo caía en `UNVERIFIED` y mandaba a conciliar y a
 * escalar una cancelación que nunca salió (`orders/cancel-retry-policy.ts`).
 */
export class BreakerRejectionError extends ServiceUnavailableException {
  readonly sentToProvider = false as const;

  constructor(
    readonly providerCode: string,
    readonly reason: BreakerRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'BreakerRejectionError';
  }
}

export type KillLevel = 'all' | 'sales';

/** El apagado más amplio de los dos: `all` le gana a `sales`, y cualquiera a ninguno. */
function widest(a: KillLevel | undefined, b: KillLevel | undefined): KillLevel | undefined {
  if (a === 'all' || b === 'all') return 'all';
  return a ?? b;
}

/**
 * Nivel de apagado de `providerCode`: el más amplio entre `PROVIDERS_DISABLED` y el apagado de
 * emergencia del panel (`panel`, 0077), o `undefined` si está encendido.
 *
 * En la variable, `código` apaga todo, que es lo que hacía antes. `código:ventas` apaga sólo las
 * ventas: frenar la venta de un proveedor no puede impedir leer ni cancelar lo que ya se vendió.
 * Cualquier otro sufijo apaga todo, porque un error de tipeo del operador no puede dejar las ventas
 * encendidas; y si el código aparece dos veces gana el apagado más amplio. El panel nunca enciende
 * lo que la variable apaga: la variable es el respaldo que gana siempre.
 *
 * Pura salvo por leer el entorno. Se exporta para que el panel de la plataforma diga qué está
 * apagado y por qué; quien lo aplica sigue siendo {@link CircuitBreakerService.execute}.
 */
export function killLevel(providerCode: string, panel?: KillLevel): KillLevel | undefined {
  return widest(envKillLevel(providerCode), panel);
}

function envKillLevel(providerCode: string): KillLevel | undefined {
  let level: KillLevel | undefined;
  for (const entry of (process.env['PROVIDERS_DISABLED'] ?? '').split(',')) {
    // Sin límite en el split: `código:ventas:algo` es un sufijo que nadie definió y apaga todo;
    // cortado en dos se leería como `ventas` y dejaría encendida la post-venta.
    const [code, ...levels] = entry.split(':').map((s) => s.trim());
    if (code !== providerCode) continue;
    if (levels.length !== 1 || levels[0]?.toLowerCase() !== 'ventas') return 'all';
    level = 'sales';
  }
  return level;
}

interface FailureShape {
  readonly failure?: unknown;
}

/**
 * Efecto de un error sobre el circuito, más el `kind` que elige la ventana de una cuenta.
 *
 * Se lee por forma y no con `instanceof`: el breaker no conoce a ningún proveedor. Un error que no
 * trae `failure.circuit` (Despegar, LATAM, un `Error` cualquiera) o que trae un valor que no está
 * en {@link CIRCUIT_EFFECTS} cuenta exactamente como antes.
 */
function effectOf(err: unknown): { effect: CircuitEffect; kind: string | undefined } {
  const failure = typeof err === 'object' && err !== null ? (err as FailureShape).failure : null;
  if (typeof failure !== 'object' || failure === null) return { effect: 'COUNT', kind: undefined };
  const { circuit, kind } = failure as { circuit?: unknown; kind?: unknown };
  return {
    effect: CIRCUIT_EFFECTS.find((e) => e === circuit) ?? 'COUNT',
    kind: typeof kind === 'string' ? kind : undefined,
  };
}

/**
 * Circuit breaker por proveedor, con circuito propio por cuenta.
 *
 * Sin esto, un proveedor caído se traducía en que CADA búsqueda esperaba su timeout
 * completo antes de fallar: con el timeout de 15 s del cliente HTTP, veinte vendedores
 * buscando a la vez dejaban la API entera ocupada esperando a un servicio que ya se sabía
 * muerto. Tras N fallos consecutivos el circuito se abre y las llamadas fallan al
 * instante, hasta que una sonda comprueba que el proveedor volvió.
 *
 * Qué cuenta como fallo lo dice el error ({@link CircuitEffect}): antes contaba cualquier
 * excepción, y con BYOC cinco `401` de la credencial de UNA agencia cortaban 30 s al proveedor
 * para toda la red. Los circuitos de cuenta viven aparte y no salen en {@link snapshot}, que
 * `/health` publica sin autenticar.
 *
 * Estado en memoria: hay un solo contenedor de API (igual que el throttler). Si se
 * escala horizontalmente, esto debe pasar a Redis para que el estado sea compartido.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, Circuit>();
  /**
   * `código@accountRef` → de qué proveedor es y hasta cuándo está suspendida. Las vencidas se barren
   * en cada suspensión nueva ({@link suspend}): la huella de una credencial rotada no vuelve a
   * consultarse nunca, y sin el barrido su entrada quedaría para siempre.
   */
  private readonly suspendedAccounts = new Map<
    string,
    { readonly providerCode: string; readonly until: number }
  >();

  /**
   * Sin el almacén (los tests que arman `new CircuitBreakerService()`) sólo cuenta la variable
   * `PROVIDERS_DISABLED`, como antes del apagado desde el panel.
   */
  constructor(@Optional() private readonly killSwitches?: KillSwitchStore) {}

  private get(providerCode: string): Circuit {
    let c = this.circuits.get(providerCode);
    if (!c) {
      c = { failures: 0, state: 'closed', openedAt: 0, lastFailureAt: 0 };
      this.circuits.set(providerCode, c);
    }
    return c;
  }

  /**
   * Estado de los circuitos POR CÓDIGO, para exponerlo en health o en el panel.
   *
   * Los de cuenta no están y no pueden estar: publicarían sin autenticar cuántas cuentas tienen la
   * credencial rechazada o bloqueada.
   */
  snapshot(): Record<string, { state: State; failures: number }> {
    const out: Record<string, { state: State; failures: number }> = {};
    for (const [code, c] of this.circuits) out[code] = { state: c.state, failures: c.failures };
    return out;
  }

  /**
   * Lo que ve el panel de la plataforma (autenticado, sólo superadmin): por código, el circuito con
   * cuándo se abrió y cuándo falló por última vez, y CUÁNTAS cuentas del proveedor están
   * suspendidas. Nunca cuáles: la huella de una cuenta no sale de esta clase.
   */
  adminSnapshot(now: number = Date.now()): Record<string, AdminCircuitView> {
    const suspended = new Map<string, number>();
    for (const { providerCode, until } of this.suspendedAccounts.values()) {
      if (until > now) suspended.set(providerCode, (suspended.get(providerCode) ?? 0) + 1);
    }
    const out: Record<string, AdminCircuitView> = {};
    for (const code of new Set([...this.circuits.keys(), ...suspended.keys()])) {
      const c = this.circuits.get(code);
      out[code] = {
        state: c?.state ?? 'closed',
        failures: c?.failures ?? 0,
        openedAt: c === undefined || c.state === 'closed' ? null : new Date(c.openedAt),
        lastFailureAt: c === undefined || c.lastFailureAt === 0 ? null : new Date(c.lastFailureAt),
        suspendedAccounts: suspended.get(code) ?? 0,
      };
    }
    return out;
  }

  /**
   * Cierra el circuito del proveedor desde el panel: la próxima llamada sale sin esperar la sonda.
   * No toca las cuentas suspendidas (ésas las arregla la agencia con su credencial) ni el apagado de
   * emergencia. Devuelve cómo estaba, o `undefined` si el proveedor no tenía circuito.
   */
  reset(providerCode: string): AdminCircuitView | undefined {
    const before = this.adminSnapshot()[providerCode];
    const c = this.circuits.get(providerCode);
    if (c !== undefined) {
      c.failures = 0;
      c.state = 'closed';
      c.openedAt = 0;
      this.logger.warn(`circuito de ${providerCode} cerrado desde el panel`);
    }
    return before;
  }

  /**
   * Ejecuta `run` a través del circuito del proveedor y, si se indica, del de su cuenta.
   * Lanza {@link BreakerRejectionError} sin llamar al proveedor si está apagado o abierto.
   */
  async execute<T>(
    providerCode: string,
    run: () => Promise<T>,
    options: CircuitCallOptions = {},
  ): Promise<T> {
    const { scope = 'sales', accountRef, effectOf: declared, passive = false } = options;

    // Por código y no por la clave del circuito: apagar un proveedor apaga también sus cuentas.
    const level = killLevel(providerCode, this.killSwitches?.panelLevel(providerCode));
    if (level === 'all' || (level === 'sales' && scope === 'sales')) {
      throw new BreakerRejectionError(
        providerCode,
        'kill-switch',
        `El proveedor ${providerCode} está temporalmente deshabilitado.`,
      );
    }

    const accountKey = accountRef === undefined ? undefined : `${providerCode}@${accountRef}`;
    if (accountKey !== undefined && this.isSuspended(accountKey)) {
      throw new BreakerRejectionError(
        providerCode,
        'account-circuit',
        `${providerCode} rechazó la cuenta con la que opera esta agencia y sus consultas quedan en pausa unos minutos. Revisa las credenciales en Mi Red → Credenciales o avísale a quien las administra.`,
      );
    }

    const c = this.get(providerCode);

    if (c.state === 'open') {
      if (Date.now() - c.openedAt < OPEN_MS) {
        throw new BreakerRejectionError(
          providerCode,
          'provider-circuit',
          `${providerCode} no está respondiendo. Inténtalo de nuevo en unos segundos.`,
        );
      }
      // Vencida la ventana, se deja pasar UNA llamada de sonda. Una pasiva pasa sin serlo: su
      // resultado no se escucha, así que la sonda queda para la siguiente que sí.
      if (!passive) c.state = 'half-open';
    }
    if (passive) return run();

    try {
      const result = await run();
      if (c.state !== 'closed' || c.failures > 0) {
        this.logger.log(`circuito de ${providerCode} restablecido`);
      }
      c.failures = 0;
      c.state = 'closed';
      return result;
    } catch (err) {
      this.recordFailure(providerCode, c, accountKey, err, declared);
      throw err;
    }
  }

  private isSuspended(accountKey: string): boolean {
    const until = this.suspendedAccounts.get(accountKey)?.until;
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    // Vencida la ventana la cuenta vuelve a salir: si el proveedor la sigue rechazando, el mismo
    // `OPEN_ACCOUNT` la suspende otra vez.
    this.suspendedAccounts.delete(accountKey);
    return false;
  }

  private suspend(providerCode: string, accountKey: string, ms: number): void {
    const now = Date.now();
    for (const [key, { until }] of this.suspendedAccounts) {
      if (until <= now) this.suspendedAccounts.delete(key);
    }
    this.suspendedAccounts.set(accountKey, { providerCode, until: now + ms });
  }

  private recordFailure(
    providerCode: string,
    c: Circuit,
    accountKey: string | undefined,
    err: unknown,
    declared: ProviderCircuitOptions['effectOf'],
  ): void {
    const shape = effectOf(err);
    const effect = declared?.(err) ?? shape.effect;
    const { kind } = shape;
    if (effect === 'IGNORE') return;

    if (effect === 'OPEN_ACCOUNT' && accountKey !== undefined) {
      const ms =
        (kind === undefined ? undefined : ACCOUNT_OPEN_MS_BY_KIND.get(kind)) ?? ACCOUNT_OPEN_MS;
      this.suspend(providerCode, accountKey, ms);
      // `accountRef` es una huella, no un dato del tenant: puede ir al log.
      this.logger.warn(
        `circuito de la cuenta ${accountKey} ABIERTO por ${kind ?? 'OPEN_ACCOUNT'} durante ${ms / 60_000} min`,
      );
      return;
    }

    c.failures += 1;
    c.lastFailureAt = Date.now();
    // En half-open, un solo fallo vuelve a abrir: el proveedor sigue caído.
    if (effect === 'OPEN_NOW' || c.state === 'half-open' || c.failures >= FAILURE_THRESHOLD) {
      c.state = 'open';
      c.openedAt = Date.now();
      this.logger.warn(`circuito de ${providerCode} ABIERTO tras ${c.failures} fallos`);
    }
  }
}
