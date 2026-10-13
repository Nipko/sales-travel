import {
  filtersFromSearchParams,
  orderFromSearchParams,
  ordersHref,
} from '../../../../../lib/platform-orders';
import { OrdersConsole } from './_components/orders-console';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Plataforma → Reservas de la red (sólo superadmin; la guarda es el layout de `/admin/plataforma`).
 * Los filtros llegan en `?atencion=&estado=&vertical=&proveedor=&nodo=&red=&desde=&hasta=` y la
 * ficha abierta en `?orden=`: el Resumen enlaza aquí con `?atencion=1` y con `?orden=` de cada
 * reserva con problemas.
 */
export default async function PlatformOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filters = filtersFromSearchParams(params);
  const orderId = orderFromSearchParams(params);
  // Un enlace a otros filtros (desde el Resumen, por ejemplo) arranca la consola de cero.
  return (
    <OrdersConsole
      key={ordersHref(filters, orderId)}
      initialFilters={filters}
      initialOrderId={orderId}
    />
  );
}
