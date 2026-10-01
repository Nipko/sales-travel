import { Injectable, Logger } from '@nestjs/common';
import type { CachePort } from '@sales-travel/core';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** Techo de entradas. Sin esto, una ráfaga de búsquedas distintas agota la memoria. */
const MAX_ENTRIES = 5_000;

/**
 * Cada cuánto, como mucho, una escritura barre lo vencido. Sin el barrido, una entrada que nadie
 * vuelve a leer (una búsqueda que nadie retoma) sólo se iba al llenarse la caché: con el TTL
 * cumplido seguía ocupando memoria —y, en los contextos de hoteles, datos del pasajero— hasta el
 * próximo despliegue.
 */
const SWEEP_EVERY_MS = 60_000;

/**
 * Adaptador de CachePort en memoria del proceso.
 *
 * `CachePort` existía desde el Sprint 0 sin ninguna implementación, así que no había
 * caché de nada: cada reordenamiento o cada vuelta atrás del navegador volvía a golpear
 * al proveedor, que cobra por consulta y tarda segundos.
 *
 * Es memoria y no Redis a propósito: Redis todavía no está aprovisionado y hay un solo
 * contenedor de API (el throttler ya asume lo mismo). Cambiar a Redis es otro adaptador
 * de esta interfaz. LO QUE NO SE PUEDE hacer sin Redis es escalar horizontalmente: con
 * dos instancias cada una tendría su propio caché y la tasa de acierto se partiría —
 * está anotado acá para que no sorprenda el día que se agregue una réplica.
 *
 * Una instancia que guarda entradas grandes baja su techo con una subclase que redefine
 * {@link maxEntries} (p. ej. las búsquedas por tramos de hoteles).
 */
@Injectable()
export class MemoryCacheAdapter implements CachePort {
  private readonly logger = new Logger(MemoryCacheAdapter.name);
  private readonly store = new Map<string, Entry>();
  private lastSweepAt = Date.now();

  /** Techo de entradas de esta instancia. */
  protected readonly maxEntries: number = MAX_ENTRIES;

  get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return Promise.resolve(null);
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(hit.value as T);
  }

  set<T>(key: string, value: T, ttlSeconds = 60): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt >= SWEEP_EVERY_MS) this.sweep(now);
    if (this.store.size >= this.maxEntries) this.evict();
    this.store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  /** `pattern` con `*` como comodín, para invalidar por tenant o por vertical. */
  invalidatePattern(pattern: string): Promise<void> {
    const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
    for (const key of this.store.keys()) {
      if (re.test(key)) this.store.delete(key);
    }
    return Promise.resolve();
  }

  /** Quita todo lo vencido. */
  private sweep(now: number): void {
    this.lastSweepAt = now;
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }

  /** Purga lo vencido; si aún así está lleno, descarta el 10% más viejo. */
  private evict(): void {
    this.sweep(Date.now());
    if (this.store.size < this.maxEntries) return;

    const toDrop = Math.ceil(this.maxEntries * 0.1);
    let dropped = 0;
    for (const k of this.store.keys()) {
      this.store.delete(k);
      if (++dropped >= toDrop) break;
    }
    this.logger.warn(`caché llena: se descartaron ${dropped} entradas`);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
