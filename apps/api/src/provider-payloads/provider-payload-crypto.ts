import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PROVIDER_PAYLOAD_ENVIRONMENTS,
  type ProviderPayloadEnvironment,
} from '../database/database.types.js';
import {
  decryptCredentials,
  encryptCredentials,
} from '../provider-credentials/credentials-cipher.js';

/**
 * Cifrado de los cuerpos de la bóveda de payloads. Es el MISMO AES-256-GCM de la bóveda de
 * credenciales (`credentials-cipher.ts`, sin copiarlo) con una clave propia: comprometer una no
 * abre la otra, y rotar la de payloads no toca las credenciales.
 *
 * Lo que se cifra no es el cuerpo solo sino un sobre que lo ata a su fila (proveedor, id de la
 * llamada, intento y parte) y a las dos columnas que deciden cómo sale (dueño de la cuenta y
 * entorno). GCM ya detecta un blob alterado; el sobre detecta uno MOVIDO: quien pudiera escribir
 * en la base no podría pasar la respuesta de una llamada por la de otra, ni el request por la
 * response, ni cambiar el dueño de una fila para leerla desde otra red, ni pasar una de `live` a
 * `test` para exportarla sin redactar.
 */

export interface PayloadKey {
  /** Huella de 16 hex: va en `provider_payloads.key_id` y no revela la clave. */
  readonly id: string;
  readonly key: Buffer;
}

/** Con qué se cifra (la vigente) y con qué se puede descifrar (la vigente y la anterior). */
export interface PayloadKeyring {
  readonly current: PayloadKey;
  readonly byId: ReadonlyMap<string, Buffer>;
}

export type PayloadPart = 'request' | 'response';

/** A qué fila pertenece un cuerpo. */
export interface PayloadBinding {
  readonly providerCode: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly part: PayloadPart;
  /** Decide quién lee la fila (`can_read_provider_payloads`, 0043). */
  readonly ownerTenantId: string;
  /** Decide si sale redactada. */
  readonly environment: ProviderPayloadEnvironment;
}

const KEY_BYTES = 32;

/** Base64 estándar de exactamente 32 bytes. `Buffer.from(…, 'base64')` ignora basura; esto no. */
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

/**
 * La clave desde su base64, o `undefined` si no tiene la forma exacta. Nunca un mensaje con el
 * valor: quien llama sólo dice qué variable está mal.
 */
export function parsePayloadKey(raw: string): PayloadKey | undefined {
  if (!BASE64_32_BYTES.test(raw)) return undefined;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) return undefined;
  return { id: payloadKeyId(key), key };
}

/** Separación de dominio: la huella de esta clave no coincide con ninguna otra huella de la app. */
export function payloadKeyId(key: Buffer): string {
  return createHash('sha256')
    .update('sales-travel/provider-payloads/key-id')
    .update('\u0000')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

export function payloadKeyring(current: PayloadKey, previous?: PayloadKey): PayloadKeyring {
  const byId = new Map<string, Buffer>([[current.id, current.key]]);
  if (previous !== undefined && !byId.has(previous.id)) byId.set(previous.id, previous.key);
  return { current, byId };
}

const EnvelopeSchema = z
  .object({
    v: z.literal(1),
    p: z.string(),
    r: z.string(),
    a: z.number().int(),
    part: z.enum(['request', 'response']),
    o: z.string(),
    e: z.enum(PROVIDER_PAYLOAD_ENVIRONMENTS),
    body: z.string(),
  })
  .strict();

type Envelope = z.infer<typeof EnvelopeSchema>;

export function sealPayload(body: string, binding: PayloadBinding, key: PayloadKey): Buffer {
  const envelope: Envelope = {
    v: 1,
    p: binding.providerCode,
    r: binding.requestId,
    a: binding.attempt,
    part: binding.part,
    o: binding.ownerTenantId,
    e: binding.environment,
    body,
  };
  return encryptCredentials(JSON.stringify(envelope), key.key);
}

export type OpenedPayload =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: 'unknown_key' | 'undecryptable' | 'misplaced' };

/**
 * Nunca lanza: un blob que no abre es un cuerpo retenido en la exportación, no un 500. Recibe las
 * claves y no el llavero porque, con la bóveda apagada, no hay llavero y lo ya guardado se sigue
 * pudiendo listar (con los cuerpos retenidos) hasta que venza.
 */
export function openPayload(
  blob: Buffer,
  keyId: string,
  binding: PayloadBinding,
  keys: ReadonlyMap<string, Buffer>,
): OpenedPayload {
  const key = keys.get(keyId);
  if (key === undefined) return { ok: false, reason: 'unknown_key' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptCredentials(blob, key));
  } catch {
    return { ok: false, reason: 'undecryptable' };
  }
  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return { ok: false, reason: 'undecryptable' };
  const e = envelope.data;
  if (
    e.p !== binding.providerCode ||
    e.r !== binding.requestId ||
    e.a !== binding.attempt ||
    e.part !== binding.part ||
    e.o !== binding.ownerTenantId ||
    e.e !== binding.environment
  ) {
    return { ok: false, reason: 'misplaced' };
  }
  return { ok: true, body: e.body };
}
