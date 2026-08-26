import { type ArgumentsHost, Logger } from '@nestjs/common';
import { SabreApiError, SabreConfigError, SabreShopMappingError } from '@sales-travel/sabre';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SabreExceptionFilter } from './sabre-exception.filter.js';
import { SabreOperationNotSupportedError, humanizeSabreError } from './sabre-errors.js';

describe('humanizeSabreError', () => {
  it('red caída / timeout → "no pudimos conectar"', () => {
    expect(humanizeSabreError(new SabreApiError(0, 'fetch failed', '/v5/offers/shop'))).toContain(
      'conectar',
    );
  });

  it('5xx → problema interno de Sabre', () => {
    expect(humanizeSabreError(new SabreApiError(503, 'unavailable', '/v5/offers/shop'))).toContain(
      'problema interno',
    );
  });

  it('403 → alta comercial del PCC pendiente, no caída', () => {
    const mensaje = humanizeSabreError(new SabreApiError(403, 'forbidden', '/v5/offers/shop'));
    expect(mensaje).toContain('PCC');
    expect(mensaje).toContain('alta comercial');
  });

  it('config inválida → sí muestra el detalle, que son rutas y códigos de Zod', () => {
    const mensaje = humanizeSabreError(new SabreConfigError('config de Sabre inválida (host:url)'));
    expect(mensaje).toContain('host:url');
    expect(mensaje).toContain('Mi Red');
  });

  it('respuesta fuera de contrato → mensaje propio, sin volcar las rutas al vendedor', () => {
    const mensaje = humanizeSabreError(new SabreShopMappingError(['itineraryGroups.0:invalid']));
    expect(mensaje).toContain('no pudimos interpretar');
    expect(mensaje).not.toContain('itineraryGroups');
  });

  it('un error cualquiera no filtra su propio mensaje', () => {
    expect(humanizeSabreError(new Error('ECONNRESET 10.0.0.4:443 token=abc'))).not.toContain(
      'token=abc',
    );
  });

  it('un valor que ni siquiera es Error tampoco revienta', () => {
    expect(humanizeSabreError('cualquier cosa')).toContain('Sabre');
  });

  it('nunca hace eco del cuerpo de Sabre, ni con PII dentro', () => {
    // El cuerpo puede traer el eco de la request; en `/v2/auth/token` eso incluye un `secret`
    // que es base64 REVERSIBLE del password de la oficina.
    const err = new SabreApiError(
      400,
      JSON.stringify({ error_description: 'Wrong clientID V1:EPR123:A1B2:AA:c2VjcmV0bw==' }),
      '/v2/auth/token',
    );
    const mensaje = humanizeSabreError(err);
    expect(mensaje).not.toContain('EPR123');
    expect(mensaje).not.toContain('c2VjcmV0bw==');
  });
});

describe('SabreOperationNotSupportedError', () => {
  it('es 501 y nombra la operación que todavía no existe', () => {
    const err = new SabreOperationNotSupportedError('crear la reserva');
    expect(err.getStatus()).toBe(501);
    expect(err.message).toContain('crear la reserva');
  });
});

describe('SabreExceptionFilter', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Doble mínimo del `host` de Nest: sólo interesa el JSON que sale y con qué status. */
  function hostFalso() {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  it('traduce un error del proveedor a 502 con mensaje en español', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host, status, json } = hostFalso();

    new SabreExceptionFilter().catch(
      new SabreApiError(503, 'unavailable', '/v5/offers/shop'),
      host,
    );

    expect(status).toHaveBeenCalledWith(502);
    const cuerpo = json.mock.calls[0]?.[0] as {
      statusCode: number;
      error: string;
      message: string;
    };
    expect(cuerpo.statusCode).toBe(502);
    expect(cuerpo.error).toBe('Bad Gateway');
    expect(cuerpo.message).toContain('problema interno');
  });

  it('también atrapa la config inválida, que si no saldría como 500 genérico', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host, status, json } = hostFalso();

    new SabreExceptionFilter().catch(
      new SabreConfigError('config de Sabre inválida (epr:too_small)'),
      host,
    );

    const cuerpo = json.mock.calls[0]?.[0] as { message: string };
    expect(status).toHaveBeenCalledWith(502);
    expect(cuerpo.message).toContain('Mi Red');
  });

  it('lo que se loguea de un error de Sabre viene ya redactado por el ACL', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host } = hostFalso();

    new SabreExceptionFilter().catch(
      new SabreApiError(400, 'Wrong clientID V1:EPR123:A1B2:AA', '/v2/auth/token'),
      host,
    );

    const logueado = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(logueado).not.toContain('EPR123');
    expect(logueado).toContain('sabre');
  });

  it('de un error que no es del proveedor sólo se loguea el NOMBRE de la clase', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host } = hostFalso();

    new SabreExceptionFilter().catch(new SabreShopMappingError(['flights.0.pax:invalid']), host);

    const logueado = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(logueado).toContain('SabreShopMappingError');
    expect(logueado).not.toContain('flights.0.pax');
  });
});
