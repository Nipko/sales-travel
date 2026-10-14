'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { loginPath } from '../../../../components/layout/session-guard-state';
import { apiWithStatus } from '../../../../lib/api';
import { checkPersonName } from '../../../../lib/person-name';
import { clearSession } from '../../../../lib/session';
import { motivoForUnauthorized } from '../../../../lib/session-reasons';
import { failureFrom } from '../seguridad/security-errors';
import { PROFILE_PATH, profileFailureMessage, savedNameFrom } from './profile-model';

export interface ProfileResult {
  ok?: boolean;
  /** El nombre como quedó guardado (normalizado: sin espacios de sobra). */
  name?: string;
  error?: string;
}

/**
 * Cambia el nombre de la propia cuenta (`PATCH /me`). Valida antes con las mismas reglas que el API
 * (lib/person-name), así el error sale junto al campo sin ir al servidor; el API las vuelve a
 * aplicar. La cuenta es la de la sesión: no viaja ningún id.
 *
 * En éxito revalida todo el panel desde el layout: la barra de arriba lee `/me` en cada render y
 * Equipo, la ficha y el directorio piden el nombre al API cada vez, así que con esto la barra lo
 * muestra al instante y el resto, en cuanto se abre.
 */
export async function updateNameAction(formData: FormData): Promise<ProfileResult> {
  const check = checkPersonName(formData.get('name'));
  if (!check.ok) return { error: check.error };

  const res = await apiWithStatus('/me', {
    method: 'PATCH',
    body: JSON.stringify({ name: check.name }),
  });

  if (res.kind !== 'unreachable' && res.status >= 200 && res.status < 300) {
    revalidatePath('/', 'layout');
    return { ok: true, name: (res.kind === 'json' ? savedNameFrom(res.body) : null) ?? check.name };
  }

  // Sin sesión no hay perfil que guardar: al login con el motivo, y de vuelta acá después.
  if (res.status === 401) {
    await clearSession();
    redirect(loginPath(motivoForUnauthorized(failureFrom(res).reason), PROFILE_PATH));
  }
  return { error: profileFailureMessage(res) };
}
