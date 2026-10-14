import { ArrowRight, CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { Button } from '../../../../../../components/ui/button';
import { ToneBadge } from '../../../../../../components/wallets/wallet-ui';
import { cn } from '../../../../../../lib/cn';
import {
  SEVERITY_LABEL,
  type AttentionItem,
  type Severity,
} from '../../../../../../lib/platform-overview';
import type { Tone } from '../../../../../../lib/wallets';

const SEVERITY_TONE: Readonly<Record<Severity, Tone>> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

const SEVERITY_ICON = { critical: OctagonAlert, warning: TriangleAlert, info: Info } as const;

/**
 * El ícono acompaña a la etiqueta escrita ("Urgente", "Revisar", "Aviso"): la severidad nunca va
 * sólo en el color. El amarillo de advertencia se oscurece hacia la tinta para que el ícono se vea
 * sobre la superficie clara.
 */
const SEVERITY_ICON_SURFACE: Readonly<Record<Severity, string>> = {
  critical: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]',
  warning:
    'bg-[var(--color-warning)]/15 text-[color-mix(in_oklch,var(--color-warning),var(--color-fg)_40%)]',
  info: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
};

/**
 * Requiere tu atención: un renglón por tema, de lo más grave a lo menos. Cada uno dice qué pasa en
 * una frase y, si hay adónde ir, el único paso siguiente. Sin temas, "Todo en orden".
 */
export function AttentionList({ items }: { items: readonly AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 shadow-[var(--shadow-xs)] sm:px-5"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-success)]/12 text-[var(--color-success)]"
        >
          <CircleCheck className="size-4" />
        </span>
        <p className="text-sm text-[var(--color-fg)]">
          Todo en orden. No hay nada que requiera tu atención.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
      {items.map((item) => (
        <AttentionRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const Icon = SEVERITY_ICON[item.severity];
  return (
    <li className="flex gap-3 px-4 py-4 sm:px-5">
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md',
          SEVERITY_ICON_SURFACE[item.severity],
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{item.title}</h3>
            <ToneBadge tone={SEVERITY_TONE[item.severity]}>
              {SEVERITY_LABEL[item.severity]}
            </ToneBadge>
          </div>
          <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">{item.summary}</p>
          {item.details.length > 0 ? (
            <ul className="space-y-0.5 pt-0.5 text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {item.details.map((line, i) => (
                <li key={`${i}-${line}`} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-[var(--color-fg-subtle)]"
                  />
                  <span className="min-w-0 break-words">{line}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {item.entries !== undefined && item.entries.length > 0 ? (
            <ul
              aria-label={item.title}
              className="mt-2 divide-y divide-[var(--color-border)] overflow-hidden rounded-md border border-[var(--color-border)]"
            >
              {item.entries.map((entry) => (
                <li
                  key={entry.key}
                  className="flex flex-col gap-0.5 px-3 py-2 text-xs sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
                >
                  {entry.href !== undefined ? (
                    <Link
                      href={entry.href}
                      className="min-w-0 break-words font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    >
                      {entry.text}
                    </Link>
                  ) : (
                    <span className="min-w-0 break-words font-medium text-[var(--color-fg)]">
                      {entry.text}
                    </span>
                  )}
                  {entry.meta !== undefined ? (
                    <span className="shrink-0 text-[var(--color-fg-muted)]">{entry.meta}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {item.action !== undefined ? (
          <Button asChild variant="secondary" size="sm" className="self-start">
            <Link href={item.action.href}>
              {item.action.label}
              {/* "Ver todas" suelto no dice de qué: el lector de pantalla oye también el tema. */}
              <span className="sr-only"> · {item.title}</span>
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </div>
    </li>
  );
}
