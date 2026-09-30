import { Clock, LogOut, MonitorSmartphone, UserX, type LucideIcon } from 'lucide-react';
import { motivoMessage, type SessionMotivo } from '../../../lib/session-reasons';

const ICONS: Record<SessionMotivo, LucideIcon> = {
  inactividad: Clock,
  'otro-dispositivo': MonitorSmartphone,
  liberada: UserX,
  expirada: Clock,
  cerrada: LogOut,
};

/**
 * Lo que conviene hacer después, cuando no es obvio. Que la sesión se abrió en otro dispositivo
 * puede ser la primera señal de que alguien más tiene la contraseña.
 */
const HINTS: Partial<Record<SessionMotivo, string>> = {
  'otro-dispositivo': 'Si no fuiste vos, cambiá tu contraseña después de ingresar.',
  liberada: 'Si necesitás seguir trabajando, volvé a ingresar cuando haya un puesto libre.',
};

/**
 * Por qué se cerró la sesión (`/login?motivo=`). Sin esto el usuario ve el formulario vacío y no
 * sabe si lo desconectó un admin, si venció o si alguien entró con su usuario.
 */
export function ReasonBanner({
  motivo,
  idleMinutes,
}: {
  motivo: SessionMotivo;
  idleMinutes?: number;
}) {
  const Icon = ICONS[motivo];
  const hint = HINTS[motivo];
  return (
    <div
      role="status"
      className="mb-5 flex gap-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-3 py-2.5 text-sm leading-snug text-[var(--color-fg)]"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{motivoMessage(motivo, { idleMinutes })}</p>
        {hint ? <p className="text-[var(--color-fg-muted)]">{hint}</p> : null}
      </div>
    </div>
  );
}
