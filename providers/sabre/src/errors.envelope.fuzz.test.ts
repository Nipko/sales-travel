/**
 * Fuzz dirigido sobre la regla dura de éxito, por la puerta pública.
 *
 * Las rondas 3, 4 y 5 fueron el mismo fallo tres veces: un marcador de error enterrado bajo una
 * clave que el clasificador trataba como hoja. Los tests de esas rondas fijan los sobres que
 * alguien tuvo el buen ojo de escribir a mano. Esto genera miles de sobres que nadie escribió, y
 * exige la propiedad que de verdad importa:
 *
 *     un error enterrado a cualquier profundidad, bajo cualquier combinación de claves
 *     —incluidas TODAS las que el recorrido trata de forma especial— siempre se encuentra.
 *
 * Las tres rondas se habrían cazado de una sola pasada con esto.
 *
 * Y la propiedad simétrica, que importa igual: **un sobre construido sólo con claves neutras y
 * hojas escalares siempre se acepta**. Un falso positivo en búsqueda deja al vendedor sin
 * resultados; si la regla empieza a inventarse fallos, el equipo la desactiva en una semana y
 * volvemos al agujero. Ese carril es el que impide «arreglar» el fail-open a martillazos.
 *
 * Semilla FIJA: un fuzz que no se puede reproducir no es un test, es una anécdota. Cada caso
 * imprime su semilla en el mensaje de fallo.
 */

import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SABRE_ENVELOPE_MAX_DEPTH, SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';
import type { SabreResult } from './http/sabre-http.client';

const SHOP_PATH = '/v5/offers/shop';

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

function fakeTokens(): SabreTokenProvider {
  return {
    getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
    invalidate: () => Promise.resolve(),
  };
}

function fetchReturning(payload: unknown): SabreFetch {
  return ((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) satisfies SabreFetch;
}

type Settled = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: unknown };

async function post(payload: unknown): Promise<Settled> {
  const client = new SabreHttpClient(config(), fakeTokens(), {
    fetch: fetchReturning(payload),
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  try {
    return { kind: 'resolved', value: await client.postJson(SHOP_PATH, {}) };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

/** PRNG determinista (mulberry32). No se usa `Math.random`: un fuzz irreproducible no sirve. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const chosen = items[Math.floor(rng() * items.length)];
  // `noUncheckedIndexedAccess`: `items` nunca está vacío en este fichero, pero el tipo no lo sabe.
  return chosen ?? (items[0] as T);
}

/**
 * TODAS las claves que el recorrido trata de forma especial. Están aquí a propósito: el fallo que
 * se repitió cinco veces vivía exactamente en estas claves, no en las corrientes.
 */
const SPECIAL_KEYS: readonly string[] = [
  'errors',
  'error',
  'errorDetails',
  'errorCode',
  'processingError',
  'warnings',
  'warning',
  'warningDetails',
  'fault',
  'exception',
  'messages',
  'message',
  'Message',
  'status',
  'Status',
  'ProcessingStatus',
  'orderProcessingStatus',
  'Success',
  'Successes',
  'ApplicationResults',
  'SystemSpecificResults',
];

/** Claves corrientes: ninguna cae en una rama especial del clasificador. */
const PLAIN_KEYS: readonly string[] = [
  'data',
  'payload',
  'detail',
  'orders',
  'items',
  'result',
  'info',
  'wrapper',
  'node',
  'list',
  'itinerary',
  'legs',
  'segments',
  'price',
  'total',
  'currency',
  'vendor',
  'offer',
  'options',
  'count',
];

const ALL_KEYS: readonly string[] = [...SPECIAL_KEYS, ...PLAIN_KEYS];

/** Hoja escalar inocua. Bajo una clave neutra no declara absolutamente nada. */
function noiseLeaf(rng: () => number): unknown {
  const roll = rng();
  if (roll < 0.35) return 'texto-inocuo';
  if (roll < 0.6) return Math.floor(rng() * 1000);
  if (roll < 0.75) return true;
  if (roll < 0.85) return null;
  return { [pick(rng, PLAIN_KEYS)]: 'texto-inocuo' };
}

/**
 * El marcador. Cuelga de una clave `errors`, así que es un error inequívoco en CUALQUIER contexto
 * —ni el contrato (`Success[]`) ni un `severity: 'Info'` pueden rebajarlo—, y lleva identificadores
 * propios para poder exigir que lleguen al log. Si el marcador no aparece, el recorrido no llegó.
 */
const MARKER = { errors: [{ category: 'MARCADOR_ENTERRADO', type: 'MARCADOR_TIPO' }] } as const;
const MARKER_CATEGORY = 'MARCADOR_ENTERRADO';

/** Envuelve el marcador en una ruta aleatoria de objetos y arrays, con hermanos de ruido. */
function buryMarker(rng: () => number): unknown {
  let node: unknown = MARKER;
  const layers = 1 + Math.floor(rng() * 6);
  for (let layer = 0; layer < layers; layer += 1) {
    const roll = rng();
    if (roll < 0.2) {
      node = [node];
    } else if (roll < 0.35) {
      node = [noiseLeaf(rng), node, noiseLeaf(rng)];
    } else {
      const wrapped: Record<string, unknown> = { [pick(rng, ALL_KEYS)]: node };
      const siblings = Math.floor(rng() * 3);
      for (let index = 0; index < siblings; index += 1) {
        wrapped[`${pick(rng, PLAIN_KEYS)}${index}`] = noiseLeaf(rng);
      }
      node = wrapped;
    }
  }
  // La raíz siempre es un objeto: un array suelto en la raíz es «sobre vacío o no verificable» y
  // se rechazaría por otra razón, que enmascararía la propiedad que se está midiendo.
  return Array.isArray(node) ? { root: node } : node;
}

/** Árbol construido SÓLO con claves corrientes y hojas escalares. No hay nada que declarar. */
function cleanEnvelope(rng: () => number, depth = 0): Record<string, unknown> {
  const keys = 1 + Math.floor(rng() * 3);
  const node: Record<string, unknown> = {};
  for (let index = 0; index < keys; index += 1) {
    const key = `${pick(rng, PLAIN_KEYS)}${index}`;
    const roll = rng();
    if (depth >= 5 || roll < 0.4) node[key] = noiseLeaf(rng);
    else if (roll < 0.7) node[key] = [noiseLeaf(rng), cleanEnvelope(rng, depth + 1)];
    else node[key] = cleanEnvelope(rng, depth + 1);
  }
  return node;
}

const HOSTILE_CASES = 3_000;
const CLEAN_CASES = 2_000;
const SEED_BASE = 0x5a_b7_e0_01;

describe('fuzz — un error enterrado SIEMPRE se encuentra', () => {
  it(`${HOSTILE_CASES} sobres con el marcador bajo claves arbitrarias se rechazan todos`, async () => {
    for (let index = 0; index < HOSTILE_CASES; index += 1) {
      const seed = SEED_BASE + index;
      const payload = buryMarker(mulberry32(seed));
      const outcome = await post(payload);
      const trace = `semilla ${seed}: ${JSON.stringify(payload).slice(0, 400)}`;

      expect(outcome.kind, `ACEPTADO como reserva confirmada — ${trace}`).toBe('rejected');
      if (outcome.kind !== 'rejected') return;
      expect(outcome.error, trace).toBeInstanceOf(SabreApiError);
      // Que lance no basta: podría estar lanzando por el ruido. El MARCADOR en el log es la única
      // prueba de que el recorrido bajó hasta el fondo.
      expect(JSON.stringify((outcome.error as SabreApiError).toLogMeta()), trace).toContain(
        MARKER_CATEGORY,
      );
    }
  });

  it('el generador entierra de verdad: ningún sobre lleva el marcador en la raíz', () => {
    let buried = 0;
    for (let index = 0; index < 200; index += 1) {
      const payload = buryMarker(mulberry32(SEED_BASE + index)) as Record<string, unknown>;
      if (!('errors' in payload)) buried += 1;
    }
    // Si el generador degenerara a `{errors:[…]}` en la raíz, el test de arriba sería tautológico.
    expect(buried).toBeGreaterThan(150);
  });

  it('el generador se mantiene lejos del tope de profundidad', () => {
    const deepest = (value: unknown, depth = 0): number => {
      if (Array.isArray(value)) return Math.max(depth, ...value.map((i) => deepest(i, depth + 1)));
      if (typeof value === 'object' && value !== null) {
        const children = Object.values(value as Record<string, unknown>);
        return children.length === 0
          ? depth
          : Math.max(depth, ...children.map((i) => deepest(i, depth + 1)));
      }
      return depth;
    };
    let worst = 0;
    for (let index = 0; index < 500; index += 1) {
      worst = Math.max(worst, deepest(buryMarker(mulberry32(SEED_BASE + index))));
    }
    // Si el generador rozara el tope, los rechazos podrían venir de `exhaustive = false` y no de
    // haber encontrado el marcador. Se comprueba en vez de suponerlo.
    expect(worst).toBeLessThan(SABRE_ENVELOPE_MAX_DEPTH / 2);
  });
});

describe('fuzz — un sobre sin nada que declarar SIEMPRE se acepta', () => {
  it(`${CLEAN_CASES} sobres de claves corrientes y hojas escalares se entregan sin warnings`, async () => {
    for (let index = 0; index < CLEAN_CASES; index += 1) {
      const seed = SEED_BASE + 1_000_000 + index;
      const payload = cleanEnvelope(mulberry32(seed));
      const outcome = await post(payload);
      const trace = `semilla ${seed}: ${JSON.stringify(payload).slice(0, 400)}`;

      expect(outcome.kind, `FALSO POSITIVO — ${trace}`).toBe('resolved');
      if (outcome.kind !== 'resolved') return;
      const result = outcome.value as SabreResult<unknown>;
      expect(result.warnings, trace).toHaveLength(0);
      expect(result.partialUnauthorized, trace).toHaveLength(0);
    }
  });

  it('el mismo sobre limpio con el marcador dentro se rechaza: los dos carriles son el mismo', async () => {
    // El par que demuestra que el carril limpio no está aceptando por accidente: mismo generador,
    // misma semilla, una sola diferencia.
    const clean = cleanEnvelope(mulberry32(SEED_BASE + 1_000_000));
    expect((await post(clean)).kind).toBe('resolved');

    const contaminated = { ...clean, ...MARKER };
    const outcome = await post(contaminated);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(JSON.stringify((outcome.error as SabreApiError).toLogMeta())).toContain(MARKER_CATEGORY);
  });
});
