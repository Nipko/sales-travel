import { describe, expect, it } from 'vitest';
import { TBO_REDACTED } from './config';
import {
  TBO_LOG_FIELDS,
  isTboCardKey,
  isTboSensitiveKey,
  normalizeTboKey,
  pickTboLogMeta,
  redactTboPayload,
} from './redaction';

describe('normalizeTboKey', () => {
  it('minúsculas y sólo alfanuméricos, porque TBO mezcla el casing (p. 35, 38)', () => {
    expect(normalizeTboKey('CardHolderlastName')).toBe('cardholderlastname');
    expect(normalizeTboKey('Card_Holder-Last Name')).toBe('cardholderlastname');
    expect(normalizeTboKey('AddressLine1')).toBe('addressline1');
  });
});

describe('isTboCardKey (01 §10.5)', () => {
  it.each([
    'CardNumber',
    'CvvNumber',
    'CardExpirationMonth',
    'CardExpirationYear',
    'CardHolderFirstName',
    'CardHolderlastName',
    'CardHolderAddress',
    'PaymentInfo',
    'paymentInfo',
    'card_number',
    'CVV',
    'SecurityCvv2',
  ])('%s es clave de tarjeta', (key) => {
    expect(isTboCardKey(key)).toBe(true);
  });

  it.each(['BookingCode', 'PaymentMode', 'HotelCard', 'Discard', 'ClientReferenceId'])(
    '%s no lo es',
    (key) => {
      expect(isTboCardKey(key)).toBe(false);
    },
  );
});

describe('isTboSensitiveKey (01 §11.3)', () => {
  it.each([
    'FirstName',
    'LastName',
    'EmailId',
    'Email',
    'PhoneNumber',
    'Phone',
    'AddressLine1',
    'AddressLine2',
    'PostalCode',
    'TripName',
    'CardNumber',
  ])('%s se enmascara', (key) => {
    expect(isTboSensitiveKey(key)).toBe(true);
  });

  it.each(['ConfirmationNumber', 'BookingReferenceId', 'HotelCode', 'Title', 'Type'])(
    '%s no se enmascara',
    (key) => {
      expect(isTboSensitiveKey(key)).toBe(false);
    },
  );
});

describe('redactTboPayload', () => {
  // Forma de un Book de p. 32-35, con datos inventados y una PaymentInfo que nunca mandaríamos.
  const book = {
    BookingCode: '1345320!TB!3!TB!af78e57f',
    CustomerDetails: [
      {
        CustomerNames: [
          { Title: 'Mr', FirstName: 'Ana', LastName: 'Pérez', Type: 'Adult' },
          { Title: 'Ms', firstname: 'Eva', lastName: 'Ruiz', Type: 'Adult' },
        ],
      },
    ],
    ClientReferenceId: 'REF-1',
    EmailId: 'ana@example.test',
    PhoneNumber: '+573001112233',
    PaymentMode: 'Limit',
    PaymentInfo: { CardNumber: '4111111111111111', CvvNumber: '123' },
    Nested: { Deeper: [{ AddressLine1: 'Calle 1', PostalCode: '110111' }] },
  };

  it('enmascara personales y tarjeta a cualquier profundidad y conserva lo operativo', () => {
    expect(redactTboPayload(book)).toEqual({
      BookingCode: '1345320!TB!3!TB!af78e57f',
      CustomerDetails: [
        {
          CustomerNames: [
            { Title: 'Mr', FirstName: TBO_REDACTED, LastName: TBO_REDACTED, Type: 'Adult' },
            { Title: 'Ms', firstname: TBO_REDACTED, lastName: TBO_REDACTED, Type: 'Adult' },
          ],
        },
      ],
      ClientReferenceId: 'REF-1',
      EmailId: TBO_REDACTED,
      PhoneNumber: TBO_REDACTED,
      PaymentMode: 'Limit',
      PaymentInfo: TBO_REDACTED,
      Nested: { Deeper: [{ AddressLine1: TBO_REDACTED, PostalCode: TBO_REDACTED }] },
    });
  });

  it('no toca el original', () => {
    const copy = JSON.parse(JSON.stringify(book)) as unknown;
    redactTboPayload(book);
    expect(book).toEqual(copy);
  });

  it('escalares y null pasan tal cual', () => {
    expect(redactTboPayload('x')).toBe('x');
    expect(redactTboPayload(null)).toBeNull();
    expect(redactTboPayload([1, 'a'])).toEqual([1, 'a']);
  });
});

describe('pickTboLogMeta: la lista blanca de 01 §11.1', () => {
  it('deja pasar las claves de la lista con valores escalares', () => {
    expect(pickTboLogMeta({ op: 'search', status: 200, timedOut: false, issues: ['a:b'] })).toEqual(
      { op: 'search', status: 200, timedOut: false, issues: ['a:b'] },
    );
  });

  it('descarta lo que no está en la lista, aunque parezca inofensivo', () => {
    expect(
      pickTboLogMeta({
        op: 'book',
        headers: { Authorization: 'Basic x' },
        Authorization: 'Basic x',
        body: '{"FirstName":"Ana"}',
        FirstName: 'Ana',
        EmailId: 'a@b.c',
        PhoneNumber: '1',
        username: 'u',
        password: 'p',
      }),
    ).toEqual({ op: 'book' });
  });

  it('descarta objetos y listas que no son de texto aunque la clave esté permitida', () => {
    expect(
      pickTboLogMeta({ description: { FirstName: 'Ana' }, issues: [{ a: 1 }], status: NaN }),
    ).toEqual({});
  });

  it('recorta textos y listas largas', () => {
    const meta = pickTboLogMeta({
      description: 'x'.repeat(1_000),
      issues: Array.from({ length: 50 }, (_, i) => `k${i}:c`),
    });
    expect(meta['description']).toHaveLength(200);
    expect(meta['issues']).toHaveLength(20);
  });

  it('la lista no tiene claves de cabeceras, cuerpos, credenciales ni datos personales', () => {
    for (const forbidden of [
      'authorization',
      'headers',
      'body',
      'username',
      'password',
      'firstname',
      'lastname',
      'emailid',
      'phonenumber',
      'customernames',
    ]) {
      expect([...TBO_LOG_FIELDS].map(normalizeTboKey)).not.toContain(forbidden);
    }
  });
});
