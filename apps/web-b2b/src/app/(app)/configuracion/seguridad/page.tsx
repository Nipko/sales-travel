import { api } from '../../../../lib/api';
import { SecurityClient, type SessionRow } from './SecurityClient';

interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

export const dynamic = 'force-dynamic';

export default async function SeguridadPage({
  searchParams,
}: {
  searchParams: Promise<{ enrolar?: string }>;
}) {
  const params = await searchParams;
  const [statusRes, sessionsRes] = await Promise.all([
    api<MfaStatus>('/auth/mfa'),
    api<SessionRow[]>('/auth/sessions'),
  ]);

  const status = statusRes.ok ? statusRes.data : { enabled: false, recoveryCodesRemaining: 0 };
  const sessions = sessionsRes.ok ? sessionsRes.data : [];

  return (
    <SecurityClient
      mfaEnabled={status.enabled}
      recoveryCodesRemaining={status.recoveryCodesRemaining}
      sessions={sessions}
      // El login manda acá con ?enrolar=1 cuando el rol exige MFA y no está enrolado.
      enrollmentRequired={params.enrolar === '1' && !status.enabled}
      loadError={!statusRes.ok ? statusRes.error.message : undefined}
    />
  );
}
