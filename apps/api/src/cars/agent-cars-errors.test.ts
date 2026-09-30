import { describe, expect, it } from 'vitest';
import {
  humanizeAgentCarsError,
  isMissingRoute,
  summarizeAgentCarsBody,
} from './agent-cars-errors.js';

/**
 * La página que devuelve AgentCars (Yii) para una ruta que no existe: es lo que llegó a producción
 * el 2026-09-30 con la URL base apuntando al host sin `/v2/sites`. Recortada, sin los estilos.
 */
const YII_404_PAGE = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8" />
    <title>Not Found (#404)</title>

    <style>
        body {
            font: normal 9pt "Verdana";
            color: #000;
            background: #fff;
        }
    </style>
</head>

<body>
    <h1>Not Found (#404)</h1>
    <h2>Page not found.</h2>
    <p>
        The above error occurred while the Web server was processing your request.
    </p>
</body>
</html>`;

describe('humanizeAgentCarsError', () => {
  it('source country blank (el caso real 412) → mensaje de configuración de POS', () => {
    const body =
      '{"error":"Error Loading data: {\\"source\\":[\\"Source Country cannot be blank.\\"]}"}';
    const msg = humanizeAgentCarsError(412, body, '/get-matrix');
    expect(msg).toContain('país de origen');
    expect(msg).toContain('AGENT_CARS_SOURCE');
  });

  it('error de red (status 0) → no pudimos conectar', () => {
    expect(humanizeAgentCarsError(0, 'fetch failed')).toContain('conectar');
  });

  it('5xx → problema interno del proveedor', () => {
    expect(humanizeAgentCarsError(503, 'Service Unavailable')).toContain('problema interno');
  });

  it('401/token → credenciales', () => {
    expect(humanizeAgentCarsError(401, '{"error":"unauthorized"}')).toContain('credenciales');
    expect(humanizeAgentCarsError(412, '{"error":"Access token invalid"}')).toContain(
      'credenciales',
    );
    const yii401 =
      '{"name":"Unauthorized","message":"Your request was made with invalid credentials.","code":0,"status":401}';
    expect(humanizeAgentCarsError(401, yii401, '/get-matrix')).toContain('Access Token');
  });

  describe('404 de ruta inexistente (la URL base no es …/v2/sites)', () => {
    it('la página HTML de Yii en la búsqueda es un error de configuración, no una sesión vencida', () => {
      const msg = humanizeAgentCarsError(404, YII_404_PAGE, '/get-matrix');
      expect(msg).toContain('URL base');
      expect(msg).toContain('/v2/sites');
      expect(msg).not.toContain('sesión');
    });

    it('igual en cualquier operación: la ruta no existe en ninguna', () => {
      for (const path of ['/rates', '/get-selection', '/confirmation', '/my-reservation']) {
        expect(humanizeAgentCarsError(404, YII_404_PAGE, path)).toContain('URL base');
      }
    });

    it('un 404 JSON del propio API no se confunde con una ruta inexistente', () => {
      const body = '{"name":"Not Found","message":"Reservation not found","status":404}';
      expect(isMissingRoute(404, body)).toBe(false);
      expect(isMissingRoute(404, YII_404_PAGE)).toBe(true);
      expect(isMissingRoute(200, YII_404_PAGE)).toBe(false);
    });
  });

  it('uniqid/sesión expirada → volver a buscar', () => {
    expect(humanizeAgentCarsError(412, '{"error":"uniqid expired"}')).toContain('expiró');
  });

  it('"not found" en la confirmación es la sesión vencida; en la búsqueda, no', () => {
    const body = '{"error":"Not found"}';
    expect(humanizeAgentCarsError(404, body, '/confirmation')).toContain('expiró');
    expect(humanizeAgentCarsError(404, body, '/get-rate-information')).toContain('expiró');
    expect(humanizeAgentCarsError(404, body, '/get-matrix')).not.toContain('expiró');
  });

  it('"not found" al consultar o cancelar una reserva → revisar apellido y código', () => {
    const body = '{"name":"Not Found","message":"Reservation not found","status":404}';
    for (const path of ['/my-reservation', '/cancel', '/release-reservation']) {
      const msg = humanizeAgentCarsError(404, body, path);
      expect(msg).toContain('No encontramos esa reserva');
      expect(msg).toContain('apellido');
    }
  });

  it('búsqueda vacía o sin resultados → sin autos para esos datos, no una tarifa vencida', () => {
    const empty = humanizeAgentCarsError(400, 'Empty response on CarService', '/get-matrix');
    expect(empty).toContain('no devolvió autos');
    expect(empty).not.toContain('15 min');
    expect(humanizeAgentCarsError(404, '{"message":"No cars found"}', '/get-matrix')).toContain(
      'no devolvió autos',
    );
  });

  it('selección de un auto que ya no está → volver a buscar', () => {
    expect(humanizeAgentCarsError(400, 'Empty response on CarService', '/get-selection')).toContain(
      'ya no está disponible',
    );
  });

  it('tarifa/disponibilidad → ya no disponible', () => {
    expect(humanizeAgentCarsError(412, '{"error":"rate not available"}')).toContain('disponible');
  });

  it('"Empty response on CarService" al confirmar → tarifa pudo expirar, vuelve a buscar', () => {
    const msg = humanizeAgentCarsError(400, 'Empty response on CarService', '/confirmation');
    expect(msg).toContain('no devolvió disponibilidad');
    expect(msg).toContain('vuelve a buscar');
  });

  it('respuesta vacía del proveedor → mismo mensaje accionable', () => {
    expect(humanizeAgentCarsError(200, 'respuesta vacía del proveedor')).toContain(
      'vuelve a buscar',
    );
  });

  it('detalle corto desconocido se muestra al agente', () => {
    expect(humanizeAgentCarsError(400, '{"error":"Invalid pickUpDate format"}')).toContain(
      'Invalid pickUpDate format',
    );
  });

  it('los mensajes van en "tú", no en voseo', () => {
    const samples = [
      humanizeAgentCarsError(0, ''),
      humanizeAgentCarsError(503, ''),
      humanizeAgentCarsError(412, '{"error":"Source Country cannot be blank."}'),
      humanizeAgentCarsError(401, ''),
      humanizeAgentCarsError(412, '{"error":"uniqid expired"}'),
      humanizeAgentCarsError(400, 'Empty response on CarService'),
      humanizeAgentCarsError(412, '{"error":"rate not available"}'),
      humanizeAgentCarsError(400, 'x'.repeat(200)),
    ];
    for (const msg of samples) {
      expect(msg).not.toMatch(/Probá|Cargá|Verificá|volvé|Volvé|seleccioná|Revisá|intentá/);
    }
  });
});

describe('summarizeAgentCarsBody', () => {
  it('de una página HTML deja el título y el motivo, no los estilos', () => {
    expect(summarizeAgentCarsBody(YII_404_PAGE)).toBe('HTML «Not Found (#404)» Page not found.');
  });

  it('el JSON pasa en una sola línea y recortado', () => {
    expect(summarizeAgentCarsBody('{"error":\n  "x"}')).toBe('{"error": "x"}');
    expect(summarizeAgentCarsBody('a'.repeat(400))).toHaveLength(250);
  });
});
