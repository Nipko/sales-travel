import { ArrowRight } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { ToneBadge } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import {
  LEVEL_LABEL,
  LEVEL_TONE,
  OVERALL_HEADLINE,
  shortVersion,
  type PlatformStatus,
  type StatusLevel,
} from '../../../../../../lib/platform-status';
import { PendingsPanel } from './pendings-panel';

const STRIPE: Record<StatusLevel, string> = {
  ok: 'bg-[var(--color-success)]',
  warn: 'bg-[var(--color-warning)]',
  critical: 'bg-[var(--color-danger)]',
};

const BANNER: Record<StatusLevel, string> = {
  ok: 'border-[var(--color-success)]/35 bg-[var(--color-success)]/10',
  warn: 'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/12',
  critical: 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/8',
};

const BOGOTA = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : BOGOTA.format(at);
}

/**
 * El tablero: arriba el veredicto, después un semáforo por área (lo roto primero) con el enlace a la
 * pantalla que tiene el detalle, los pendientes del proyecto y la versión que corre.
 */
export function PlatformStatusBoard({ status }: { status: PlatformStatus }) {
  const rank: Record<StatusLevel, number> = { critical: 0, warn: 1, ok: 2 };
  const areas = [...status.areas].sort((a, b) => rank[a.level] - rank[b.level]);
  const attention = areas.filter((a) => a.level !== 'ok').length;

  return (
    <div className="space-y-8">
      <div
        role={status.overall === 'ok' ? 'status' : 'alert'}
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3',
          BANNER[status.overall],
        )}
      >
        <p className="text-sm font-semibold text-[var(--color-fg)]">
          {OVERALL_HEADLINE[status.overall]}
          {attention > 0 ? (
            <span className="font-normal text-[var(--color-fg-muted)]">
              {' '}
              · {attention === 1 ? '1 área' : `${String(attention)} áreas`} para mirar
            </span>
          ) : null}
        </p>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Leído el <time dateTime={status.generatedAt}>{when(status.generatedAt)}</time>
        </p>
      </div>

      <section aria-labelledby="estado-areas">
        <h2 id="estado-areas" className="sr-only">
          Áreas de la plataforma
        </h2>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {areas.map((a) => (
            <li
              key={a.id}
              className="relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 pl-5"
            >
              <span
                aria-hidden="true"
                className={cn('absolute inset-y-0 left-0 w-1', STRIPE[a.level])}
              />
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-[var(--color-fg)]">{a.label}</h3>
                <ToneBadge tone={LEVEL_TONE[a.level]}>{LEVEL_LABEL[a.level]}</ToneBadge>
              </div>
              <p className="text-sm text-[var(--color-fg)]">{a.summary}</p>
              {a.details.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  {a.details.map((d) => (
                    <li key={d} className="break-words">
                      {d}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Link
                href={a.href as Route}
                className="mt-auto inline-flex items-center gap-1 self-start rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
              >
                Ver detalle
                <span className="sr-only"> de {a.label}</span>
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <PendingsPanel pendings={status.pendings} />

      <footer className="border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-fg-muted)]">
        Versión desplegada{' '}
        <span className="font-mono text-[var(--color-fg)]">
          {shortVersion(status.runtime.version)}
        </span>
        , corriendo desde el{' '}
        <time dateTime={status.runtime.startedAt}>{when(status.runtime.startedAt)}</time>. Los
        pendientes del proyecto se cambian por PR en{' '}
        <span className="font-mono">apps/api/src/admin-console/project-pendings.ts</span>.
      </footer>
    </div>
  );
}
