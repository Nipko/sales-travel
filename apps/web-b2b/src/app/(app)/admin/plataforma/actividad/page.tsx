import { activityFiltersFromSearchParams, activityHref } from '../../../../../lib/platform-audit';
import { ActivityPanel } from './_components/activity-panel';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Plataforma → Actividad (sólo superadmin; la guarda es el layout de `/admin/plataforma`): quién hizo
 * qué, dónde y cuándo, en toda la plataforma. Los filtros llegan en
 * `?categoria=&desde=&hasta=&nodo=&tipo=&entidad=&id=`; la ficha de una reserva enlaza aquí con su
 * entidad (`?entidad=order&id=`).
 */
export default async function PlatformActivityPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const filters = activityFiltersFromSearchParams(await searchParams);
  // Un enlace a otros filtros arranca la pantalla de cero.
  return <ActivityPanel key={activityHref(filters)} initialFilters={filters} />;
}
