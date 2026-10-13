import { api } from '../../../../../lib/api';
import { PlatformUsersPanel } from './_components/platform-users-panel';

interface MeView {
  id?: unknown;
  email?: unknown;
}

/**
 * Plataforma → Usuarios: todas las personas de la red y las invitaciones sin aceptar (sólo
 * superadmin; el layout de la plataforma redirige a los demás y el API lo exige en cada llamada).
 *
 * Quién mira se resuelve acá para no ofrecerle suspenderse a sí mismo (el API lo rechaza igual) y
 * para mostrar que una invitación que reenvía queda a su nombre. Si la lectura falla, la pantalla
 * ofrece todo y decide el API.
 */
export default async function PlatformUsersPage() {
  const me = await api<MeView>('/me');
  const viewerId = me.ok && typeof me.data.id === 'string' ? me.data.id.toLowerCase() : null;
  const viewerEmail = me.ok && typeof me.data.email === 'string' ? me.data.email : null;
  return <PlatformUsersPanel viewerId={viewerId} viewerEmail={viewerEmail} />;
}
