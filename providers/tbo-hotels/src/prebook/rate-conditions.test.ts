import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TBO_RATE_SIGNALS,
  classifyTboRateCondition,
  detectTboRateSignals,
  readTboRateConditions,
  tboRateConditionToText,
  tboRateConditionsHash,
} from './rate-conditions';

/**
 * `RateConditions` como texto plano con señales críticas (docs/tbo/03 §2.4 y §2.11; 08 RF-16 y
 * RF-17), contra los ejemplos de PreBook de p. 23-32 y el texto de BookingDetail de p. 51.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__', 'pdf');

function rateConditionsOf(name: string): string[] {
  const envelope = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as {
    HotelResult: { RateConditions: string[] }[];
  };
  const conditions = envelope.HotelResult[0]?.RateConditions;
  if (conditions === undefined) throw new Error(`${name} sin RateConditions`);
  return conditions;
}

const MULTI_ROOM = rateConditionsOf('prebook-limit-multi-room.p28.json');
const SINGLE_ROOM = rateConditionsOf('prebook-newcard-single-room.p23.json');

/** Lo que haría un navegador con el texto si alguien lo pintara como HTML: ninguna etiqueta. */
const ACTIVE_TAG = /<\s*[a-z!/]/i;

describe('saneo: el HTML del proveedor nunca llega como marcado (RF-16)', () => {
  it('CA-1: `&amp;lt;script&amp;gt;` termina como el TEXTO `&lt;script&gt;`, nunca como etiqueta', () => {
    const text = tboRateConditionToText(
      'Note: &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;',
    );
    expect(text).toBe('Note: &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(text).not.toMatch(ACTIVE_TAG);
  });

  it('las entidades se decodifican UNA sola vez: el HTML escapado de TBO se lee como estructura', () => {
    expect(
      tboRateConditionToText(
        'Fees: &lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;li&gt;Two&lt;/li&gt;&lt;/ul&gt;',
      ),
    ).toBe('Fees:\n\n• One\n• Two');
  });

  it('script y style se van con su contenido; el resto de las etiquetas sin él y sin atributos', () => {
    expect(tboRateConditionToText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBeNull();
    expect(tboRateConditionToText('A&lt;style&gt;p{}&lt;/style&gt;B')).toBe('AB');
    expect(tboRateConditionToText('&lt;b onclick=x&gt;Hi&lt;/b&gt; &amp; more')).toBe('Hi & more');
    expect(tboRateConditionToText('&lt;a href="javascript:alert(1)"&gt;terms&lt;/a&gt;')).toBe(
      'terms',
    );
  });

  it('el texto con < y & sueltos queda como texto, sin inventar etiquetas ni entidades', () => {
    expect(tboRateConditionToText('a < b & c > d')).toBe('a < b & c > d');
  });

  it('las URLs quedan como texto (p. 26, 30): no hay enlaces que seguir', () => {
    const text = tboRateConditionToText(MULTI_ROOM[3] ?? '');
    expect(text).toBe(
      'Please refer to the following Terms of Use - http://mytravelagent.online/termsofuse.pdf',
    );
  });

  it('espacios colapsados, bordes recortados y NFC; no se parte por comas', () => {
    expect(tboRateConditionToText(' CheckIn Time-End: 3:00 AM')).toBe('CheckIn Time-End: 3:00 AM');
    expect(tboRateConditionToText('a\u00a0\u00a0b&nbsp;c')).toBe('a b c');
    // "e" + acento combinante (U+0301) → "é" precompuesto (U+00E9).
    expect(tboRateConditionToText('Caf&#101;&#769;')).toBe('Café');
    expect(tboRateConditionToText('Cards Accepted: Visa,Cash,Mastercard')).toBe(
      'Cards Accepted: Visa,Cash,Mastercard',
    );
  });

  it('ningún ítem de los dos ejemplos del PDF deja marcado activo, y el original se conserva', () => {
    for (const raw of [MULTI_ROOM, SINGLE_ROOM]) {
      const reading = readTboRateConditions(raw);
      expect(reading.conditions.map((condition) => condition.raw)).toEqual(raw);
      for (const condition of reading.conditions) {
        expect(condition.text).not.toMatch(ACTIVE_TAG);
        expect(condition.text).not.toMatch(/&(lt|gt|amp);/);
      }
    }
  });

  it('"Mandatory Fees" de p. 31 sale como párrafos y viñetas legibles', () => {
    const text = tboRateConditionToText(MULTI_ROOM[9] ?? '');
    expect(text).toBe(
      [
        'Mandatory Fees:',
        '',
        "You'll be asked to pay the following charges at the property:",
        '',
        '• A tax is imposed by the city: AED 20.00 per accommodation, per night',
        '',
        'We have included all charges provided to us by the property.',
      ].join('\n'),
    );
  });

  it('el ítem mixto de p. 31-32 (lista HTML seguida de lista por comas) conserva todo el texto', () => {
    const text = tboRateConditionToText(MULTI_ROOM[12] ?? '') ?? '';
    expect(text.startsWith('• Reservations are required for spa treatments.')).toBe(true);
    expect(text).toContain('60°C/140°F');
    expect(text).toContain(',Service animals not allowed,Pets not allowed,');
    expect(text.endsWith('Commonly-touched surfaces are cleaned with disinfectant')).toBe(true);
  });

  it('las comillas tipográficas de "Tourism Dirham" (p. 30) llegan intactas', () => {
    expect(tboRateConditionToText(MULTI_ROOM[0] ?? '')).toContain('“Tourism Dirham”');
  });
});

describe('categoría por prefijo: ayuda visual, el texto completo se conserva', () => {
  it('los ítems de 7.2.2 (p. 30-32)', () => {
    const reading = readTboRateConditions(MULTI_ROOM);
    expect(reading.conditions.map((condition) => condition.category)).toEqual([
      'other',
      'other',
      'other',
      'other',
      'checkIn',
      'checkIn',
      'checkOut',
      'checkIn',
      'specialInstructions',
      'mandatoryFees',
      'optionalFees',
      'cardsAccepted',
      'other',
    ]);
  });

  it('"Minimum CheckIn Age" gana a "CheckIn" (p. 26)', () => {
    expect(classifyTboRateCondition('Minimum CheckIn Age : 15')).toBe('minCheckInAge');
    expect(classifyTboRateCondition('Check-in hour 14:00')).toBe('checkIn');
    expect(classifyTboRateCondition('check out time: 11:00')).toBe('checkOut');
    expect(classifyTboRateCondition('Pets not allowed')).toBe('other');
  });
});

describe('señales críticas como códigos cerrados (RF-16, RF-17)', () => {
  it('RF-17: los dos ejemplos de PreBook (p. 25 y p. 30) llevan la marca de solo paquete', () => {
    expect(readTboRateConditions(SINGLE_ROOM).signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
    expect(readTboRateConditions(MULTI_ROOM).signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
  });

  it.each<[string, readonly string[]]>([
    [
      'Please note that this a special rate which should be sold only with an airline ticket as part of a package.',
      ['PACKAGE_WITH_FLIGHT_ONLY'],
    ],
    ['SOLD ONLY WITH A FLIGHT TICKET', ['PACKAGE_WITH_FLIGHT_ONLY']],
    ['Rate to be sold only with an air ticket.', ['PACKAGE_WITH_FLIGHT_ONLY']],
    ['Valid only as part of a package.', ['PACKAGE_WITH_FLIGHT_ONLY']],
    ['Includes a spa package', []],
    ['Airline ticket not included', []],
    [
      // p. 51, con "year" y "NOT" pegados como en el PDF.
      'Check-in hour 14:00 - . No Name change allowed any time of the yearNOT VALID FOR Germany MarketDubai Mall shuttle bus',
      ['NO_NAME_CHANGE', 'MARKET_RESTRICTION'],
    ],
    ['Name changes are not permitted.', ['NO_NAME_CHANGE']],
    ['Rate valid only for the GCC market.', ['MARKET_RESTRICTION']],
    ['Not valid for residents', []],
  ])('%j → %j', (text, expected) => {
    expect(detectTboRateSignals(text)).toEqual(expected);
  });

  it('las señales salen sin repetir y en el orden del vocabulario', () => {
    const reading = readTboRateConditions([
      'NOT VALID FOR Germany Market',
      'Should be sold only with an airline ticket.',
      'No name change allowed.',
      'Should be sold only with an airline ticket.',
    ]);
    expect(reading.signals).toEqual([...TBO_RATE_SIGNALS]);
  });

  it('un texto con "package" que no dispara la regla se cuenta como posible falso negativo', () => {
    const reading = readTboRateConditions([
      'Honeymoon package available on request.',
      'Please note that this a special rate which should be sold only with an airline ticket as part of a package.',
    ]);
    expect(reading.signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
    expect(reading.packageMentionsWithoutSignal).toBe(1);
  });

  it('la señal se busca sobre el texto saneado: también dentro de una lista HTML escapada', () => {
    const reading = readTboRateConditions([
      '&lt;ul&gt;&lt;li&gt;This rate should be sold only with an&lt;br&gt;airline ticket&lt;/li&gt;&lt;/ul&gt;',
    ]);
    expect(reading.signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
  });
});

describe('lista, vacíos y huella', () => {
  it('ausente o null es [] (03 §2.4 paso 1)', () => {
    for (const raw of [undefined, null, []]) {
      const reading = readTboRateConditions(raw);
      expect(reading.conditions).toEqual([]);
      expect(reading.signals).toEqual([]);
    }
  });

  it('un ítem que no deja texto no se muestra y se cuenta', () => {
    const reading = readTboRateConditions(['  ', '&lt;p&gt;&lt;/p&gt;', 'Pets not allowed']);
    expect(reading.conditions.map((condition) => condition.text)).toEqual(['Pets not allowed']);
    expect(reading.emptyItems).toBe(2);
  });

  it('la huella cambia con el texto saneado y no con el formato del original', () => {
    const base = readTboRateConditions(['CheckOut Time: 12:00 PM']);
    const spaced = readTboRateConditions(['  CheckOut Time:   12:00 PM ']);
    const changed = readTboRateConditions(['CheckOut Time: 11:00 AM']);
    expect(base.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(spaced.textHash).toBe(base.textHash);
    expect(changed.textHash).not.toBe(base.textHash);
    expect(tboRateConditionsHash(base.conditions)).toBe(base.textHash);
  });

  it('la huella depende del orden: dos normas intercambiadas no son el mismo snapshot', () => {
    const ab = readTboRateConditions(['A', 'B']);
    const ba = readTboRateConditions(['B', 'A']);
    expect(ab.textHash).not.toBe(ba.textHash);
  });
});
