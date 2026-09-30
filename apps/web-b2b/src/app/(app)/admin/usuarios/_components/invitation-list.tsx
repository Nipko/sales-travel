'use client';

import { Send, X } from 'lucide-react';
import { Button } from '../../../../../components/ui/button';
import { cn } from '../../../../../lib/cn';
import { invitationExpiry } from '../../../../../lib/invitation-expiry';
import { exactTime } from '../../../../../lib/tenant-admin-format';
import { invitationOrigin, type PendingInvitation } from '../../../../../lib/tenant-admin-team';
import { roleLabel } from './roles';
import { useNow } from './seats-ui';

/**
 * Las invitaciones pendientes del nodo, con quién las mandó, cuándo vencen y cómo reenviarlas (enlace
 * nuevo y 7 días más, también a una que ya venció).
 */
export function InvitationList({
  items,
  onRevoke,
  onResend,
  resendingId,
}: {
  items: readonly PendingInvitation[];
  onRevoke: (invitation: PendingInvitation) => void;
  onResend: (invitation: PendingInvitation) => void;
  /** La que se está reenviando: su botón queda deshabilitado hasta que vuelva la respuesta. */
  resendingId: string | null;
}) {
  const now = useNow();
  return (
    <section
      aria-labelledby="invitations-title"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="border-b border-[var(--color-border)] px-4 py-2.5">
        <h2 id="invitations-title" className="text-sm font-semibold text-[var(--color-fg)]">
          Invitaciones pendientes ({items.length})
        </h2>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {items.map((i) => {
          const expiry = invitationExpiry(i.expiresAt, new Date(now));
          return (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-[var(--color-fg)]">{i.email}</p>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {roleLabel(i.role)}
                  {expiry ? (
                    <>
                      {' · '}
                      <span
                        className={cn(expiry.expired && 'font-medium text-[var(--color-danger)]')}
                      >
                        {expiry.label}
                      </span>
                    </>
                  ) : null}
                </p>
                <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                  {i.createdAt ? (
                    <time dateTime={i.createdAt} title={exactTime(i.createdAt)}>
                      {invitationOrigin(i, now)}
                    </time>
                  ) : (
                    invitationOrigin(i, now)
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={resendingId === i.id}
                  onClick={() => onResend(i)}
                  aria-label={`Reenviar la invitación a ${i.email}`}
                >
                  <Send aria-hidden="true" />
                  {resendingId === i.id ? 'Reenviando…' : 'Reenviar'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRevoke(i)}
                  aria-label={`Revocar la invitación a ${i.email}`}
                >
                  <X aria-hidden="true" />
                  Revocar
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
