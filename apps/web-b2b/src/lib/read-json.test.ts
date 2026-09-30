import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeNonJson, readJson } from './read-json';
import { SESSION_CHECK_EVENT } from './session-check';

function respuesta(body: string, status = 200, type = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

describe('readJson: una respuesta que no es JSON no puede reventar la pantalla', () => {
  it('el JSON bueno sale como siempre', async () => {
    const out = await readJson<{ a: number }>(respuesta('{"a":1}'));
    expect(out).toEqual({ ok: true, data: { a: 1 } });
  });

  it('la página HTML de un proxy no lanza: se convierte en un mensaje', async () => {
    // El caso real. `await res.json()` sobre esto lanzaba
    // «Unexpected token '<', "<!DOCTYPE "... is not valid JSON», y ESE era el texto que leía el
    // vendedor mientras intentaba reservar: un error del parser de JavaScript.
    const out = await readJson(respuesta('<!DOCTYPE html><html>...', 502, 'text/html'));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).not.toContain('JSON');
    expect(out.message).not.toContain('token');
    expect(out.status).toBe(502);
  });

  it('un cuerpo vacío tampoco lanza', async () => {
    const out = await readJson(respuesta('', 500));
    expect(out.ok).toBe(false);
  });
});

describe('readJson: un 401 le pide a la guardia de sesión que confirme ya', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('401 dispara el aviso; otro estado, no', async () => {
    const win = new EventTarget();
    const checks = vi.fn();
    win.addEventListener(SESSION_CHECK_EVENT, checks);
    vi.stubGlobal('window', win);

    await readJson(respuesta('{"reason":"SESSION_RELEASED"}', 401));
    expect(checks).toHaveBeenCalledTimes(1);

    await readJson(respuesta('{"message":"x"}', 403));
    await readJson(respuesta('{"a":1}'));
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('sin window (en el servidor) no hace nada', async () => {
    const out = await readJson(respuesta('{}', 401));
    expect(out).toEqual({ ok: true, data: {} });
  });
});

describe('describeNonJson: cada familia de estado pide una acción distinta', () => {
  it('un corte por tiempo AVISA de no repetir a ciegas', () => {
    // Es el peor consejo posible en una reserva: el PNR pudo crearse igual y repetir crea dos.
    for (const status of [504, 524, 408]) {
      const m = describeNonJson(status, '<!DOCTYPE html>');
      expect(m).toContain('Mis Reservas');
      expect(m.toLowerCase()).toContain('no la repitas');
    }
  });

  it('un servidor caído invita a reintentar, que ahí sí corresponde', () => {
    for (const status of [502, 503]) {
      expect(describeNonJson(status, '<!DOCTYPE html>')).toContain('probá de nuevo');
    }
  });

  it('una sesión inválida manda a iniciar sesión, no a reintentar', () => {
    for (const status of [401, 403]) {
      expect(describeNonJson(status, '')).toContain('iniciar sesión');
    }
  });

  it('el resto de 5xx nombra el estado, para poder buscarlo en el log', () => {
    expect(describeNonJson(500, '')).toContain('500');
  });

  it('ningún mensaje habla de JSON, tokens ni DOCTYPE', () => {
    // Toda la razón de ser de este módulo: el vocabulario del parser no es el del vendedor.
    for (const status of [400, 401, 404, 500, 502, 504, 524]) {
      const m = describeNonJson(status, '<!DOCTYPE html><html>');
      expect(m).not.toMatch(/JSON|token|DOCTYPE|SyntaxError/i);
    }
  });
});
