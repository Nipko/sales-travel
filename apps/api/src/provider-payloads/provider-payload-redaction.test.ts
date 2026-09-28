import { randomBytes } from 'node:crypto';
import { TBO_REDACTED } from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import {
  parsePayloadKey,
  payloadKeyring,
  sealPayload,
  type PayloadBinding,
  type PayloadKey,
} from './provider-payload-crypto.js';
import { redactorFor, renderPayloadBody } from './provider-payload-redaction.js';

/**
 * Cómo sale un cuerpo de la bóveda (docs/tbo/09 PR-4.9; 01 §11.3): tal cual sin redactar, con el
 * redactor del proveedor en `live`, y retenido —nunca a medias— cuando no se puede hacer bien.
 */

const KEY = parsePayloadKey(randomBytes(32).toString('base64')) as PayloadKey;
const KEYS = payloadKeyring(KEY).byId;
const BINDING: PayloadBinding = {
  providerCode: 'tbo-hotels',
  requestId: 'req-1',
  attempt: 1,
  part: 'request',
  ownerTenantId: '33333333-3333-4333-8333-333333333333',
  environment: 'live',
};

// Book RQ sintético con las claves personales y de tarjeta de 01 §11.3 (con el casing mixto de TBO).
const BOOK_RQ = {
  BookingCode: '1120548!TB!1!TB!abc',
  BookingReferenceId: 'STT-0001',
  PaymentMode: 'Limit',
  CustomerDetails: [
    {
      CustomerNames: [
        { Title: 'Mr', FirstName: 'Xiomara', LastName: 'Quintanilla', Type: 'Adult' },
      ],
    },
  ],
  EmailId: 'xiomara@example.test',
  PhoneNumber: '+57 300 000 0000',
  AddressLine1: 'Calle Falsa 123',
  PostalCode: '110111',
  CardHolderlastName: 'Quintanilla',
};

function sellado(body: string) {
  return { bytes: Buffer.byteLength(body), sealed: sealPayload(body, BINDING, KEY), keyId: KEY.id };
}

describe('renderPayloadBody', () => {
  it('sin redactar: el JSON tal cual, y un texto que no es JSON también', () => {
    const json = renderPayloadBody(sellado(JSON.stringify(BOOK_RQ)), BINDING, KEYS, {
      redact: false,
    });
    const html = renderPayloadBody(sellado('<html>502 Bad Gateway</html>'), BINDING, KEYS, {
      redact: false,
    });

    expect(json).toEqual({ kind: 'json', value: BOOK_RQ });
    expect(html).toEqual({ kind: 'text', value: '<html>502 Bad Gateway</html>' });
  });

  it('en live, con el redactor de TBO: identificadores a la vista, datos personales tachados', () => {
    const out = renderPayloadBody(sellado(JSON.stringify(BOOK_RQ)), BINDING, KEYS, {
      redact: true,
      redactor: redactorFor('tbo-hotels'),
    });

    expect(out).toEqual({
      kind: 'json',
      value: {
        BookingCode: '1120548!TB!1!TB!abc',
        BookingReferenceId: 'STT-0001',
        PaymentMode: 'Limit',
        CustomerDetails: [
          {
            CustomerNames: [
              { Title: 'Mr', FirstName: TBO_REDACTED, LastName: TBO_REDACTED, Type: 'Adult' },
            ],
          },
        ],
        EmailId: TBO_REDACTED,
        PhoneNumber: TBO_REDACTED,
        AddressLine1: TBO_REDACTED,
        PostalCode: TBO_REDACTED,
        CardHolderlastName: TBO_REDACTED,
      },
    });
    const dump = JSON.stringify(out);
    for (const dato of ['Xiomara', 'Quintanilla', 'xiomara@', '300 000', 'Falsa', '110111']) {
      expect(dump).not.toContain(dato);
    }
  });

  it('en live se falla cerrado: sin redactor del proveedor, o con un cuerpo que no es JSON, no sale', () => {
    const sinRedactor = renderPayloadBody(sellado(JSON.stringify(BOOK_RQ)), BINDING, KEYS, {
      redact: true,
      redactor: redactorFor('proveedor-sin-redactor'),
    });
    const texto = 'Error: Xiomara Quintanilla no tiene saldo';
    const noJson = renderPayloadBody(sellado(texto), BINDING, KEYS, {
      redact: true,
      redactor: redactorFor('tbo-hotels'),
    });

    expect(sinRedactor).toEqual({
      kind: 'withheld',
      reason: 'no_redactor',
      bytes: Buffer.byteLength(JSON.stringify(BOOK_RQ)),
    });
    expect(noJson).toEqual({ kind: 'withheld', reason: 'not_json', bytes: texto.length });
  });

  it('sin cuerpo, demasiado grande o indescifrable: lo dice, con el tamaño y sin contenido', () => {
    expect({
      sinCuerpo: renderPayloadBody({ bytes: null, sealed: null, keyId: KEY.id }, BINDING, KEYS, {
        redact: false,
      }),
      grande: renderPayloadBody({ bytes: 5_000_000, sealed: null, keyId: KEY.id }, BINDING, KEYS, {
        redact: false,
      }),
      claveRetirada: renderPayloadBody(sellado('{}'), BINDING, new Map(), { redact: false }),
      movido: renderPayloadBody(sellado('{}'), { ...BINDING, part: 'response' }, KEYS, {
        redact: false,
      }),
    }).toEqual({
      sinCuerpo: { kind: 'absent' },
      grande: { kind: 'withheld', reason: 'too_large', bytes: 5_000_000 },
      claveRetirada: { kind: 'withheld', reason: 'undecryptable', bytes: 2 },
      movido: { kind: 'withheld', reason: 'undecryptable', bytes: 2 },
    });
  });

  it('el registro de redactores no encuentra nada heredado de Object.prototype', () => {
    expect(redactorFor('toString')).toBeUndefined();
    expect(redactorFor('__proto__')).toBeUndefined();
    expect(redactorFor('tbo-hotels')).toBeTypeOf('function');
  });
});
