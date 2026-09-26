import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

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

type KillLevel = 'all' | 'sales';

/**
 * Nivel de apagado de `providerCode` en `PROVIDERS_DISABLED`, o `undefined` si está encendido.
 *
 * `código` apaga todo, que es lo que hacía antes. `código:ventas` apaga sólo las ventas: frenar la
 * venta de un proveedor no puede impedir leer ni cancelar lo que ya se vendió. Cualquier otro
 * sufijo apaga todo, porque un error de tipeo del operador no puede dejar las ventas encendidas; y
 * si el código aparece dos veces gana el apagado más amplio.
 */
function killLevel(providerCode: string): KillLevel | undefined {
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
   * `código@accountRef` → hasta cuándo está suspendida. Las vencidas se barren en cada suspensión
   * nueva ({@link suspend}): la huella de una credencial rotada no vuelve a consultarse nunca, y
   * sin el barrido su entrada quedaría para siempre.
   */
  private readonly suspendedAccounts = new Map<string, number>();

  private get(providerCode: string): Circuit {
    let c = this.circuits.get(providerCode);
    if (!c) {
      c = { failures: 0, state: 'closed', openedAt: 0 };
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
   * Ejecuta `run` a través del circuito del proveedor y, si se indica, del de su cuenta.
   * Lanza {@link BreakerRejectionError} sin llamar al proveedor si está apagado o abierto.
   */
  async execute<T>(
    providerCode: string,
    run: () => Promise<T>,
    options: CircuitCallOptions = {},
  ): Promise<T> {
    const { scope = 'sales', accountRef, effectOf: declared } = options;

    // Por código y no por la clave del circuito: apagar un proveedor apaga también sus cuentas.
    const level = killLevel(providerCode);
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
        `${providerCode} rechazó la cuenta con la que opera esta agencia y sus consultas quedan en pausa unos minutos. Revisá las credenciales en Mi Red → Credenciales o avisale a quien las administra.`,
      );
    }

    const c = this.get(providerCode);

    if (c.state === 'open') {
      if (Date.now() - c.openedAt < OPEN_MS) {
        throw new BreakerRejectionError(
          providerCode,
          'provider-circuit',
          `${providerCode} no está respondiendo. Reintentá en unos segundos.`,
        );
      }
      // Vencida la ventana, se deja pasar UNA llamada de sonda.
      c.state = 'half-open';
    }

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
    const until = this.suspendedAccounts.get(accountKey);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    // Vencida la ventana la cuenta vuelve a salir: si el proveedor la sigue rechazando, el mismo
    // `OPEN_ACCOUNT` la suspende otra vez.
    this.suspendedAccounts.delete(accountKey);
    return false;
  }

  private suspend(accountKey: string, ms: number): void {
    const now = Date.now();
    for (const [key, until] of this.suspendedAccounts) {
      if (until <= now) this.suspendedAccounts.delete(key);
    }
    this.suspendedAccounts.set(accountKey, now + ms);
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
      this.suspend(accountKey, ms);
      // `accountRef` es una huella, no un dato del tenant: puede ir al log.
      this.logger.warn(
        `circuito de la cuenta ${accountKey} ABIERTO por ${kind ?? 'OPEN_ACCOUNT'} durante ${ms / 60_000} min`,
      );
      return;
    }

    c.failures += 1;
    // En half-open, un solo fallo vuelve a abrir: el proveedor sigue caído.
    if (effect === 'OPEN_NOW' || c.state === 'half-open' || c.failures >= FAILURE_THRESHOLD) {
      c.state = 'open';
      c.openedAt = Date.now();
      this.logger.warn(`circuito de ${providerCode} ABIERTO tras ${c.failures} fallos`);
    }
  }
}
