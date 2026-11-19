'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { SegmentedControl } from '../../../../../../components/ui/segmented-control';
import { ToneBadge } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import {
  OWNER_LABEL,
  PENDING_LABEL,
  PENDING_TONE,
  daysOpenLabel,
  pendingsFor,
  sinceLabel,
  type OwnerFilter,
  type Pending,
} from '../../../../../../lib/platform-status';

const FILTERS: readonly { value: OwnerFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'founder', label: 'Founder' },
  { value: 'claude', label: 'Claude' },
];

/** Los pendientes del proyecto: qué, desde cuándo, quién hace qué y dónde está escrito. */
export function PendingsPanel({ pendings }: { pendings: readonly Pending[] }) {
  const [owner, setOwner] = useState<OwnerFilter>('all');
  const shown = pendingsFor(pendings, owner);

  return (
    <section aria-labelledby="estado-pendientes" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="estado-pendientes" className="text-base font-semibold text-[var(--color-fg)]">
            Pendientes del proyecto
          </h2>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Gestiones con proveedores, decisiones y deudas con fecha. Lo que se mide solo está
            arriba.
          </p>
        </div>
        <SegmentedControl
          legend="Filtrar por responsable"
          value={owner}
          onChange={setOwner}
          options={FILTERS.map((f) => ({
            value: f.value,
            label: f.label,
            count: pendingsFor(pendings, f.value).length,
          }))}
        />
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
          No hay pendientes para {owner === 'all' ? 'nadie' : OWNER_LABEL[owner]}.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {shown.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:gap-5">
              <div className="flex shrink-0 flex-row items-center gap-2 sm:w-32 sm:flex-col sm:items-start">
                <ToneBadge tone={PENDING_TONE[p.level]}>{PENDING_LABEL[p.level]}</ToneBadge>
                <span className="text-xs text-[var(--color-fg-muted)]">
                  <time dateTime={p.since}>{sinceLabel(p.since)}</time>
                  <span className="block font-medium tabular-nums text-[var(--color-fg)]">
                    {daysOpenLabel(p.daysOpen)}
                  </span>
                </span>
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <h3 className="text-sm font-semibold text-[var(--color-fg)]">{p.title}</h3>
                <p className="text-sm text-[var(--color-fg-muted)]">{p.why}</p>
                <ul className="space-y-1">
                  {p.steps.map((s) => (
                    <li key={`${s.owner}-${s.text}`} className="flex gap-2 text-sm">
                      <span
                        className={cn(
                          'mt-0.5 inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-semibold',
                          s.owner === 'founder'
                            ? 'bg-[var(--color-primary)]/12 text-[var(--color-primary)]'
                            : 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]',
                        )}
                      >
                        {OWNER_LABEL[s.owner]}
                      </span>
                      <span className="text-[var(--color-fg)]">{s.text}</span>
                    </li>
                  ))}
                </ul>
                {p.links.length > 0 ? (
                  <p className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                    {p.links.map((l) => (
                      <a
                        key={l.href}
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                      >
                        {l.label}
                        <ExternalLink className="size-3" aria-hidden="true" />
                        <span className="sr-only"> (se abre en otra pestaña)</span>
                      </a>
                    ))}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
