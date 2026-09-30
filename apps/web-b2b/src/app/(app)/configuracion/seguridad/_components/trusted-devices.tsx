'use client';

import { Laptop, Smartphone } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '../../../../../components/ui/button';
import { useConfirm } from '../../../../../components/ui/dialog';
import { revokeAllTrustedDevicesAction, revokeTrustedDeviceAction } from '../actions';
import type { TrustedDeviceRow } from '../security-model';
import { Notice } from './notice';
import { describeDevice, formatRelative, isMobileDevice } from './security-format';
import { settleAction } from './settle-action';

/**
 * Equipos donde el usuario marcó "Recordar este equipo": entran sin el código durante 30 días.
 * Quitar uno hace que el próximo ingreso desde ahí vuelva a pedir el código; no cierra sesiones.
 */
export function TrustedDevices({
  devices,
  now,
  loadError,
}: {
  devices: readonly TrustedDeviceRow[];
  now: number;
  loadError?: string;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, startTransition] = useTransition();
  const [removingAll, startRemoveAll] = useTransition();

  async function removeOne(device: TrustedDeviceRow): Promise<void> {
    const ok = await confirm({
      title: device.current ? '¿Olvidar este equipo?' : '¿Quitar este equipo?',
      description: device.current
        ? 'La próxima vez que entres desde este navegador te vamos a pedir el código de tu app.'
        : `La próxima vez que se entre desde ${describeDevice(device.userAgent)} te vamos a pedir el código de tu app.`,
      confirmLabel: 'Quitar',
    });
    if (!ok) return;
    setError('');
    setPendingId(device.id);
    startTransition(async () => {
      const res = await settleAction(() => revokeTrustedDeviceAction(device.id, device.current));
      setPendingId(null);
      if (res?.error) setError(res.error);
    });
  }

  async function removeAll(): Promise<void> {
    const ok = await confirm({
      title: '¿Quitar todos los equipos de confianza?',
      description:
        'En cada equipo, también en éste, te vamos a pedir el código de tu app la próxima vez que entres. Las sesiones abiertas siguen abiertas.',
      confirmLabel: 'Quitar todos',
    });
    if (!ok) return;
    setError('');
    startRemoveAll(async () => {
      const res = await settleAction(revokeAllTrustedDevicesAction);
      if (res?.error) setError(res.error);
    });
  }

  if (loadError) return <Notice tone="error">{loadError}</Notice>;

  return (
    <div className="space-y-4">
      {devices.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          No tenés equipos de confianza. Al ingresar con el código podés marcar «Recordar este
          equipo» para no tener que ingresarlo durante 30 días en ese navegador.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {devices.map((d) => {
            const device = describeDevice(d.userAgent);
            const Icon = isMobileDevice(d.userAgent) ? Smartphone : Laptop;
            return (
              <li
                key={d.id}
                className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]"
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-[var(--color-fg)]">
                      {device}
                      {d.current ? (
                        <span className="rounded-full border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-fg)]">
                          Este equipo
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-[var(--color-fg-muted)]">
                      {d.ip ? `${d.ip} · ` : ''}agregado {formatRelative(d.createdAt, now)} · último
                      uso {formatRelative(d.lastUsedAt, now)} · vence{' '}
                      {formatRelative(d.expiresAt, now)}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void removeOne(d)}
                  disabled={busy || removingAll}
                  aria-label={d.current ? 'Quitar este equipo' : `Quitar ${device}`}
                  className="ml-12 h-11 self-start sm:ml-0 sm:h-8 sm:self-auto"
                >
                  {pendingId === d.id ? 'Quitando…' : 'Quitar'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {error ? <Notice tone="error">{error}</Notice> : null}

      {devices.length > 1 ? (
        <div className="border-t border-[var(--color-border)] pt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void removeAll()}
            disabled={busy || removingAll}
            className="h-11 sm:h-9"
          >
            {removingAll ? 'Quitando…' : 'Quitar todos'}
          </Button>
        </div>
      ) : null}
      {confirmDialog}
    </div>
  );
}
