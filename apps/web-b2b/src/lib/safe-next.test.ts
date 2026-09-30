import { describe, expect, it } from 'vitest';
import { SAFE_NEXT_FALLBACK, safeNextPath } from './safe-next';

/*
 * `?next=` lo escribe quien manda el link. Todo lo que no sea una pantalla del propio panel tiene
 * que caer al inicio: si no, el login se vuelve un redirect abierto justo después de que el usuario
 * puso su contraseña.
 */

describe('safeNextPath: rutas internas pasan', () => {
  it.each([
    ['/'],
    ['/hoteles'],
    ['/cotizaciones/abc-123'],
    ['/hoteles/checkout?rate=1&room=2'],
    ['/admin/usuarios#puestos'],
    ['/login-ayuda'],
    ['/apis-de-proveedores'],
  ])('%s', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it('se normaliza: los puntos no esconden una ruta excluida', () => {
    expect(safeNextPath('/hoteles/../cotizaciones')).toBe('/cotizaciones');
    expect(safeNextPath('/hoteles/../login')).toBe(SAFE_NEXT_FALLBACK);
  });

  it('del parámetro repetido se toma el primero', () => {
    expect(safeNextPath(['/hoteles', '//evil.example'])).toBe('/hoteles');
    expect(safeNextPath(['//evil.example', '/hoteles'])).toBe(SAFE_NEXT_FALLBACK);
  });
});

describe('safeNextPath: lo que sale del panel cae al inicio', () => {
  it.each([
    ['//evil.example', 'protocolo relativo'],
    ['///evil.example', 'triple barra'],
    ['/\\evil.example', 'barra invertida (el navegador la lee como /)'],
    ['/\\/evil.example', 'barra invertida y barra'],
    ['\\\\evil.example', 'dos barras invertidas'],
    ['https://evil.example', 'URL absoluta'],
    ['http:evil.example', 'esquema sin barras'],
    ['javascript:alert(1)', 'esquema javascript'],
    ['data:text/html,hola', 'esquema data'],
    ['evil.example', 'sin barra inicial'],
    ['hoteles', 'relativa'],
    ['/\t/evil.example', 'tab (el navegador lo descarta y queda //)'],
    ['/\n/evil.example', 'salto de línea'],
    ['/\r\n/evil.example', 'CRLF'],
    [' /hoteles', 'espacio adelante'],
  ])('%s (%s)', (raw) => {
    expect(safeNextPath(raw)).toBe(SAFE_NEXT_FALLBACK);
  });

  // El texto crudo empieza con una sola barra, pero al normalizar los puntos queda `//evil.example`:
  // lo que se valida tiene que ser lo que se devuelve.
  it.each([
    ['/.//evil.example', 'punto'],
    ['/%2e//evil.example', 'punto codificado'],
    ['/%2E//evil.example', 'punto codificado en mayúscula'],
    ['/x/..//evil.example', 'dos puntos'],
    ['/a/%2e%2e//evil.example', 'dos puntos codificados'],
    ['/..//evil.example', 'dos puntos en la raíz'],
    ['/././/evil.example?x=1#y', 'varios puntos, con query y hash'],
  ])('%s (%s: la forma normalizada sale del panel)', (raw) => {
    expect(safeNextPath(raw)).toBe(SAFE_NEXT_FALLBACK);
  });

  it('lo que devuelve siempre vuelve a pasar la validación (idempotente)', () => {
    for (const raw of ['/.//evil.example', '/hoteles/./../cotizaciones?x=1', '/a/b/../c#d']) {
      const once = safeNextPath(raw);
      expect(safeNextPath(once)).toBe(once);
      expect(once.startsWith('//')).toBe(false);
    }
  });
});

describe('safeNextPath: rutas internas que no son destino', () => {
  it.each([
    ['/login'],
    ['/login?motivo=inactividad'],
    ['/login/'],
    ['/LOGIN'],
    ['/api/session/end?motivo=cerrada'],
    ['/api'],
    ['/API/auth/logout'],
  ])('%s', (raw) => {
    expect(safeNextPath(raw)).toBe(SAFE_NEXT_FALLBACK);
  });
});

describe('safeNextPath: entradas que no son una ruta', () => {
  it.each([[undefined], [null], [''], [42], [{}], [[]], [[42]]])('%j', (raw) => {
    expect(safeNextPath(raw)).toBe(SAFE_NEXT_FALLBACK);
  });

  it('una ruta desmesurada tampoco', () => {
    expect(safeNextPath(`/${'a'.repeat(3000)}`)).toBe(SAFE_NEXT_FALLBACK);
  });
});
