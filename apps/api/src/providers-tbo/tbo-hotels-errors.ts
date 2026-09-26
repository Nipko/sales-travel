import { HttpException, HttpStatus } from '@nestjs/common';
import {
  TBO_OPERATIONS,
  TboApiError,
  TboCancelMappingError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboError,
  TboOfferExpiredError,
  TboPackageOnlyRateError,
  TboRequestBuildError,
  TboResponseMappingError,
  TboUnsupportedCurrencyError,
  type TboFailureKind,
} from '@sales-travel/tbo-hotels';
import type { CredentialSource, ProviderErrorContext } from '../providers/provider.types.js';
import type { CircuitEffect } from '../search/circuit-breaker.service.js';

/**
 * Traducción de los errores del ACL de TBO para el vendedor (docs/tbo/01 §8.3, §8.4 y §9.4;
 * 08 RF-04).
 *
 * Tres reglas que no se negocian:
 *
 * 1. **Nunca se cita texto de TBO** (RF-04 CA-4). Ni `Status.Description` ni el `message` de un
 *    error: todo sale de `failure.kind`, de la clase y de vocabulario nuestro. Lo que devuelve
 *    este módulo viaja al navegador en `providers[].reason` y en el cuerpo de error.
 * 2. **Un `kind` nuevo sin mensaje no compila** (RF-04 CA-3): la tabla es un `Record` completo
 *    sobre `TboFailureKind`, sin `??` de rescate que lo convierta en un mensaje genérico.
 * 3. **El mensaje le habla a quien puede actuar.** Con la cuenta heredada, una credencial rechazada
 *    se arregla en el nodo del consolidador, no en el de la agencia que la ve.
 */

const PANEL = 'Mi Red → Credenciales → TBO Hoteles';

/**
 * De quién es la cuenta con la que se llamó, visto por quien recibe el mensaje. `unknown` es el
 * filtro de excepciones: un adapter heredado es el mismo para el consolidador y sus agencias, y
 * sin el contexto de la búsqueda no hay forma de saber cuál de los dos lo está viendo.
 */
type Origin = CredentialSource | 'unknown';

type ByOrigin = Readonly<Record<Origin, string>>;

/** El mismo `kind` pide otra cosa en un Book o un Cancel, donde el desenlace puede ser incierto. */
type Operation = 'search' | 'book' | 'cancel' | 'other';

interface MessageContext {
  readonly origin: Origin;
  readonly operation: Operation;
}

/** Book sin respuesta cierta: la saga lo deja `UNVERIFIED` y repetirlo puede reservar dos veces. */
const BOOK_UNVERIFIED =
  'No recibimos la confirmación de TBO. Estamos verificando si la reserva quedó hecha; no la repitas. Te avisamos en unos minutos.';

/** Cancel sin respuesta cierta: pudo aplicarse, y otra cancelación a ciegas no aclara nada. */
const CANCEL_UNVERIFIED =
  'No pudimos confirmar si TBO canceló la reserva. Estamos verificando su estado; no la canceles de nuevo.';

const UNREADABLE =
  'TBO devolvió una respuesta que no pudimos interpretar. Ya quedó registrado para el equipo.';

const REQUEST_REJECTED =
  'No pudimos armar la consulta a TBO con estos datos. Ya quedó registrado; revisá fechas y ocupación y probá de nuevo.';

const OFFER_EXPIRED =
  'La cotización venció: TBO la mantiene 30 minutos desde la búsqueda. Volvé a buscar para reservar.';

const THROTTLED = 'TBO está limitando la cantidad de consultas. Probá de nuevo en unos segundos.';

const UNKNOWN_MESSAGE = 'No pudimos procesar la solicitud con TBO. Intentá nuevamente.';

/** En Book y Cancel, estos desenlaces no dicen si TBO aplicó el write (01 §8.4, última fila). */
function uncertainWrite(ctx: MessageContext, otherwise: string): string {
  if (ctx.operation === 'book') return BOOK_UNVERIFIED;
  if (ctx.operation === 'cancel') return CANCEL_UNVERIFIED;
  return otherwise;
}

const CREDENTIALS_INVALID: ByOrigin = {
  own: `TBO rechazó el usuario o la contraseña de tu agencia. Verificalos en ${PANEL}.`,
  inherited:
    'TBO rechazó las credenciales que tu agencia hereda del consolidador. Avisale al consolidador para que las revise.',
  env: 'El acceso de la plataforma a TBO fue rechazado. Ya quedó registrado para el equipo.',
  unknown: `TBO rechazó las credenciales de la cuenta con la que opera tu agencia. Revisalas en ${PANEL} o avisale a quien las administra.`,
};

const ACCOUNT_BLOCKED: ByOrigin = {
  own: 'TBO tiene bloqueada la cuenta de tu agencia. No se pueden consultar ni reservar hoteles de TBO hasta que TBO la habilite; contactá a tu ejecutivo de TBO.',
  inherited: 'TBO tiene bloqueada la cuenta del consolidador. Avisale al consolidador.',
  env: 'TBO tiene bloqueada la cuenta de la plataforma. Ya quedó registrado para el equipo.',
  unknown:
    'TBO tiene bloqueada la cuenta con la que opera tu agencia. Avisale a quien la administra o contactá a tu ejecutivo de TBO.',
};

const INSUFFICIENT_BALANCE: ByOrigin = {
  own: 'La cuenta de TBO de tu agencia no tiene saldo o crédito suficiente para esta reserva. Cargá saldo en TBO o elegí otra tarifa.',
  inherited:
    'La cuenta de TBO del consolidador no tiene saldo suficiente para esta reserva. Avisale al consolidador.',
  env: 'La cuenta de TBO de la plataforma no tiene saldo suficiente para esta reserva. Ya quedó registrado para el equipo.',
  unknown:
    'La cuenta de TBO con la que opera tu agencia no tiene saldo o crédito suficiente para esta reserva. Avisale a quien la administra o elegí otra tarifa.',
};

const ACCOUNT_CONFIG_INVALID: ByOrigin = {
  own: `La configuración de la cuenta de TBO de tu agencia es inválida. Revisala en ${PANEL}.`,
  inherited:
    'La configuración de la cuenta de TBO que tu agencia hereda del consolidador es inválida. Avisale al consolidador.',
  env: 'La configuración de TBO de la plataforma es inválida. Ya quedó registrado para el equipo.',
  unknown: `La configuración de la cuenta de TBO con la que opera tu agencia es inválida. Revisala en ${PANEL} o avisale a quien la administra.`,
};

const ACCOUNT_INCOMPLETE: ByOrigin = {
  own: `A la cuenta de TBO de tu agencia le faltan datos para operar. Completala en ${PANEL}.`,
  inherited:
    'A la cuenta de TBO que tu agencia hereda del consolidador le faltan datos para operar. Avisale al consolidador.',
  env: 'A la cuenta de TBO de la plataforma le faltan datos para operar. Ya quedó registrado para el equipo.',
  unknown: `A la cuenta de TBO con la que opera tu agencia le faltan datos para operar. Completala en ${PANEL} o avisale a quien la administra.`,
};

/**
 * Un mensaje por `kind`. `Record` COMPLETO sobre `TboFailureKind`: el día que el ACL sume un
 * `kind`, esto deja de compilar (RF-04 CA-3). Textos de docs/tbo/01 §8.3 y §8.4.
 */
const MESSAGE_BY_KIND: Readonly<Record<TboFailureKind, (ctx: MessageContext) => string>> = {
  TRANSPORT: (ctx) =>
    uncertainWrite(ctx, 'No pudimos conectar con TBO. Probá de nuevo en unos segundos.'),
  MALFORMED_RESPONSE: (ctx) => uncertainWrite(ctx, UNREADABLE),
  UNKNOWN_CODE: (ctx) =>
    uncertainWrite(
      ctx,
      'TBO devolvió un estado que no reconocemos. Ya quedó registrado para el equipo.',
    ),
  CLIENT_BUG: () => REQUEST_REJECTED,
  CREDENTIALS_INVALID: (ctx) => CREDENTIALS_INVALID[ctx.origin],
  ACCOUNT_BLOCKED: (ctx) => ACCOUNT_BLOCKED[ctx.origin],
  INSUFFICIENT_BALANCE: (ctx) => INSUFFICIENT_BALANCE[ctx.origin],
  THROTTLED: (ctx) => uncertainWrite(ctx, THROTTLED),
  UPSTREAM: (ctx) =>
    uncertainWrite(ctx, 'TBO tuvo un problema interno. Probá de nuevo en unos minutos.'),
  NO_AVAILABILITY: (ctx) =>
    ctx.operation === 'search'
      ? 'TBO no tiene habitaciones disponibles para estas fechas y ocupación.'
      : 'La habitación elegida ya no tiene disponibilidad en TBO. Volvé a buscar para ver opciones actualizadas.',
  RATE_UNAVAILABLE: () =>
    'Esta tarifa ya no está disponible en TBO. Volvé a buscar para ver precios actualizados.',
  OFFER_EXPIRED: () => OFFER_EXPIRED,
  BOOKING_FAILED: () =>
    'TBO no pudo crear la reserva. Estamos verificando que no haya quedado registrada; no la repitas hasta ver el resultado.',
  CANCEL_FAILED: () =>
    'TBO no pudo cancelar la reserva. Revisá su estado en el detalle antes de volver a intentar; si sigue activa, contactá a soporte.',
};

const OPERATION_BY_PATH: ReadonlyMap<string, Operation> = new Map([
  [TBO_OPERATIONS.search.path.toLowerCase(), 'search'],
  [TBO_OPERATIONS.book.path.toLowerCase(), 'book'],
  [TBO_OPERATIONS.cancel.path.toLowerCase(), 'cancel'],
]);

function operationOf(path: string): Operation {
  return OPERATION_BY_PATH.get(path.toLowerCase()) ?? 'other';
}

function contextOf(path: string, context: ProviderErrorContext): MessageContext {
  return { origin: context.credentialSource ?? 'unknown', operation: operationOf(path) };
}

/**
 * Mensaje para el vendedor de cualquier cosa que el ACL de TBO lance.
 *
 * `context.credentialSource` lo pone quien sabe con qué cuenta se llamó (la búsqueda); sin él, los
 * mensajes de cuenta hablan de "la cuenta con la que opera tu agencia" sin suponer de quién es.
 */
export function humanizeTboError(err: unknown, context: ProviderErrorContext = {}): string {
  if (err instanceof TboApiError) {
    return MESSAGE_BY_KIND[err.failure.kind](contextOf(err.path, context));
  }
  const origin: Origin = context.credentialSource ?? 'unknown';
  if (err instanceof TboOfferExpiredError) return OFFER_EXPIRED;
  // Antes que la clase madre: en `/Cancel` una lectura fallida no prueba que no se canceló.
  if (err instanceof TboCancelMappingError) return CANCEL_UNVERIFIED;
  if (err instanceof TboResponseMappingError) {
    return uncertainWrite(contextOf(err.path, context), UNREADABLE);
  }
  if (err instanceof TboRequestBuildError) {
    return err.reason === 'NOT_ELIGIBLE'
      ? 'TBO no admite esta búsqueda: revisá la nacionalidad del pasajero principal y la ocupación (hasta 4 niños por habitación).'
      : REQUEST_REJECTED;
  }
  if (err instanceof TboDispatchRejectedError) {
    return err.reason === 'DEADLINE'
      ? 'TBO no alcanzó a responder dentro del tiempo de la búsqueda. Probá de nuevo.'
      : THROTTLED;
  }
  if (err instanceof TboConfigError) return ACCOUNT_CONFIG_INVALID[origin];
  if (err instanceof TboCredentialsMissingError) return ACCOUNT_INCOMPLETE[origin];
  // Las monedas vienen de una respuesta de TBO: no se citan, aunque tengan forma ISO (RF-04 CA-4).
  if (err instanceof TboUnsupportedCurrencyError) {
    return 'La cuenta de TBO cotiza en una moneda sin dos decimales, que no podemos mostrar. Hace falta que TBO configure el perfil en USD u otra moneda de dos decimales; avisale a quien administra la cuenta.';
  }
  if (err instanceof TboPackageOnlyRateError) {
    return 'Esta tarifa de TBO sólo se vende en un paquete con aéreo. Elegí otra tarifa.';
  }
  // Las excepciones HTTP son nuestras (breaker, operación no disponible): su texto ya es para el
  // vendedor. Cualquier otra cosa puede traer lo que sea en `message`.
  if (err instanceof HttpException) return err.message;
  return UNKNOWN_MESSAGE;
}

/**
 * Campo máquina del cuerpo de error (`reason`), para que la web ofrezca "Volver a buscar" o
 * "Reintentar" sin interpretar el texto (docs/tbo/01 §9.4). Los `kind` del cable más los desenlaces
 * locales, con nombres propios.
 */
export const TBO_LOCAL_ERROR_REASONS = [
  'ACCOUNT_CONFIG_INVALID',
  'ACCOUNT_INCOMPLETE',
  'REQUEST_NOT_ELIGIBLE',
  'REQUEST_REJECTED',
  'NOT_DISPATCHED',
  'RESPONSE_UNREADABLE',
  'CANCEL_UNVERIFIED',
  'UNSUPPORTED_CURRENCY',
  'PACKAGE_ONLY_RATE',
  'UNKNOWN',
] as const;

export type TboErrorReason = TboFailureKind | (typeof TBO_LOCAL_ERROR_REASONS)[number];

export function tboErrorReason(err: unknown): TboErrorReason {
  if (err instanceof TboApiError) return err.failure.kind;
  // El mismo motivo que un 315: la acción del vendedor es idéntica, volver a buscar.
  if (err instanceof TboOfferExpiredError) return 'OFFER_EXPIRED';
  if (err instanceof TboCancelMappingError) return 'CANCEL_UNVERIFIED';
  if (err instanceof TboResponseMappingError) return 'RESPONSE_UNREADABLE';
  if (err instanceof TboRequestBuildError) {
    return err.reason === 'NOT_ELIGIBLE' ? 'REQUEST_NOT_ELIGIBLE' : 'REQUEST_REJECTED';
  }
  if (err instanceof TboDispatchRejectedError) return 'NOT_DISPATCHED';
  if (err instanceof TboConfigError) return 'ACCOUNT_CONFIG_INVALID';
  if (err instanceof TboCredentialsMissingError) return 'ACCOUNT_INCOMPLETE';
  if (err instanceof TboUnsupportedCurrencyError) return 'UNSUPPORTED_CURRENCY';
  if (err instanceof TboPackageOnlyRateError) return 'PACKAGE_ONLY_RATE';
  return 'UNKNOWN';
}

/** Volver a buscar: la tarifa o la disponibilidad cambiaron, o esa cuenta no puede con ella. */
const CONFLICT_KINDS: ReadonlySet<TboFailureKind> = new Set<TboFailureKind>([
  'NO_AVAILABILITY',
  'RATE_UNAVAILABLE',
  'OFFER_EXPIRED',
  'INSUFFICIENT_BALANCE',
]);

/**
 * Estado HTTP hacia el front (docs/tbo/01 §9.4). 502 por defecto —la operación no se pudo hacer
 * con TBO—, 409 cuando lo que hay que hacer es volver a buscar u otra tarifa, 503 cuando basta con
 * reintentar en segundos y 400 sólo cuando el vendedor pidió algo que TBO no admite y puede
 * corregirlo (nacionalidad u ocupación).
 */
export function tboErrorStatus(err: unknown): number {
  if (err instanceof TboApiError) {
    if (CONFLICT_KINDS.has(err.failure.kind)) return HttpStatus.CONFLICT;
    if (err.failure.kind === 'THROTTLED') return HttpStatus.SERVICE_UNAVAILABLE;
    return HttpStatus.BAD_GATEWAY;
  }
  if (err instanceof TboOfferExpiredError || err instanceof TboPackageOnlyRateError) {
    return HttpStatus.CONFLICT;
  }
  if (err instanceof TboDispatchRejectedError) return HttpStatus.SERVICE_UNAVAILABLE;
  if (err instanceof TboRequestBuildError && err.reason === 'NOT_ELIGIBLE') {
    return HttpStatus.BAD_REQUEST;
  }
  return HttpStatus.BAD_GATEWAY;
}

/**
 * Efecto en el breaker de lo que el ACL lanza. Un `TboApiError` trae el suyo en `failure.circuit` y
 * se deja que el breaker lo lea. Todo otro `TboError` se cortó de nuestro lado o es una lectura
 * nuestra que falló: no dice nada de si TBO está caído y no suma (RNF-03 punto 4; 01 §8.4 y §12.3
 * punto 5).
 */
export function tboCircuitEffect(err: unknown): CircuitEffect | undefined {
  if (err instanceof TboApiError) return undefined;
  if (err instanceof TboError) return 'IGNORE';
  return undefined;
}
