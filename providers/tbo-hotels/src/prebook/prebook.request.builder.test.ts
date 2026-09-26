import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTboConfig } from '../config';
import { TboRequestBuildError } from '../errors';
import { TboHttpClient, type TboFetch } from '../http/tbo-http.client';
import {
  TBO_PREBOOK_PAYMENT_MODE,
  TboPrebookRequestSchema,
  buildTboPrebookRequest,
  type TboPrebookInput,
} from './prebook.request.builder';

/**
 * El body de PreBook contra Postman y el PDF (docs/tbo/03 §2.1; 08 RF-15 CA-1) y la barrera D1 en
 * sus tres capas: tipo, esquema de salida y bytes del cable.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');

interface PostmanFixture {
  readonly url: string;
  readonly discrepancies: readonly { readonly path: string }[];
  readonly body: Readonly<Record<string, unknown>>;
}

function readFixture<T>(...path: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...path), 'utf8')) as T;
}

const POSTMAN = readFixture<PostmanFixture>('postman', 'prebook.request.json');
const PDF_LIMIT = readFixture<Record<string, unknown>>('pdf', 'prebook-request-limit.p19.json');

function bookingCodeOf(body: Readonly<Record<string, unknown>>): string {
  const code = body['BookingCode'];
  if (typeof code !== 'string') throw new Error('el fixture no trae BookingCode');
  return code;
}

function buildError(run: () => unknown): TboRequestBuildError {
  try {
    run();
  } catch (err) {
    if (err instanceof TboRequestBuildError) return err;
    throw err;
  }
  throw new Error('se esperaba TboRequestBuildError');
}

describe('forma del request (RF-15 CA-1)', () => {
  it('serializado es EXACTAMENTE el body de Postman, con el orden de claves del PDF', () => {
    const built = buildTboPrebookRequest({ bookingCode: bookingCodeOf(POSTMAN.body) });
    expect(JSON.stringify(built)).toBe(JSON.stringify(POSTMAN.body));
    // Postman coincide con nuestras reglas en todo: no hay discrepancias que anotar.
    expect(POSTMAN.discrepancies).toEqual([]);
    expect(POSTMAN.url.endsWith('/PreBook')).toBe(true);
  });

  it('reproduce el ejemplo 7.1.2 de p. 19 (el único del PDF con Limit)', () => {
    const built = buildTboPrebookRequest({ bookingCode: bookingCodeOf(PDF_LIMIT) });
    expect(built).toEqual(PDF_LIMIT);
  });

  it('PaymentMode es siempre el literal "Limit", explícito aunque sea el valor por defecto', () => {
    expect(TBO_PREBOOK_PAYMENT_MODE).toBe('Limit');
    expect(buildTboPrebookRequest({ bookingCode: 'X!TB!1!TB!y' }).PaymentMode).toBe('Limit');
  });

  it('el BookingCode es opaco: no se recorta ni se parsea', () => {
    const odd = ' 1160804!TB!10!TB!con espacios ';
    expect(buildTboPrebookRequest({ bookingCode: odd }).BookingCode).toBe(odd);
  });
});

describe('un BookingCode sin forma no sale (TboRequestBuildError SCHEMA)', () => {
  it.each<[string, unknown, string]>([
    ['vacío', '', 'BookingCode:too_small'],
    ['más de 255 caracteres', 'x'.repeat(256), 'BookingCode:too_big'],
    ['no es texto', 1160804, 'BookingCode:invalid_type'],
    ['ausente', undefined, 'BookingCode:invalid_type'],
  ])('%s', (_label, bookingCode, issue) => {
    const error = buildError(() =>
      buildTboPrebookRequest({ bookingCode } as unknown as TboPrebookInput),
    );
    expect(error.reason).toBe('SCHEMA');
    expect(error.path).toBe('/PreBook');
    expect(error.issues).toEqual([issue]);
    // Los issues son `ruta:código`: nunca el valor recibido.
    expect(error.message).not.toContain('xxxx');
  });
});

describe('D1 en el tipo y en el esquema de salida (RNF-04 capas 2 y 3)', () => {
  it('la entrada no admite modo de pago ni tarjeta', () => {
    const withMode: TboPrebookInput = {
      bookingCode: 'X',
      // @ts-expect-error -- el modo no lo elige el llamador: siempre "Limit".
      PaymentMode: 'Limit',
    };
    const withCard: TboPrebookInput = {
      bookingCode: 'X',
      // @ts-expect-error -- PreBook no lleva datos de tarjeta (p. 19-20).
      PaymentInfo: { CardNumber: '4111111111111111' },
    };
    expect(withMode.bookingCode).toBe('X');
    expect(withCard.bookingCode).toBe('X');
  });

  it('también desde una variable, donde no hay chequeo de propiedades de más: sólo `?: never` lo corta', () => {
    // Un literal fresco ya falla por la propiedad de más aunque el tipo no declare `never`; un objeto
    // que llega armado de otro lado, no. Es este caso el que prueba que la barrera está en el tipo.
    const fromElsewhere = { bookingCode: 'X', PaymentMode: 'NewCard' as const };
    // @ts-expect-error -- `PaymentMode?: never`: ni siquiera un objeto no literal lo trae.
    const withMode: TboPrebookInput = fromElsewhere;
    const cardFromElsewhere = { bookingCode: 'X', PaymentInfo: { CvvNumber: '123' } };
    // @ts-expect-error -- `PaymentInfo?: never`: la tarjeta no entra por ningún camino tipado.
    const withCard: TboPrebookInput = cardFromElsewhere;
    expect(buildTboPrebookRequest(withMode)).toEqual({ BookingCode: 'X', PaymentMode: 'Limit' });
    expect(buildTboPrebookRequest(withCard)).toEqual({ BookingCode: 'X', PaymentMode: 'Limit' });
  });

  it('una entrada con tarjeta colada en runtime no la arrastra al body', () => {
    const smuggled = {
      bookingCode: 'X!TB!1!TB!y',
      PaymentMode: 'NewCard',
      PaymentInfo: { CardNumber: '4111111111111111', CvvNumber: '123' },
    } as unknown as TboPrebookInput;
    const built = buildTboPrebookRequest(smuggled);
    expect(built).toEqual({ BookingCode: 'X!TB!1!TB!y', PaymentMode: 'Limit' });
    expect(JSON.stringify(built)).not.toMatch(/Card|Cvv|PaymentInfo|4111/);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['un modo con tarjeta', { BookingCode: 'X', PaymentMode: 'NewCard' }, 'PaymentMode'],
    ['el otro modo con tarjeta', { BookingCode: 'X', PaymentMode: 'SavedCard' }, 'PaymentMode'],
    [
      'una clave de más',
      { BookingCode: 'X', PaymentMode: 'Limit', PaymentInfo: { CvvNumber: '1' } },
      '',
    ],
  ])('el esquema .strict() rechaza %s', (_label, body, path) => {
    const parsed = TboPrebookRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path.join('.')).toBe(path);
  });
});

describe('los bytes del cable, por la puerta pública del cliente', () => {
  function wire(): { fetch: TboFetch; bodies: string[] } {
    const bodies: string[] = [];
    const fetch: TboFetch = (_url, init) => {
      bodies.push(typeof init.body === 'string' ? init.body : '');
      return Promise.resolve(
        new Response(JSON.stringify({ Status: { Code: 207, Description: 'x' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    return { fetch, bodies };
  }

  const config = parseTboConfig({ environment: 'test', username: 'u', password: 'p' });

  it('sale exactamente {BookingCode, PaymentMode: "Limit"} y nada con forma de tarjeta', async () => {
    const { fetch, bodies } = wire();
    const client = new TboHttpClient(config, { fetch, sleep: () => Promise.resolve() });
    const body = buildTboPrebookRequest({ bookingCode: bookingCodeOf(POSTMAN.body) });
    await expect(
      client.send('prebook', body, { requestSchema: TboPrebookRequestSchema }),
    ).rejects.toMatchObject({ kind: 'RATE_UNAVAILABLE' });
    expect(bodies).toEqual([JSON.stringify(POSTMAN.body)]);
  });

  it('si igual llegara un body con otro modo, el cliente lo corta antes del cable', async () => {
    const { fetch, bodies } = wire();
    const client = new TboHttpClient(config, { fetch });
    await expect(
      client.send('prebook', { BookingCode: 'X', PaymentMode: 'SavedCard' }),
    ).rejects.toMatchObject({ name: 'TboRequestBuildError', reason: 'PAYMENT_MODE' });
    await expect(
      client.send(
        'prebook',
        { BookingCode: 'X', PaymentMode: 'Limit', Extra: 1 },
        {
          requestSchema: TboPrebookRequestSchema,
        },
      ),
    ).rejects.toMatchObject({ name: 'TboRequestBuildError', reason: 'SCHEMA' });
    expect(bodies).toEqual([]);
  });
});
