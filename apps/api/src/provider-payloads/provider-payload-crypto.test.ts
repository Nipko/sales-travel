import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  openPayload,
  parsePayloadKey,
  payloadKeyId,
  payloadKeyring,
  sealPayload,
  type PayloadBinding,
  type PayloadKey,
} from './provider-payload-crypto.js';

/**
 * Cifrado de la bóveda de payloads (docs/tbo/09 PR-4.9): el AES-256-GCM de la bóveda de
 * credenciales con una clave propia, y un sobre que ata cada cuerpo a su fila.
 */

function nuevaClave(): PayloadKey {
  const key = parsePayloadKey(randomBytes(32).toString('base64'));
  if (key === undefined) throw new Error('clave de prueba inválida');
  return key;
}

const BINDING: PayloadBinding = {
  providerCode: 'tbo-hotels',
  requestId: '0b8f2f7e-6a55-4c38-9d8e-6d1f0f5f1a01',
  attempt: 1,
  part: 'request',
  ownerTenantId: '33333333-3333-4333-8333-333333333333',
  environment: 'live',
};

// Sintético, con forma de dato personal para buscarlo en los bytes.
const CUERPO = JSON.stringify({
  BookingReferenceId: 'STT-0001',
  CustomerDetails: [{ CustomerNames: [{ FirstName: 'Xiomara', LastName: 'Quintanilla' }] }],
});

describe('parsePayloadKey', () => {
  it('acepta sólo el base64 estándar de exactamente 32 bytes', () => {
    const buena = randomBytes(32).toString('base64');
    expect(parsePayloadKey(buena)?.key.length).toBe(32);

    expect({
      corta: parsePayloadKey(randomBytes(31).toString('base64')),
      larga: parsePayloadKey(randomBytes(33).toString('base64')),
      base64url: parsePayloadKey(randomBytes(32).toString('base64url')),
      conEspacios: parsePayloadKey(` ${buena} `),
      hex: parsePayloadKey(randomBytes(32).toString('hex')),
      vacia: parsePayloadKey(''),
    }).toEqual({
      corta: undefined,
      larga: undefined,
      base64url: undefined,
      conEspacios: undefined,
      hex: undefined,
      vacia: undefined,
    });
  });

  it('la huella es estable, de 16 hex, distinta por clave, y no contiene la clave', () => {
    const raw = randomBytes(32);
    const a = parsePayloadKey(raw.toString('base64'));
    const b = nuevaClave();

    expect(a?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(a?.id).toBe(payloadKeyId(raw));
    expect(a?.id).not.toBe(b.id);
    expect(raw.toString('hex')).not.toContain(a?.id);
  });
});

describe('sealPayload / openPayload', () => {
  it('ida y vuelta con la clave vigente; en la base no queda el texto en claro', () => {
    const key = nuevaClave();
    const blob = sealPayload(CUERPO, BINDING, key);

    expect(blob.toString('utf8')).not.toContain('Xiomara');
    expect(blob.toString('latin1')).not.toContain('Quintanilla');
    expect(openPayload(blob, key.id, BINDING, payloadKeyring(key).byId)).toEqual({
      ok: true,
      body: CUERPO,
    });
  });

  it('cada cifrado usa un IV nuevo: el mismo cuerpo da dos blobs distintos', () => {
    const key = nuevaClave();
    expect(sealPayload(CUERPO, BINDING, key).equals(sealPayload(CUERPO, BINDING, key))).toBe(false);
  });

  it('con la clave anterior en el llavero, lo cifrado antes de rotar se sigue abriendo', () => {
    const vieja = nuevaClave();
    const nueva = nuevaClave();
    const blobViejo = sealPayload(CUERPO, BINDING, vieja);
    const rotado = payloadKeyring(nueva, vieja);

    expect(rotado.current.id).toBe(nueva.id);
    expect(openPayload(blobViejo, vieja.id, BINDING, rotado.byId)).toEqual({
      ok: true,
      body: CUERPO,
    });
    // Retirada la anterior, lo viejo deja de abrir: no se adivina con la vigente.
    expect(openPayload(blobViejo, vieja.id, BINDING, payloadKeyring(nueva).byId)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('un blob alterado o abierto con otra clave bajo el mismo id no abre, y no lanza', () => {
    const key = nuevaClave();
    const otra = nuevaClave();
    const blob = sealPayload(CUERPO, BINDING, key);
    const alterado = Buffer.from(blob);
    alterado[alterado.length - 1] = (alterado[alterado.length - 1] ?? 0) ^ 0xff;

    expect(openPayload(alterado, key.id, BINDING, payloadKeyring(key).byId)).toEqual({
      ok: false,
      reason: 'undecryptable',
    });
    expect(openPayload(blob, key.id, BINDING, new Map([[key.id, otra.key]]))).toEqual({
      ok: false,
      reason: 'undecryptable',
    });
    expect(openPayload(Buffer.alloc(3), key.id, BINDING, payloadKeyring(key).byId)).toEqual({
      ok: false,
      reason: 'undecryptable',
    });
  });

  it('un cuerpo movido a otra fila o a la otra parte se detecta', () => {
    const key = nuevaClave();
    const keys = payloadKeyring(key).byId;
    const blob = sealPayload(CUERPO, BINDING, key);

    expect({
      otraLlamada: openPayload(blob, key.id, { ...BINDING, requestId: 'otra' }, keys),
      otroIntento: openPayload(blob, key.id, { ...BINDING, attempt: 2 }, keys),
      otraParte: openPayload(blob, key.id, { ...BINDING, part: 'response' }, keys),
      otroProveedor: openPayload(blob, key.id, { ...BINDING, providerCode: 'otro' }, keys),
    }).toEqual({
      otraLlamada: { ok: false, reason: 'misplaced' },
      otroIntento: { ok: false, reason: 'misplaced' },
      otraParte: { ok: false, reason: 'misplaced' },
      otroProveedor: { ok: false, reason: 'misplaced' },
    });
  });

  it('una fila a la que le cambiaron el dueño o el entorno no abre: ni otra red la lee, ni sale sin redactar', () => {
    const key = nuevaClave();
    const keys = payloadKeyring(key).byId;
    const blob = sealPayload(CUERPO, BINDING, key);

    expect({
      otroDueno: openPayload(
        blob,
        key.id,
        { ...BINDING, ownerTenantId: '44444444-4444-4444-8444-444444444444' },
        keys,
      ),
      liveComoTest: openPayload(blob, key.id, { ...BINDING, environment: 'test' }, keys),
    }).toEqual({
      otroDueno: { ok: false, reason: 'misplaced' },
      liveComoTest: { ok: false, reason: 'misplaced' },
    });
  });
});
