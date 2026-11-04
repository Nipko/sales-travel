import type { ArgumentsHost } from '@nestjs/common';
import { LatamApiError, LatamBusinessError } from '@sales-travel/latam-ndc';
import { describe, expect, it, vi } from 'vitest';
import { LatamNdcExceptionFilter } from './latam-ndc-exception.filter.js';

function host() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const h = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { h, status, json };
}

describe('LatamNdcExceptionFilter', () => {
  it('un rechazo de negocio de LATAM es 422 con su motivo, no un 502 de «servidor caído»', () => {
    const { h, status, json } = host();
    new LatamNdcExceptionFilter().catch(
      new LatamBusinessError(
        [{ code: '403111003', desc: 'IATA Validation Failed' }],
        '/ndc/v192/offerPrice',
      ),
      h,
    );
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        message: 'LATAM rechazó la operación: 403111003: IATA Validation Failed',
      }),
    );
  });

  it('una falla de transporte sigue siendo 502', () => {
    const { h, status } = host();
    new LatamNdcExceptionFilter().catch(
      new LatamApiError(0, 'timeout', '/ndc/v192/airshopping'),
      h,
    );
    expect(status).toHaveBeenCalledWith(502);
  });
});
