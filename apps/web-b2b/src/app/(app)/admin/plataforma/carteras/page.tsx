import { carterasHref, filtersFromSearchParams } from '../../../../../lib/deposit-approvals';
import { DepositApprovalsPanel } from './_components/deposit-approvals-panel';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Plataforma → Carteras: los depósitos informados de toda la red (sólo superadmin; la guarda es el
 * layout de `/admin/plataforma`). Los filtros llegan en `?estado=&alcance=&moneda=&nodo=`.
 */
export default async function PlatformWalletsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const filters = filtersFromSearchParams(await searchParams);
  // Un enlace a otros filtros (la ficha de otro nodo) arranca la cola de cero.
  return <DepositApprovalsPanel key={carterasHref(filters)} initialFilters={filters} />;
}
