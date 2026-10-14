import { periodFromParam } from '../../../../../lib/platform-overview';
import { isUuid } from '../../../../../lib/wallets';
import { PlatformOverview } from './_components/platform-overview';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Plataforma → Resumen (sólo superadmin; la guarda es el layout de `/admin/plataforma`). El período
 * llega en `?periodo=` y un nodo en `?nodo=` acota todo a su subárbol.
 */
export default async function PlatformOverviewPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const nodo = first(params['nodo']);
  return (
    <PlatformOverview
      initialPeriod={periodFromParam(first(params['periodo']))}
      tenantId={isUuid(nodo) ? nodo.toLowerCase() : null}
    />
  );
}
