import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/** Fallos consecutivos antes de abrir el circuito. */
const FAILURE_THRESHOLD = 5;
/** Cuánto permanece abierto antes de dejar pasar una sonda. */
const OPEN_MS = 30_000;

type State = 'closed' | 'open' | 'half-open';

interface Circuit {
  failures: number;
  state: State;
  openedAt: number;
}

/**
 * Circuit breaker por proveedor.
 *
 * Sin esto, un proveedor caído se traducía en que CADA búsqueda esperaba su timeout
 * completo antes de fallar: con el timeout de 15 s del cliente HTTP, veinte vendedores
 * buscando a la vez dejaban la API entera ocupada esperando a un servicio que ya se sabía
 * muerto. Tras N fallos consecutivos el circuito se abre y las llamadas fallan al
 * instante, hasta que una sonda comprueba que el proveedor volvió.
 *
 * Estado en memoria: hay un solo contenedor de API (igual que el throttler). Si se
 * escala horizontalmente, esto debe pasar a Redis para que el estado sea compartido.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, Circuit>();

  /** Kill-switch manual: PROVIDERS_DISABLED=despegar-hotels,agent-cars */
  private isKilled(providerCode: string): boolean {
    const raw = process.env['PROVIDERS_DISABLED'] ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(providerCode);
  }

  private get(providerCode: string): Circuit {
    let c = this.circuits.get(providerCode);
    if (!c) {
      c = { failures: 0, state: 'closed', openedAt: 0 };
      this.circuits.set(providerCode, c);
    }
    return c;
  }

  /** Estado actual, para exponerlo en health o en el panel. */
  snapshot(): Record<string, { state: State; failures: number }> {
    const out: Record<string, { state: State; failures: number }> = {};
    for (const [code, c] of this.circuits) out[code] = { state: c.state, failures: c.failures };
    return out;
  }

  /**
   * Ejecuta `run` a través del circuito del proveedor.
   * Lanza ServiceUnavailableException sin llamar al proveedor si está abierto o apagado.
   */
  async execute<T>(providerCode: string, run: () => Promise<T>): Promise<T> {
    if (this.isKilled(providerCode)) {
      throw new ServiceUnavailableException(
        `El proveedor ${providerCode} está temporalmente deshabilitado.`,
      );
    }

    const c = this.get(providerCode);

    if (c.state === 'open') {
      if (Date.now() - c.openedAt < OPEN_MS) {
        throw new ServiceUnavailableException(
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
      c.failures += 1;
      // En half-open, un solo fallo vuelve a abrir: el proveedor sigue caído.
      if (c.state === 'half-open' || c.failures >= FAILURE_THRESHOLD) {
        c.state = 'open';
        c.openedAt = Date.now();
        this.logger.warn(`circuito de ${providerCode} ABIERTO tras ${c.failures} fallos`);
      }
      throw err;
    }
  }
}
