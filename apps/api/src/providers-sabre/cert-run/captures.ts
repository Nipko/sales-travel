import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REDACTED, SABRE_AUTH_PATH, redactDocument, redactText } from '@sales-travel/sabre';
import { assertCertRequestUrl } from './cert-guard.js';

/**
 * La evidencia del arnés de certificación (SAB-11): cada request y cada respuesta que el ACL cruza
 * con CERT, redactadas antes de tocar el disco, y el resultado de cada paso.
 *
 * Tres capas, y ninguna confía en las otras:
 *
 * 1. **Por clave y por forma** con `redactDocument`, la política del ACL (`providers/sabre/src/
 *    redaction.ts`): secretos, PCC, PII de pasajero y texto libre del proveedor.
 * 2. **El token, nunca**: el cuerpo de `/v2/auth/token` no se guarda —ni el que sale, que lleva el
 *    `grant_type`, ni el que vuelve, del que sólo quedan `token_type` y `expires_in`— y las cabeceras
 *    salen de una lista blanca que no tiene `Authorization`.
 * 3. **Los valores conocidos**: el {@link SecretScrubber} sabe la credencial de la cuenta y cada
 *    token que pasó, y los busca LITERALES en el texto final de cada archivo. Si aparece uno, se
 *    tapa y el resumen lo cuenta: es un hallazgo, la capa 1 no lo vio.
 */

/** Un valor más corto no se busca suelto: taparía códigos de aeropuerto o de clase. */
const SCRUB_MIN_LENGTH = 4;

/** Cabeceras que pueden quedar en la evidencia. Ninguna lleva credencial ni PCC. */
const SAFE_HEADERS = new Set(['content-type', 'accept', 'conversation-id']);

export const AUTH_REQUEST_OMITTED = '«CUERPO-DEL-TOKEN: nunca se guarda»';

/**
 * Los secretos que el arnés conoce y que no pueden aparecer en ningún archivo: la credencial de la
 * cuenta, el `secret` derivado y los tokens recibidos. Se buscan literales y se reemplazan.
 */
export class SecretScrubber {
  private readonly values = new Set<string>();

  add(value: unknown): void {
    if (typeof value === 'string' && value.length >= SCRUB_MIN_LENGTH) this.values.add(value);
  }

  /** El texto sin ninguno de los secretos conocidos, y cuántas apariciones se taparon. */
  scrub(text: string): { text: string; hits: number } {
    let hits = 0;
    let out = text;
    // Los más largos primero: un token puede contener a un valor más corto.
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) {
      const parts = out.split(secret);
      if (parts.length > 1) {
        hits += parts.length - 1;
        out = parts.join(REDACTED);
      }
    }
    return { text: out, hits };
  }
}

export interface CertExchange {
  readonly seq: number;
  readonly method: string;
  /** Origen y ruta, sin query. */
  readonly url: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly conversationId?: string;
  readonly request: { readonly headers: Record<string, string>; readonly body: unknown };
  readonly response?: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  };
  /** El fallo de transporte, por nombre: el mensaje de un error de red puede traer la URL entera. */
  readonly transportError?: string;
}

export type CertStepOutcome = 'ok' | 'failed' | 'skipped';

export interface CertStepRecord {
  readonly scenario: string;
  readonly step: string;
  readonly startedAt: string;
  durationMs: number;
  outcome: CertStepOutcome;
  /** Lo que devolvió el paso (vista canónica), ya redactado. */
  result?: unknown;
  /** Por qué falló, sin texto del proveedor (ver `describeCertError`). */
  error?: unknown;
  /** Lo que se anunció antes de mover dinero, tal cual se imprimió. */
  announced?: string;
  readonly exchanges: CertExchange[];
  /** Las líneas de log del ACL durante el paso, ya redactadas por el ACL y otra vez aquí. */
  readonly logs: string[];
}

/** Un cuerpo de request o de respuesta como evidencia: JSON redactado o texto redactado. */
export function evidenceBody(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return '«CUERPO-NO-TEXTO»';
  if (raw.length === 0) return '';
  try {
    return redactDocument(JSON.parse(raw) as unknown);
  } catch {
    return redactText(raw);
  }
}

/**
 * La respuesta del token como evidencia: sólo `token_type` y `expires_in` (P-08, la vida real del
 * token). El `access_token` se le da al {@link SecretScrubber} para que no aparezca en NINGÚN archivo
 * —ni en el eco de un error posterior— y aquí queda tapado.
 */
export function tokenEvidence(raw: string, scrubber: SecretScrubber): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return '«RESPUESTA-DEL-TOKEN-NO-JSON»';
  }
  if (typeof parsed !== 'object' || parsed === null) return '«RESPUESTA-DEL-TOKEN-NO-JSON»';
  const record = parsed as Record<string, unknown>;
  scrubber.add(record['access_token']);
  const out: Record<string, unknown> = {};
  if (typeof record['token_type'] === 'string') out['token_type'] = record['token_type'];
  if (typeof record['expires_in'] === 'number' || typeof record['expires_in'] === 'string') {
    out['expires_in'] = record['expires_in'];
  }
  if ('access_token' in record) out['access_token'] = REDACTED;
  if ('error' in record) out['error'] = redactDocument(record['error']);
  return out;
}

/** Las cabeceras de la lista blanca, en minúsculas. */
export function safeHeaders(headers: RequestInit['headers'] | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  let normalized: Headers;
  try {
    normalized = headers instanceof Headers ? headers : new Headers(headers);
  } catch {
    return out;
  }
  normalized.forEach((value, name) => {
    const key = name.toLowerCase();
    if (SAFE_HEADERS.has(key)) out[key] = redactText(value);
  });
  return out;
}

/** Origen y ruta, sin query ni fragmento: la query puede llevar un localizador o un token. */
function urlForEvidence(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '«URL-ILEGIBLE»';
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Lleva los pasos de una corrida: a qué paso pertenece cada intercambio y cada línea de log. El arnés
 * corre los pasos de uno en uno, así que basta un puntero al paso abierto.
 */
export class CertEvidenceRecorder {
  readonly steps: CertStepRecord[] = [];
  private open: { record: CertStepRecord; startedMs: number } | undefined;
  private seq = 0;
  /** Intercambios y logs que llegan sin paso abierto (arranque, limpieza global). */
  readonly orphanExchanges: CertExchange[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  begin(scenario: string, step: string): CertStepRecord {
    const startedMs = this.now();
    const record: CertStepRecord = {
      scenario,
      step,
      startedAt: new Date(startedMs).toISOString(),
      durationMs: 0,
      outcome: 'skipped',
      exchanges: [],
      logs: [],
    };
    this.steps.push(record);
    this.open = { record, startedMs };
    return record;
  }

  end(
    outcome: CertStepOutcome,
    detail: { result?: unknown; error?: unknown } = {},
  ): CertStepRecord | undefined {
    const open = this.open;
    if (open === undefined) return undefined;
    open.record.outcome = outcome;
    open.record.durationMs = this.now() - open.startedMs;
    if (detail.result !== undefined) open.record.result = redactDocument(detail.result);
    if (detail.error !== undefined) open.record.error = redactDocument(detail.error);
    this.open = undefined;
    return open.record;
  }

  announce(text: string): void {
    if (this.open !== undefined) this.open.record.announced = text;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  recordExchange(exchange: CertExchange): void {
    (this.open?.record.exchanges ?? this.orphanExchanges).push(exchange);
  }

  recordLog(line: string): void {
    this.open?.record.logs.push(redactText(line));
  }
}

export interface CertTransportDeps {
  readonly inner: typeof fetch;
  readonly recorder: CertEvidenceRecorder;
  readonly scrubber: SecretScrubber;
  readonly now?: () => number;
}

/**
 * El `fetch` del proceso del arnés: comprueba que la URL es de CERT ANTES de salir y graba el
 * intercambio redactado. Una URL que no es CERT no llega a `inner`: lanza y no queda nada que grabar.
 */
export function createCertTransport(deps: CertTransportDeps): typeof fetch {
  const now = deps.now ?? Date.now;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    assertCertRequestUrl(url);

    const isAuth = new URL(url).pathname === SABRE_AUTH_PATH;
    const requestHeaders = safeHeaders(init?.headers);
    const startedMs = now();
    const base = {
      seq: deps.recorder.nextSeq(),
      method: (init?.method ?? 'GET').toUpperCase(),
      url: urlForEvidence(url),
      startedAt: new Date(startedMs).toISOString(),
      ...(requestHeaders['conversation-id'] === undefined
        ? {}
        : { conversationId: requestHeaders['conversation-id'] }),
      request: {
        headers: requestHeaders,
        body: isAuth ? AUTH_REQUEST_OMITTED : evidenceBody(init?.body),
      },
    };

    let response: Response;
    try {
      // Sin seguir redirecciones: `fetch` las sigue solo, por dentro, y la URL de destino nunca
      // volvería a pasar por `assertCertRequestUrl`. Un 3xx de CERT hacia otro host reenviaría la
      // petición —un 307 o 308 con su cuerpo— a un sitio que nadie comprobó. Sabre no redirige: un
      // 3xx es un fallo de transporte, no un desvío que se acepta.
      response = await deps.inner(input, { ...init, redirect: 'error' });
    } catch (err) {
      deps.recorder.recordExchange({
        ...base,
        durationMs: now() - startedMs,
        transportError: err instanceof Error ? err.name : 'Error',
      });
      throw err;
    }

    let text: string | undefined;
    try {
      text = await response.clone().text();
    } catch {
      text = undefined;
    }
    deps.recorder.recordExchange({
      ...base,
      durationMs: now() - startedMs,
      response: {
        status: response.status,
        headers: safeHeaders(response.headers),
        body:
          text === undefined
            ? '«CUERPO-ILEGIBLE»'
            : isAuth
              ? tokenEvidence(text, deps.scrubber)
              : evidenceBody(text),
      },
    });
    return response;
  };
}

/** Dónde y cómo se escriben los archivos. Inyectable para probar sin disco. */
export interface CertEvidenceSink {
  mkdir(dir: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
}

export const nodeEvidenceSink: CertEvidenceSink = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  write: (path, content) => writeFile(path, content, { encoding: 'utf8', mode: 0o600 }),
};

/**
 * Escribe archivos de evidencia en una carpeta, cada uno pasado por el {@link SecretScrubber} justo
 * antes del disco. Cuenta lo que tuvo que tapar: si no es cero, la redacción por clave dejó pasar
 * un secreto conocido y eso va al resumen.
 */
export class CertEvidenceWriter {
  private scrubbedHits = 0;
  readonly written: string[] = [];

  constructor(
    readonly dir: string,
    private readonly scrubber: SecretScrubber,
    private readonly sink: CertEvidenceSink = nodeEvidenceSink,
  ) {}

  get secretsScrubbed(): number {
    return this.scrubbedHits;
  }

  async prepare(): Promise<void> {
    await this.sink.mkdir(this.dir);
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.writeText(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeText(name: string, content: string): Promise<void> {
    const { text, hits } = this.scrubber.scrub(content);
    this.scrubbedHits += hits;
    await this.sink.write(join(this.dir, name), text);
    this.written.push(name);
  }
}

/** El nombre del archivo de un paso: orden, escenario y paso, sólo con caracteres seguros. */
export function stepFileName(index: number, record: Pick<CertStepRecord, 'scenario' | 'step'>) {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${String(index).padStart(2, '0')}-${slug(record.scenario)}-${slug(record.step)}.json`;
}
