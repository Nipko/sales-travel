'use client';

import { Armchair, LogOut, Monitor, RefreshCw, Timer } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../components/ui/button';
import { useConfirm } from '../../../../../components/ui/dialog';
import { cn } from '../../../../../lib/cn';
import { deviceLabel, exactTime, relativeTime } from '../../../../../lib/tenant-admin-format';
import {
  orderedSessions,
  releaseConfirm,
  seatUsage,
  sessionPerson,
  type SeatSession,
  type SeatTone,
  type SeatsView,
} from '../../../../../lib/tenant-admin-seats';
import { loadSeats, releaseSeat } from '../../../../../lib/tenant-admin-seats-client';

/**
 * Los puestos simultáneos de un nodo: el uso, de quién se hereda el cupo, la inactividad efectiva
 * y quiénes lo ocupan, con "Desconectar" para liberar un puesto. Lo usan Equipo (el admin del
 * nodo) y "Puestos y sesión" del nodo (el superadmin).
 */

export type SeatsState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly view: SeatsView };

/** "Ahora" que avanza solo, para que "hace un momento" no quede congelado en pantalla. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * La vista de puestos de `tenantId`. `reload(true)` refresca sin volver al esqueleto (después de
 * desconectar a alguien o de guardar el cupo), y si falla deja lo que había.
 */
export function useSeatsView(tenantId: string | null): {
  readonly state: SeatsState;
  readonly reload: (quiet?: boolean) => Promise<void>;
} {
  const [state, setState] = useState<SeatsState>({ status: tenantId ? 'loading' : 'idle' });
  // Cambiar de nodo mientras vuelve la respuesta del anterior no debe pintar los puestos ajenos.
  const current = useRef(tenantId);
  current.current = tenantId;

  const reload = useCallback(
    async (quiet = false) => {
      if (tenantId === null || tenantId === '') {
        setState({ status: 'idle' });
        return;
      }
      if (!quiet) setState({ status: 'loading' });
      const res = await loadSeats(tenantId);
      if (current.current !== tenantId) return;
      if (res.ok) setState({ status: 'ready', view: res.data });
      else if (!quiet) setState({ status: 'error', message: res.message });
      else toast.error(res.message);
    },
    [tenantId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
}

const TONE_BAR: Readonly<Record<SeatTone, string>> = {
  ok: 'bg-[var(--color-primary)]',
  warn: 'bg-[var(--color-warning)]',
  full: 'bg-[var(--color-danger)]',
  unlimited: 'bg-[var(--color-primary)]',
};

/** El número grande, la barra y de dónde salen cupo e inactividad. */
export function SeatUsageMeter({ view, labelId }: { view: SeatsView; labelId: string }) {
  const usage = seatUsage(view);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
          {usage.headline}
        </p>
        <p
          className={cn(
            'text-xs',
            usage.tone === 'full'
              ? 'font-medium text-[var(--color-danger)]'
              : 'text-[var(--color-fg-muted)]',
          )}
        >
          {usage.detail}
        </p>
      </div>
      {usage.ratio !== undefined && view.limit !== null ? (
        <div
          role="meter"
          aria-labelledby={labelId}
          aria-valuemin={0}
          aria-valuemax={view.limit}
          aria-valuenow={Math.min(view.inUse, view.limit)}
          aria-valuetext={usage.valueText}
          className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300',
              TONE_BAR[usage.tone],
            )}
            style={{ width: `${Math.round(usage.ratio * 100)}%` }}
          />
        </div>
      ) : null}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-fg-muted)]">
        {usage.shared !== undefined ? (
          <li className="inline-flex items-center gap-1.5">
            <Armchair aria-hidden="true" className="size-3.5" />
            {usage.shared}
          </li>
        ) : null}
        <li className="inline-flex items-center gap-1.5">
          <Timer aria-hidden="true" className="size-3.5" />
          {usage.idle}
        </li>
      </ul>
    </div>
  );
}

function SessionRow({
  session,
  showTenant,
  now,
  busy,
  onRelease,
}: {
  session: SeatSession;
  showTenant: boolean;
  now: number;
  busy: boolean;
  onRelease: () => void;
}) {
  const person = sessionPerson(session);
  const seen = relativeTime(session.lastSeenAt, now);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-fg)]">
          <span className="truncate">{person}</span>
          {session.current ? (
            <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
              Vos
            </span>
          ) : null}
        </p>
        {session.name ? (
          <p className="truncate text-xs text-[var(--color-fg-muted)]">{session.email}</p>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--color-fg-muted)]">
          <Monitor aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{deviceLabel(session.device)}</span>
          {session.ip ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px]">{session.ip}</span>
            </>
          ) : null}
          {seen !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                <span className="sr-only">Última actividad: </span>
                <time dateTime={session.lastSeenAt} title={exactTime(session.lastSeenAt)}>
                  {seen}
                </time>
              </span>
            </>
          ) : null}
          {showTenant && session.tenantName ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{session.tenantName}</span>
            </>
          ) : null}
        </p>
      </div>
      {session.current ? null : (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={onRelease}
          aria-label={`Desconectar a ${person}`}
          className="self-start sm:self-center"
        >
          {busy ? (
            <RefreshCw aria-hidden="true" className="animate-spin" />
          ) : (
            <LogOut aria-hidden="true" />
          )}
          {busy ? 'Desconectando…' : 'Desconectar'}
        </Button>
      )}
    </li>
  );
}

/**
 * La tarjeta completa, con sus estados: cargando, error con "Reintentar" (nunca un "nadie
 * conectado" falso), sin límite, nadie ocupando un puesto y la lista.
 *
 * La lista es de quienes OCUPAN un puesto, no de todos los conectados: los usuarios de plataforma
 * no ocupan, y en un nodo sin límite nadie ocupa (el API no guarda el cupo de esas sesiones). Por
 * eso sin límite no se lista ni se cuenta a nadie, en vez de decir que no hay nadie conectado.
 *
 * `onReleased` avisa a la pantalla que liberó un puesto, para que refresque lo que dependa de las
 * sesiones (en Equipo, el "En línea" de cada miembro).
 */
export function SeatsCard({
  tenantId,
  state,
  reload,
  onReleased,
  title = 'Puestos simultáneos',
  description = 'Cuántas personas pueden estar conectadas a la vez. Al llenarse el cupo, nadie más puede ingresar hasta que se libere un puesto.',
}: {
  tenantId: string;
  state: SeatsState;
  reload: (quiet?: boolean) => Promise<void>;
  onReleased?: () => Promise<void> | void;
  title?: string;
  description?: string;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = useNow();
  const titleId = `seats-title-${tenantId}`;

  async function release(session: SeatSession) {
    if (busyId !== null) return;
    if (!(await confirm({ ...releaseConfirm(session), destructive: true }))) return;
    setBusyId(session.sessionId);
    const res = await releaseSeat(tenantId, session.sessionId);
    setBusyId(null);
    if (res.ok) {
      toast.success(`Desconectamos a ${sessionPerson(session)}. El puesto quedó libre.`);
    } else {
      toast.error(res.message);
    }
    await Promise.all([reload(true), res.ok ? onReleased?.() : undefined]);
  }

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      {confirmDialog}
      <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-[var(--color-fg)]">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{description}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void reload(state.status === 'ready')}
          disabled={state.status === 'loading' || state.status === 'idle'}
          aria-label="Actualizar puestos"
          className="shrink-0 px-2"
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(state.status === 'loading' && 'animate-spin')}
          />
        </Button>
      </div>

      {state.status === 'loading' || state.status === 'idle' ? (
        <div className="space-y-3 px-4 py-4" aria-busy="true" aria-live="polite">
          <span className="sr-only">Cargando puestos…</span>
          <div className="h-7 w-40 animate-pulse rounded bg-[var(--color-surface-muted)]" />
          <div className="h-2 w-full animate-pulse rounded-full bg-[var(--color-surface-muted)]" />
          <div className="h-4 w-64 max-w-full animate-pulse rounded bg-[var(--color-surface-muted)]" />
        </div>
      ) : state.status === 'error' ? (
        <div role="alert" className="px-4 py-6 text-center">
          <p className="text-sm text-[var(--color-fg)]">{state.message}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void reload()}>
            <RefreshCw aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      ) : (
        <>
          <div className="px-4 py-4">
            <SeatUsageMeter view={state.view} labelId={titleId} />
          </div>
          {state.view.limit === null ? (
            <p className="border-t border-[var(--color-border)] px-4 py-3 text-xs text-[var(--color-fg-muted)]">
              Como no hay límite, las sesiones de este nodo no ocupan puesto y no se listan acá.
            </p>
          ) : (
            <div className="border-t border-[var(--color-border)]">
              <h3 className="px-4 pt-3 text-xs font-semibold text-[var(--color-fg-muted)]">
                Ocupan un puesto ahora ({state.view.sessions.length})
              </h3>
              {state.view.sessions.length === 0 ? (
                <p className="px-4 pb-4 pt-2 text-xs text-[var(--color-fg-muted)]">
                  Nadie de este nodo ocupa un puesto ahora.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {orderedSessions(state.view.sessions).map((s) => (
                    <SessionRow
                      key={s.sessionId}
                      session={s}
                      showTenant={s.tenantId !== '' && s.tenantId !== tenantId}
                      now={now}
                      busy={busyId === s.sessionId}
                      onRelease={() => void release(s)}
                    />
                  ))}
                </ul>
              )}
              {state.view.inherited && state.view.sessions.length < state.view.inUse ? (
                <p className="border-t border-[var(--color-border)] px-4 py-2.5 text-xs text-[var(--color-fg-subtle)]">
                  El cupo es compartido: el resto de los puestos en uso son de otros nodos de{' '}
                  {state.view.poolTenantName ?? 'la red'} que no administrás desde acá.
                </p>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
