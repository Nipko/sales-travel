import { HttpStatus, NotImplementedException } from '@nestjs/common';
import {
  SabreApiError,
  SabreCancelBookingBuildError,
  SabreCancelMappingError,
  SabreCardBinPricingDeniedError,
  SabreConfigError,
  SabreCreateBookingError,
  SabreCreateBookingMapError,
  SabreGetBookingBuildError,
  SabreGetBookingMappingError,
  SabreIndexError,
  SabreOfferPriceEmptyError,
  SabreOrderCreateInputError,
  SabrePriceMappingError,
  SabrePriceRejectedError,
  SabrePriceRequestError,
  SabreShopMappingError,
  type SabreFailureKind,
} from '@sales-travel/sabre';

/**
 * Traduce un error LANZADO por el ACL de Sabre a un mensaje en español para el vendedor.
 *
 * Diferencia de fondo con `humanizeLatamError`: aquí **nunca** se hace eco del texto del
 * proveedor. El mensaje sale de `failure.kind`, que es vocabulario NUESTRO, cerrado y
 * clasificado en `providers/sabre/src/errors.ts`.
 *
 * El motivo no es estética: lo que devuelve esta función viaja en `providers[].reason` del
 * endpoint de búsqueda —o sea, al navegador— y al log. El cuerpo de un error de Sabre puede
 * arrastrar el eco de la request (el `secret` de `/v2/auth/token` es base64 REVERSIBLE del
 * password de la oficina) y datos de pasajero. `SabreApiError` ya redacta su `body`, pero una
 * defensa en profundidad que dependa de que la capa de abajo no falle nunca es una defensa
 * sola. Aquí el texto del proveedor sencillamente no entra.
 */
const MENSAJE_POR_KIND: Readonly<Record<SabreFailureKind, string>> = {
  TRANSPORT: 'No pudimos conectar con Sabre. Probá de nuevo en unos segundos.',
  CLIENT_BUG:
    'La consulta a Sabre se armó mal de nuestro lado. Ya quedó registrado; probá con otra búsqueda.',
  AUTH_EXPIRED: 'La sesión con Sabre expiró. Probá de nuevo en unos segundos.',
  AUTH_POOL:
    'Sabre rechazó la autenticación o no hay tokens disponibles en este momento. Si se repite, verificá tus credenciales en Mi Red → Credenciales → Sabre.',
  CREDENTIALS_INVALID:
    'Las credenciales de Sabre (EPR, contraseña o PCC) son inválidas. Verificalas en Mi Red → Credenciales → Sabre.',
  ENTITLEMENT:
    'Tu PCC de Sabre no tiene habilitado este producto. Es un alta comercial pendiente con Sabre, no una caída del servicio.',
  NO_DATA: 'Sabre no devolvió vuelos para esta búsqueda.',
  THROTTLED: 'Sabre está limitando nuestras consultas. Probá de nuevo en unos segundos.',
  UPSTREAM: 'Sabre tuvo un problema interno. Probá de nuevo en unos minutos.',
  BUSINESS: 'Sabre rechazó la operación. Revisá los datos e intentá nuevamente.',
  SESSION: 'La sesión de Sabre se cerró. Probá de nuevo en unos segundos.',
  HUMAN_REVIEW:
    'Sabre devolvió un aviso que requiere revisión manual. Ya quedó registrado para el equipo.',
};

/** Fallback cuando el error no es ninguno de los tipados del ACL. */
const MENSAJE_DESCONOCIDO = 'No pudimos procesar la solicitud con Sabre. Intentá nuevamente.';

export function humanizeSabreError(err: unknown): string {
  // Sin `??` de rescate a propósito: `MENSAJE_POR_KIND` es un `Record` COMPLETO sobre
  // `SabreFailureKind`, así que el día que el ACL añada una clase de fallo esto no compila.
  // Un fallback aquí convertiría ese error de compilación en un mensaje genérico en producción.
  if (err instanceof SabreApiError) return MENSAJE_POR_KIND[err.failure.kind];

  // Config ausente o inválida: el mensaje lo construye `parseSabreConfig` con la RUTA y el
  // CÓDIGO del issue de Zod, nunca con el valor recibido. Por eso sí se puede mostrar.
  if (err instanceof SabreConfigError) {
    return `La configuración de Sabre de esta agencia es inválida (${err.message}). Revisala en Mi Red → Credenciales → Sabre.`;
  }

  // Respuesta fuera de contrato: el mensaje son rutas de campo + códigos de Zod, sin valores.
  if (err instanceof SabreShopMappingError) {
    return 'Sabre devolvió una respuesta que no pudimos interpretar. Ya quedó registrado para el equipo.';
  }

  // --- Fase 3: price, create, get y cancel ---------------------------------------------------
  //
  // Ninguna rama hace eco del `err.message`, aunque hoy todos estos mensajes los escribimos
  // nosotros y no llevan texto del proveedor. La regla de este fichero es que el texto del
  // vendor no entra, y una regla que se cumple "salvo en estos ocho casos donde lo revisé" es
  // una regla que la novena clase de error se salta.

  if (err instanceof SabrePriceRejectedError) {
    return 'Sabre rechazó revalidar el precio de esta oferta. Volvé a buscar: la tarifa pudo cambiar o expirar.';
  }
  if (err instanceof SabreOfferPriceEmptyError) {
    return 'Sabre no devolvió ninguna tarifa vigente para esta oferta. Volvé a buscar.';
  }
  if (err instanceof SabreCardBinPricingDeniedError) {
    return 'Tarificar con datos de tarjeta no está habilitado para esta agencia. La reserva se hace sin tarjeta y el cobro va por el checkout del medio de pago.';
  }
  if (
    err instanceof SabrePriceRequestError ||
    err instanceof SabreOrderCreateInputError ||
    err instanceof SabreCreateBookingError ||
    err instanceof SabreGetBookingBuildError ||
    err instanceof SabreIndexError
  ) {
    return 'No pudimos armar la operación con los datos de esta oferta. Revalidá el precio y volvé a intentar; si se repite, ya quedó registrado para el equipo.';
  }
  if (err instanceof SabreCancelBookingBuildError) {
    // `rule` es vocabulario NUESTRO y cerrado; es lo único que se cita, porque distingue
    // "falta el chequeo de billetes" de "esta reserva no se puede cancelar así".
    return `No pudimos armar la cancelación de esta reserva (${err.rule}). Ya quedó registrado para el equipo.`;
  }
  if (
    err instanceof SabrePriceMappingError ||
    err instanceof SabreCreateBookingMapError ||
    err instanceof SabreGetBookingMappingError ||
    err instanceof SabreCancelMappingError
  ) {
    return 'Sabre devolvió una respuesta que no pudimos interpretar. Ya quedó registrado para el equipo.';
  }

  return MENSAJE_DESCONOCIDO;
}

/**
 * Clases del ACL de Sabre que el filtro traduce, en el orden en que `@Catch` las recibe.
 *
 * Se declara una sola vez y la usan el decorador del filtro y {@link sabreErrorStatus}: dos
 * listas separadas se desincronizan, y el fallo es silencioso —la clase que falte en `@Catch`
 * sale como 500 «Ocurrió un error inesperado», que es justo el modo de fallo que el filtro
 * existe para evitar—.
 */
export const SABRE_THROWN_CLASSES = [
  SabreApiError,
  SabreConfigError,
  SabreShopMappingError,
  SabrePriceRequestError,
  SabrePriceMappingError,
  SabrePriceRejectedError,
  SabreOfferPriceEmptyError,
  SabreCardBinPricingDeniedError,
  SabreOrderCreateInputError,
  SabreCreateBookingError,
  SabreCreateBookingMapError,
  SabreGetBookingBuildError,
  SabreGetBookingMappingError,
  SabreCancelBookingBuildError,
  SabreCancelMappingError,
  SabreIndexError,
] as const;

/**
 * Estado HTTP de un error del ACL.
 *
 * **502 por defecto** —el fallo es del sistema de al lado— con dos excepciones deliberadas:
 *
 *  - `SabreCardBinPricingDeniedError` es **403**: no falló nada; se pidió algo que la postura
 *    PCI de la plataforma no permite para esta agencia (D1). Un 502 diría "Sabre está caído" y
 *    el vendedor reintentaría para siempre.
 *  - `SabreOfferPriceEmptyError` es **409**: Sabre contestó bien y lo que devolvió ya no se
 *    puede vender. La acción correcta es volver a buscar, no reintentar.
 *
 * Los errores de construcción (`*BuildError`, `*RequestError`, `SabreOrderCreateInputError`)
 * siguen en 502 a propósito aunque el bug sea NUESTRO: para el vendedor la operación no se pudo
 * hacer con este proveedor, y un 400 le haría creer que escribió algo mal.
 */
export function sabreErrorStatus(err: unknown): number {
  if (err instanceof SabreCardBinPricingDeniedError) return HttpStatus.FORBIDDEN;
  if (err instanceof SabreOfferPriceEmptyError) return HttpStatus.CONFLICT;
  return HttpStatus.BAD_GATEWAY;
}

/**
 * Se pidió a Sabre una operación que NO es de este contrato.
 *
 * Desde la Fase 3, Sabre hace búsqueda, revalidación de precio, creación, lectura y cancelación
 * (`docs/sabre/11-plan-implementacion.md` §7 y §8.1). Lo que queda fuera —pago/emisión diferida,
 * ancillaries y recotización con billetes— no es un paso pendiente de cablear: son operaciones
 * que este contrato no tiene, y las capacidades declaradas del factory (`pay`, `services`,
 * `reshop` en `false`) las frenan en el controlador.
 *
 * Esto es la segunda línea de defensa, para los caminos que NO están gateados por capacidad. Sin
 * ella, el `undefined is not a function` saldría como 500 genérico y el vendedor leería "error
 * inesperado" delante del cliente. 501 y no 400 porque no es un dato mal mandado.
 */
export class SabreOperationNotSupportedError extends NotImplementedException {
  constructor(readonly operation: string) {
    super(
      `La operación '${operation}' no está disponible en Sabre. Elegí una oferta de otro proveedor para continuar.`,
    );
    this.name = 'SabreOperationNotSupportedError';
  }
}

// `SabreMockBookingError` vivía aquí: era el 400 que se le devolvía al vendedor cuando su
// cuenta corría en modo simulado y pedía reservar. Se retira con el modo: una cuenta sin
// credenciales usables ya no se sirve, así que nadie puede llegar a pedir una reserva contra
// precios inventados. El error que sí queda para ese caso es la AUSENCIA del proveedor.
