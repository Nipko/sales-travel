import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A qué orden y a qué tenant pertenecen las llamadas a un proveedor que se hagan dentro de `fn`.
 *
 * El ACL no sabe qué es una orden, y no tiene por qué: escribe la bóveda desde su cliente HTTP, en
 * el contexto asíncrono de quien lo llamó. La saga de reserva y los jobs de verificación envuelven
 * sus llamadas con esto y cada RQ/RS queda atado a su orden, que es como se exporta después
 * ("todo lo de la orden X"). Fuera de un alcance, la fila se guarda sin orden y con el tenant del
 * request, si lo hay.
 */
export interface ProviderPayloadScope {
  readonly tenantId?: string;
  readonly orderId?: string;
}

const storage = new AsyncLocalStorage<ProviderPayloadScope>();

/** Un alcance anidado hereda lo que no redefine. */
export function withProviderPayloadScope<T>(scope: ProviderPayloadScope, fn: () => T): T {
  const outer = storage.getStore();
  return storage.run(
    {
      ...outer,
      ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
      ...(scope.orderId === undefined ? {} : { orderId: scope.orderId }),
    },
    fn,
  );
}

export function currentProviderPayloadScope(): ProviderPayloadScope | undefined {
  return storage.getStore();
}
