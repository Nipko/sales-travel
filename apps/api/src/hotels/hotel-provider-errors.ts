import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * TODOS los proveedores de hoteles consultados fallaron. Es 502 y no 500: el fallo es del sistema
 * de al lado, y una lista vacía sería peor, porque el vendedor la leería como "no hay hoteles" y
 * se lo diría a su cliente. Mismo contrato que `AllFlightProvidersFailedError`.
 *
 * `failures[].reason` ya viene humanizado por el factory de cada proveedor: nunca es el cuerpo
 * crudo de su respuesta.
 */
export class AllHotelProvidersFailedError extends BadGatewayException {
  constructor(readonly failures: readonly { code: string; reason: string }[]) {
    super(failures.map((f) => `${f.code}: ${f.reason}`).join('; '));
    this.name = 'AllHotelProvidersFailedError';
  }
}

/**
 * Ningún proveedor habilitado para la agencia sabe hacer lo que se pidió (p. ej. sugerir
 * destinos). Es 503 y no 400: el pedido es válido, lo que falta es configuración de la red.
 */
export class HotelOperationUnavailableError extends ServiceUnavailableException {
  constructor(readonly operation: string) {
    super(
      `Ninguno de los proveedores de hoteles habilitados para esta agencia ofrece ${operation}. Revisá Mi Red → Credenciales.`,
    );
    this.name = 'HotelOperationUnavailableError';
  }
}

/**
 * Se nombró un proveedor que existe y está habilitado, pero que no tiene esa capacidad. Es 400:
 * el proveedor lo eligió el cliente.
 */
export class HotelProviderCapabilityError extends BadRequestException {
  constructor(
    readonly providerCode: string,
    readonly operation: string,
  ) {
    super(`El proveedor '${providerCode}' no ofrece ${operation}.`);
    this.name = 'HotelProviderCapabilityError';
  }
}
