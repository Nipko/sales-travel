import { describe, expect, it } from 'vitest';
import { deriveSabreSecret } from './auth/token.service';
import { FREE_TEXT, REDACTED, redactDocument, redactValue } from './redaction';

/**
 * `redactDocument` es la redacción de una EVIDENCIA: la request o la respuesta entera que el arnés de
 * certificación guarda y que después se versiona como fixture. Tiene que tapar lo mismo que
 * `redactValue` —es la misma política— sin los recortes de un log, que dejaban la mitad de una
 * respuesta de BFM fuera del fixture.
 */
describe('redactDocument', () => {
  it('tapa por clave igual que redactValue, con la misma marca para cada clase', () => {
    const documento = {
      access_token: 'T1-ATK',
      travelers: [{ givenName: 'PASAJERO UNO', surname: 'TEST', birthDate: '1980-01-01' }],
      contactInfo: { emails: ['cert-run@example.com'], phones: ['5710000000'] },
      warnings: [{ code: 'WRN1', description: 'free text from the airline' }],
      ruta: 'BOG-LIM',
    };
    const out = redactDocument(documento);
    expect(out).toEqual(redactValue(documento));
    expect(JSON.stringify(out)).toContain(FREE_TEXT);
    expect(JSON.stringify(out)).not.toMatch(/PASAJERO|cert-run@|5710000000|T1-ATK|airline/);
  });

  it('no recorta: un dato sensible a 12 niveles sigue tapado y lo inocuo sigue entero', () => {
    let hoja: Record<string, unknown> = { passportNumber: 'AB1234567', fareBasisCode: 'YLOW' };
    for (let nivel = 0; nivel < 12; nivel++) hoja = { [`n${String(nivel)}`]: hoja };

    const texto = JSON.stringify(redactDocument(hoja));
    expect(texto).not.toContain('AB1234567');
    expect(texto).toContain('YLOW');
    expect(texto).not.toContain('PROFUNDIDAD-MAX');
    // El control: el resumen de log corta antes de llegar a la hoja.
    expect(JSON.stringify(redactValue(hoja))).not.toContain('YLOW');
  });

  it('no recorta arrays: las 50 ofertas de un shop llegan las 50', () => {
    const ofertas = Array.from({ length: 50 }, (_, i) => ({ id: i, surname: 'TEST' }));
    const out = redactDocument(ofertas) as { id: number; surname: string }[];
    expect(out).toHaveLength(50);
    expect(out[49]).toEqual({ id: 49, surname: REDACTED });
  });

  it('tapa el secret de Sabre y un PAN aunque vengan sueltos o como número', () => {
    const secret = deriveSabreSecret({
      epr: '500001',
      homePcc: 'ZZZZ',
      password: 'Pa55w0rd!',
      domain: 'AA',
    });
    const out = JSON.stringify(
      redactDocument({ eco: `rechazado ${secret}`, importe: 4111111111111111, total: 125000 }),
    );
    expect(out).not.toContain(secret);
    expect(out).not.toContain('4111111111111111');
    // Un importe normal no pasa Luhn ni tiene la longitud de un PAN: sigue siendo un número.
    expect(out).toContain('"total":125000');
  });

  it('la ruta pierde la query pero conserva el camino', () => {
    const out = redactDocument({ path: '/v1/trip/orders/getBooking?access_token=abc123' }) as {
      path: string;
    };
    expect(out.path.startsWith('/v1/trip/orders/getBooking')).toBe(true);
    expect(out.path).not.toContain('abc123');
  });

  it('un documento circular o absurdo no agota la pila', () => {
    const ciclo: Record<string, unknown> = { a: 1 };
    ciclo['yo'] = ciclo;
    expect(JSON.stringify(redactDocument(ciclo))).toContain('«PROFUNDIDAD-MAX»');
    expect(redactDocument({ f: () => 'Pa55w0rd!' })).toEqual({ f: '«NO-SERIALIZABLE»' });
  });
});
