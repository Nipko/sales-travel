import { describe, expect, it } from 'vitest';
import { REDACTED, redactMeta, redactText, redactValue, safeBodySummary } from './redaction';

describe('redactValue', () => {
  it('tapa secretos y PII por clave, sin importar el estilo del nombre', () => {
    const redacted = redactValue({
      Authorization: 'Basic VmpFNk5UQXdNREF4T2xVNVVFczZRVUU9OlVHRTFOWGN3Y21RaA==',
      access_token: 'ATK-1',
      accessToken: 'ATK-2',
      secret: 's3cr3t',
      password: 'Pa55w0rd!',
      traveler: { givenName: 'Ana', surname: 'Pérez', passportNumber: 'AB1234567' },
      inocuo: 'BOG-MDE',
    }) as Record<string, unknown>;

    expect(redacted['Authorization']).toBe(REDACTED);
    expect(redacted['access_token']).toBe(REDACTED);
    expect(redacted['accessToken']).toBe(REDACTED);
    expect(redacted['secret']).toBe(REDACTED);
    expect(redacted['password']).toBe(REDACTED);
    expect(redacted['inocuo']).toBe('BOG-MDE');

    const traveler = redacted['traveler'] as Record<string, unknown>;
    expect(traveler['givenName']).toBe(REDACTED);
    expect(traveler['passportNumber']).toBe(REDACTED);
  });

  it('corta arrays largos en vez de volcarlos', () => {
    const out = redactValue(Array.from({ length: 50 }, (_, i) => i)) as unknown[];
    expect(out).toHaveLength(21);
    expect(out[20]).toBe('«+30 más»');
  });

  /**
   * Los otros dos topes de `redactValue`, hermanos del corte de arrays y sin red hasta esta ronda:
   * borrando cualquiera de los dos la suite entera seguía verde (medido con dos mutantes).
   *
   * Van por `redactMeta`/`redactValue` y no por `postJson` porque son inalcanzables desde el cliente
   * HTTP: la meta que arma este paquete es plana y sólo lleva escalares. Quien puede meter una meta
   * profunda o un valor no serializable es el CONSUMIDOR —`apps/api`, que importa `redactMeta` de
   * `index.ts`—, así que ésa es su puerta real. El mismo argumento, con más detalle, está en §3 de
   * `redaction.path-key-rails.test.ts`.
   */
  it('corta en profundidad: el coste del resumen no lo elige quien manda el objeto', () => {
    const deep = { a: { b: { c: { d: { e: { f: { secreto: 'Pa55w0rd!' } } } } } } };
    expect(JSON.stringify(redactValue(deep))).toContain('«PROFUNDIDAD-MAX»');
    // Y lo que había debajo del corte no viaja: se sustituye el subárbol entero, no sus hojas.
    expect(JSON.stringify(redactValue(deep))).not.toContain('secreto');
  });

  it('un valor no serializable se sustituye por una marca, no se deja pasar', () => {
    // Las dos mitades del riesgo. Una función publica su CÓDIGO FUENTE en cuanto un transporte le
    // hace `String(...)`, y ahí puede ir una credencial literal; un `bigint` hace reventar al
    // `JSON.stringify` del transporte y se pierde la línea de log entera.
    const meta = redactMeta({ reintentar: () => 'Pa55w0rd!', contador: 10n });
    expect(meta['reintentar']).toBe('«NO-SERIALIZABLE»');
    expect(meta['contador']).toBe('«NO-SERIALIZABLE»');
    expect(() => JSON.stringify(meta)).not.toThrow();
  });
});

describe('redactText', () => {
  it('tapa el esquema Basic completo — es el password reversible de la oficina', () => {
    const out = redactText('Authorization: Basic VmpFNk5UQXdNREF4T2xVNVVFczZRVUU9OlVHRTE=');
    expect(out).not.toContain('VmpFNk5UQXdNREF4');
    expect(out).toContain(`Basic ${REDACTED}`);
  });

  it('tapa pares clave=valor de un form urlencoded', () => {
    expect(redactText('grant_type=client_credentials&password=Pa55w0rd!')).not.toContain(
      'Pa55w0rd!',
    );
  });
});

describe('safeBodySummary', () => {
  it('redacta por clave cuando el body es JSON', () => {
    const summary = safeBodySummary(JSON.stringify({ password: 'Pa55w0rd!', status: 'OK' }));
    expect(summary).not.toContain('Pa55w0rd!');
    expect(summary).toContain('OK');
  });

  it('cae a redacción textual y trunca cuando el body no es JSON', () => {
    const summary = safeBodySummary(`Bearer ${'x'.repeat(400)}`, 50);
    expect(summary).not.toContain('xxxxxxxx');
    expect(summary.length).toBeLessThanOrEqual(51);
  });

  it('no intenta parsear cuerpos enormes', () => {
    const huge = `{"a":"${'y'.repeat(30_000)}"}`;
    expect(safeBodySummary(huge, 40).length).toBeLessThanOrEqual(41);
  });
});

describe('redactMeta', () => {
  it('devuelve un objeto plano listo para el LoggerPort', () => {
    expect(redactMeta({ provider: 'sabre', password: 'x' })).toEqual({
      provider: 'sabre',
      password: REDACTED,
    });
  });
});
