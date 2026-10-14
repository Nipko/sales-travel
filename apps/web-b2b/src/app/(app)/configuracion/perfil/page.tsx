import { api } from '../../../../lib/api';
import { ProfileScreen } from './_components/profile-form';
import { parseProfile } from './profile-model';

export const dynamic = 'force-dynamic';

/** Mi cuenta → Perfil (USR-18): el nombre visible, que cada persona cambia sólo para sí. */
export default async function PerfilPage() {
  const meRes = await api<unknown>('/me');
  return <ProfileScreen profile={meRes.ok ? parseProfile(meRes.data) : null} />;
}
