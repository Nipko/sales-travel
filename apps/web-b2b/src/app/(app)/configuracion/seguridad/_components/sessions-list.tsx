'use client';

import { Laptop, LogOut, Monitor, Smartphone } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '../../../../../components/ui/button';
import { useConfirm } from '../../../../../components/ui/dialog';
import { revokeAllSessionsAction, revokeSessionAction } from '../actions';
import type { SessionRow } from '../security-model';
import { Notice } from './notice';
import { describeDevice, formatRelative, isActiveNow, isMobileDevice } from './security-format';
import { settleAction } from './settle-action';

function DeviceIcon({ ua }: { ua: string | null }) {
  const Icon = isMobileDevice(ua) ? Smartphone : ua ? Laptop : Monitor;
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]"
    >
      <Icon className="size-4" />
    </span>
  );
}

/**
 * Dispositivos con sesión abierta: "Cerrar" en cada uno que no sea éste, y "Cerrar sesión en todos
 * los dispositivos" (que incluye éste y vuelve al login). La sesión actual no tiene "Cerrar": para
 * eso está "Cerrar sesión", y cerrarla desde acá dejaba la pantalla sin sesión a mitad de camino.
 *
 * Si la lista no se pudo cargar se dice eso, no "no hay sesiones", y "Cerrar sesión en todos los
 * dispositivos" sigue disponible: `/auth/logout-all` no depende de la lista, y es justo lo que busca
 * quien sospecha que alguien más entró a su cuenta.
 */
export function SessionsList({
  sessions,
  now,
  loadError,
}: {
  sessions: readonly SessionRow[];
  now: number;
  loadError?: string;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, startTransition] = useTransition();
  const [closingAll, startCloseAll] = useTransition();

  async function closeOne(session: SessionRow): Promise<void> {
    const ok = await confirm({
      title: '¿Cerrar esta sesión?',
      description: `${describeDevice(session.userAgent)}${
        session.ip ? ` (${session.ip})` : ''
      } va a tener que volver a ingresar con la contraseña.`,
      confirmLabel: 'Cerrar sesión',
    });
    if (!ok) return;
    setError('');
    setPendingId(session.id);
    startTransition(async () => {
      const res = await settleAction(() => revokeSessionAction(session.id));
      setPendingId(null);
      if (res?.error) setError(res.error);
    });
  }

  async function closeAll(): Promise<void> {
    const ok = await confirm({
      title: '¿Cerrar sesión en todos los dispositivos?',
      description:
        'Se cierran todas tus sesiones, también ésta: vas a tener que volver a ingresar en cada dispositivo.',
      confirmLabel: 'Cerrar todas',
    });
    if (!ok) return;
    setError('');
    startCloseAll(async () => {
      const res = await settleAction(revokeAllSessionsAction);
      if (res?.error) setError(res.error);
    });
  }

  return (
    <div className="space-y-4">
      {loadError ? (
        <Notice tone="error">{loadError}</Notice>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">No hay sesiones para mostrar.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {sessions.map((s) => {
            const device = describeDevice(s.userAgent);
            const activeNow = !s.current && isActiveNow(s.lastSeenAt, now);
            return (
              <li
                key={s.id}
                className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <DeviceIcon ua={s.userAgent} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-[var(--color-fg)]">
                      {device}
                      {s.current ? (
                        <span className="rounded-full border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-fg)]">
                          Esta sesión
                        </span>
                      ) : activeNow ? (
                        <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-fg-muted)]">
                          Activa ahora
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-[var(--color-fg-muted)]">
                      {s.ip ?? 'IP desconocida'} · iniciada {formatRelative(s.issuedAt, now)} ·
                      última actividad {formatRelative(s.lastSeenAt, now)}
                    </p>
                  </div>
                </div>
                {s.current ? null : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void closeOne(s)}
                    disabled={busy || closingAll}
                    aria-label={`Cerrar la sesión de ${device}`}
                    className="ml-12 h-11 self-start sm:ml-0 sm:h-8 sm:self-auto"
                  >
                    {pendingId === s.id ? 'Cerrando…' : 'Cerrar'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-center sm:gap-3">
        <Button
          type="button"
          variant="danger"
          disabled={closingAll || busy}
          onClick={() => void closeAll()}
          // El texto es largo: en un teléfono angosto baja de línea en vez de desbordar.
          className="h-auto min-h-11 whitespace-normal py-2 sm:min-h-9"
        >
          <LogOut aria-hidden="true" />
          {closingAll ? 'Cerrando…' : 'Cerrar sesión en todos los dispositivos'}
        </Button>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Incluye esta sesión: vas a tener que volver a entrar.
        </p>
      </div>
      {confirmDialog}
    </div>
  );
}
