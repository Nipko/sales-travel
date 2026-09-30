import { api } from '../../../../lib/api';
import { teamActorOf } from '../../../../lib/tenant-admin-team';
import { TeamPanel } from './_components/team-panel';

interface MeView {
  id?: unknown;
}

interface MembershipView {
  role: string;
  status: string;
}

/**
 * Equipo de la red.
 *
 * Quién mira se resuelve acá (servidor) para no ofrecerle acciones sobre sí mismo ni sobre quien
 * lo supera en rango: el API las rechaza igual, pero un botón que siempre falla es ruido. Si estas
 * lecturas fallan, la pantalla ofrece todo y decide el API.
 *
 * `?tenant=<id>` abre en ese nodo: es el "Usuarios" de cada fila de /red, que antes tenía su propio
 * modal (con alta por contraseña) y ahora es esta misma pantalla. Un id fuera de la red se ignora.
 */
export default async function AdminUsuariosPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string | string[] }>;
}) {
  const { tenant } = await searchParams;
  const [me, memberships] = await Promise.all([
    api<MeView>('/me'),
    api<MembershipView[]>('/me/memberships'),
  ]);
  const userId = me.ok && typeof me.data.id === 'string' ? me.data.id : null;
  const actor = teamActorOf(
    userId,
    memberships.ok && Array.isArray(memberships.data) ? memberships.data : [],
  );
  return (
    <TeamPanel actor={actor} initialTenantId={typeof tenant === 'string' ? tenant : undefined} />
  );
}
