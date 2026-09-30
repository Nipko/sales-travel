'use client';

import { X } from 'lucide-react';
import { Button } from '../../../../../components/ui/button';
import { exactTime } from '../../../../../lib/tenant-admin-format';
import { invitationOrigin, type PendingInvitation } from '../../../../../lib/tenant-admin-team';
import { roleLabel } from './roles';
import { useNow } from './seats-ui';

/** Las invitaciones pendientes del nodo, con quién las mandó y cuándo. */
export function InvitationList({
  items,
  onRevoke,
}: {
  items: readonly PendingInvitation[];
  onRevoke: (invitation: PendingInvitation) => void;
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
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-[var(--color-fg)]">{i.email}</p>
              <p className="text-xs text-[var(--color-fg-muted)]">
                {roleLabel(i.role)} · vence {new Date(i.expiresAt).toLocaleDateString('es-CO')}
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRevoke(i)}
              aria-label={`Revocar la invitación a ${i.email}`}
            >
              <X aria-hidden="true" />
              Revocar
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
