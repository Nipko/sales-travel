import { SetMetadata } from '@nestjs/common';

export const SALES_OPERATION_KEY = 'salesOperation';

/**
 * Marca una ruta como OPERACIÓN DE VENTA: cotiza, reserva o cobra a nombre del nodo activo.
 *
 * El superadmin cuadra la red pero no vende (modelo Planetour, 2026-09-28): Planetour vende por sus
 * sucursales, con usuarios de esas sucursales. En una ruta marcada, `RolesGuard` exige un rol de
 * `SELLING_ROLES` SIN el pase libre de los roles de plataforma, y a `superadmin` y `platform_admin`
 * les responde 403 con `PLATFORM_ROLE_CANNOT_SELL`. Lo mismo al usuario que tiene un rol de
 * plataforma en cualquier nodo, aunque en el tenant activo sea vendedor (p. ej. de una sucursal):
 * el superadmin es una identidad del usuario. Si la ruta declara además `@Roles`, el rol tiene que
 * estar en las dos listas.
 *
 * Qué es venta: lo que da precio o disponibilidad para vender (búsquedas, revalidación, PreBook,
 * servicios adicionales, recotización) y lo que compromete la venta (Book, crear la orden,
 * pagarla o emitirla, crear, editar o enviar cotizaciones y paquetes). Qué no: la post-venta de
 * lectura, las correcciones administrativas (cancelar, reintentar una cancelación, rechazar un
 * hold) y los datos de referencia sin precio (autocompletar destinos, oficinas, ficha de un hotel).
 *
 * `sales-operations.guard.test.ts` recorre todas las rutas de la API y falla si una no está
 * clasificada, o si su marca no coincide con la clasificación.
 */
export const SalesOperation = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SALES_OPERATION_KEY, true);
