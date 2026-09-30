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

describe('humanizeAgentCarsError — guía v2.0 (revisada el 2026-09-30)', () => {
  it('un host que no existe (el "fetch failed" del 2026-09-30) pide revisar la URL, no reintentar', () => {
    const msg = humanizeAgentCarsError(0, 'fetch failed (ENOTFOUND api.dev.agencars.com)');
    expect(msg).toContain('«api.dev.agencars.com»');
    expect(msg).toContain('https://api.dev.agentcars.com/v2/sites');
    expect(msg).not.toContain('Prueba de nuevo');
  });

  it('un timeout y una conexión rechazada sí se reintentan', () => {
    expect(humanizeAgentCarsError(0, 'el proveedor no respondió en 15000 ms')).toContain(
      'no respondió a tiempo',
    );
    expect(humanizeAgentCarsError(0, 'fetch failed (ECONNREFUSED)')).toContain('Prueba de nuevo');
  });

  it('401: el token vale sólo desde la IP registrada en AgentCars', () => {
    const msg = humanizeAgentCarsError(
      401,
      '{"name":"Unauthorized","message":"Your request was made with invalid credentials.","code":0,"status":401}',
      '/get-matrix',
    );
    expect(msg).toContain('IP');
    expect(msg).toContain('registre la IP pública del servidor');
  });

  it('403: la cuenta no tiene permiso para la operación', () => {
    expect(humanizeAgentCarsError(403, '{"error":"Not allowed"}', '/confirmation')).toContain(
      'no tiene permiso',
    );
  });

  it('422 (formato nuevo): los mensajes por parámetro de `data`', () => {
    const body = JSON.stringify({
      success: false,
      error: 'Error Loading data',
      message: 'Error Loading data',
      code: 13001,
      data: {
        dropOffLocation: ['Dropoff Location cannot be blank.'],
        pickUpDate: ['the date should be minimal today'],
      },
    });
    const msg = humanizeAgentCarsError(422, body, '/get-selection');
    expect(msg).toContain('no aceptó los datos de la búsqueda');
    expect(msg).toContain('Dropoff Location cannot be blank. the date should be minimal today');
  });

  it('validación por campo del formato actual (HTTP 200) dice lo mismo', () => {
    const msg = humanizeAgentCarsError(
      200,
      '{"error":{"pickUpDate":["the date should be minimal today"]}}',
      '/get-matrix',
    );
    expect(msg).toContain('no aceptó los datos de la búsqueda: the date should be minimal today');
  });

  it('el país de origen vacío en `data` sigue siendo un problema de configuración (POS)', () => {
    const body = JSON.stringify({
      success: false,
      error: 'Error Loading data',
      code: 13001,
      data: { source: ['Source Country cannot be blank.'] },
    });
    expect(humanizeAgentCarsError(422, body, '/get-matrix')).toContain('país de origen');
  });

  it('sin tarifas (code 13000 o el 412 de hoy) según la operación', () => {
    const nuevo = JSON.stringify({
      success: false,
      error: 'x',
      message: 'x',
      code: 13000,
      data: [],
    });
    expect(humanizeAgentCarsError(200, nuevo, '/get-selection')).toContain('ya no está disponible');
    expect(humanizeAgentCarsError(200, nuevo, '/get-rate-information')).toContain(
      'La tarifa ya no está disponible',
    );
    const hoy =
      '{"error":"We don\'t have rates avaliable for the selected location. Please select another location ciu"}';
    expect(humanizeAgentCarsError(412, hoy, '/get-selection')).toContain('ya no está disponible');
    expect(humanizeAgentCarsError(412, hoy, '/get-matrix')).toContain('no devolvió autos');
  });

  it('parámetro obligatorio faltante ("The requested page does not exist2.") es de la integración', () => {
    const body =
      '{"name":"Not Found","message":"The requested page does not exist2.","code":0,"status":404}';
    const msg = humanizeAgentCarsError(404, body, '/get-matrix');
    expect(msg).toContain('le falta un dato obligatorio');
    expect(msg).not.toContain('no devolvió autos');
  });

  it('confirmación: INCOMPLETE_REQUEST y una respuesta sin código', () => {
    expect(
      humanizeAgentCarsError(200, '{"error":"INCOMPLETE_REQUEST"}', '/confirmation'),
    ).toContain('datos incompletos');
    const msg = humanizeAgentCarsError(
      200,
      'respuesta sin código de confirmación',
      '/confirmation',
    );
    expect(msg).toContain('pudo quedar hecha');
    expect(msg).toContain('antes de intentar de nuevo');
  });
});
