/**
 * Tarifas y reservas del entorno de pruebas del proveedor, del lado del panel.
 *
 * Una cuenta de pruebas cotiza y reserva con la misma forma que una real: precio, vuelos y
 * localizador. Lo único que la distingue es la marca que pone el API desde la cuenta que resolvió
 * (`offer.provider.environment` en las tarifas, `testContent` en las reservas). El panel no la
 * deduce de nada más —ni del nombre del proveedor ni de la forma de la oferta—: sólo la lee.
 */

/** Lo que se ve en la etiqueta. */
export const TEST_CONTENT_LABEL = 'Prueba';

/** Lo que explica la etiqueta de una tarifa (tooltip y lector de pantalla). */
export const TEST_FARE_DESCRIPTION =
  'Tarifa del entorno de pruebas del proveedor: no emite tiquetes reales ni factura.';

/** Un vuelo que trae tarifas reales y de pruebas a la vez: la etiqueta de la fila lo dice. */
export const SOME_TEST_FARES_DESCRIPTION =
  'Algunas tarifas de este vuelo vienen del entorno de pruebas del proveedor: no emiten tiquetes reales ni facturan.';

/** El aviso sobre el formulario de pasajeros cuando la tarifa elegida es de pruebas. */
export const TEST_BOOKING_NOTICE =
  'Estás reservando en el entorno de pruebas del proveedor. La reserva no genera un tiquete real.';

/** La etiqueta de una reserva en su detalle. */
export const TEST_ORDER_LABEL = 'Reserva de prueba';

/** Lo que explica la etiqueta de una reserva. */
export const TEST_ORDER_DESCRIPTION =
  'Reserva hecha en el entorno de pruebas del proveedor: no es un tiquete válido para viajar.';

/** Junto al botón que reenvía la confirmación de una reserva de prueba. */
export const TEST_ORDER_EMAIL_NOTICE =
  'El correo sale con «[PRUEBA]» en el asunto y avisa que no es un tiquete válido para viajar.';

/** Cualquier oferta: la de búsqueda, la guardada en una cotización o la revalidada. */
type FareLike = { readonly provider?: unknown } | null | undefined;

/** ¿La tarifa viene de una cuenta de pruebas? Sólo `test` explícito: sin marca es real. */
export function isTestFare(offer: FareLike): boolean {
  const provider = offer?.provider;
  return (
    typeof provider === 'object' &&
    provider !== null &&
    'environment' in provider &&
    provider.environment === 'test'
  );
}

/** ¿La reserva se hizo con una cuenta de pruebas? Lo dice el API en `testContent`. */
export function isTestOrder(order: { readonly testContent?: unknown } | null | undefined): boolean {
  return order?.testContent === true;
}

/** Cuántas de las tarifas de un vuelo son de pruebas: ninguna, algunas o todas. */
export type TestFareShare = 'none' | 'some' | 'all';

export function testFareShare(offers: readonly FareLike[]): TestFareShare {
  const tests = offers.filter(isTestFare).length;
  if (tests === 0) return 'none';
  return tests === offers.length ? 'all' : 'some';
}
