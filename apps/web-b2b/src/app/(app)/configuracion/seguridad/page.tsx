import { api } from '../../../../lib/api';
import { SecurityClient } from './SecurityClient';
import {
  sortSessions,
  sortTrustedDevices,
  toMfaStatus,
  toSessionRows,
  toTrustedDeviceRows,
} from './security-model';

export const dynamic = 'force-dynamic';

export default async function SeguridadPage({
  searchParams,
}: {
  searchParams: Promise<{ enrolar?: string | string[] }>;
}) {
  const params = await searchParams;

  const [statusRes, sessionsRes, devicesRes, meRes] = await Promise.all([
    api<unknown>('/auth/mfa'),
    api<unknown>('/auth/sessions'),
    // `current` ("Este equipo") sale de comparar con `x-trusted-device`, que `api()` agrega a /auth/*.
    api<unknown>('/auth/trusted-devices'),
    api<{ email?: unknown }>('/me'),
  ]);

  // `null` = no sabemos cómo está el 2FA: la tarjeta lo dice y no ofrece activar ni desactivar. El
  // mensaje crudo del API (a veces en inglés) no llega a la pantalla.
  const mfa = statusRes.ok ? toMfaStatus(statusRes.data) : null;
  const sessions = sortSessions(toSessionRows(sessionsRes.ok ? sessionsRes.data : []));
  const trustedDevices = sortTrustedDevices(
    toTrustedDeviceRows(devicesRes.ok ? devicesRes.data : []),
  );
  const email = meRes.ok && typeof meRes.data.email === 'string' ? meRes.data.email : undefined;
  const enrolar = Array.isArray(params.enrolar) ? params.enrolar[0] : params.enrolar;

  return (
    <SecurityClient
      mfa={mfa}
      sessions={sessions}
      // Una lista vacía por un error decía "0 sesiones activas", que nunca es cierto: la actual
      // siempre existe.
      sessionsError={
        sessionsRes.ok ? undefined : 'No pudimos cargar tus sesiones abiertas. Recargá la página.'
      }
      trustedDevices={trustedDevices}
      trustedDevicesError={
        devicesRes.ok ? undefined : 'No pudimos cargar los equipos de confianza. Recargá la página.'
      }
      email={email}
      now={Date.now()}
      // El login manda acá con ?enrolar=1 cuando el rol exige 2FA; el API también lo informa.
      enrollmentRequired={mfa !== null && !mfa.enabled && (mfa.required || enrolar === '1')}
    />
  );
}
