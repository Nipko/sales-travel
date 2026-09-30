/**
 * Un fetch del navegador recibió 401: se le pide a la guardia de sesión que le pregunte YA al
 * servidor, en vez de esperar su próximo ping (hasta 60 s).
 *
 * Sin esto, cuando un admin liberaba el puesto o el usuario entraba desde otro equipo, la pantalla
 * que hacía el fetch mostraba un "Tu sesión venció" genérico y el usuario seguía ahí; el aviso
 * correcto ("Un administrador liberó tu puesto") llegaba recién con el ping. La guardia decide con
 * su propia lógica (motivo, confirmación de `cerrada`): acá no se interpreta la respuesta, y si la
 * sesión sigue viva el pedido cuesta un ping y nada más.
 */

export const SESSION_CHECK_EVENT = 'st:session-check';

export function requestSessionCheck(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
}
