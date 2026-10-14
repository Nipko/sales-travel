'use client';

import {
  ArrowRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  FlaskConical,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { cn } from '../../lib/cn';
import {
  CHECK_STATE_LABEL,
  READINESS_EMPTY,
  READINESS_EMPTY_ACTION,
  READINESS_ERROR,
  READINESS_FOOTER,
  READINESS_INTRO,
  READINESS_PARTIAL,
  READINESS_READY,
  READINESS_TITLE,
  loadHotelReadiness,
  nodeKindOf,
  omittedLine,
  readinessChecks,
  type HotelReadiness,
  type ReadinessCheck,
  type ReadinessCheckState,
  type ReadinessNode,
} from '../../lib/hotel-readiness';
import { Button } from '../ui/button';
import { ToneBadge, ToneNotice } from '../wallets/wallet-ui';

/*
 * La guía que ve el superadmin en Hoteles, debajo del aviso de que no vende (D-TBO-H1 A): qué
 * sucursal está lista para probar una reserva con un vendedor y qué le falta a cada una, con el
 * enlace para resolverlo. Sólo lee: no cambia la regla ni ofrece vender.
 *
 * El estado y la vista van separados para poder pintar cada caso sin red.
 */

export type HotelTestingGuideState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly data: HotelReadiness };

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]';

const STATE_ICON: Readonly<Record<ReadinessCheckState, typeof CircleCheck>> = {
  ok: CircleCheck,
  missing: CircleX,
  unknown: CircleHelp,
};

const STATE_COLOR: Readonly<Record<ReadinessCheckState, string>> = {
  ok: 'text-[var(--color-success)]',
  missing: 'text-[var(--color-danger)]',
  unknown: 'text-[var(--color-fg-subtle)]',
};

export function HotelTestingGuide() {
  const [state, setState] = useState<HotelTestingGuideState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const data = await loadHotelReadiness();
    setState(data === undefined ? { status: 'error' } : { status: 'ready', data });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return <HotelTestingGuideView state={state} onRetry={() => void load()} />;
}

export function HotelTestingGuideView({
  state,
  onRetry,
}: {
  state: HotelTestingGuideState;
  onRetry: () => void;
}) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={state.status === 'loading'}
      className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xs)] sm:p-8"
    >
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
        <FlaskConical aria-hidden="true" className="size-5" />
      </div>
      <h2 id={titleId} className="text-base font-semibold tracking-tight text-[var(--color-fg)]">
        {READINESS_TITLE}
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
        {READINESS_INTRO}
      </p>

      <div className="mt-5">
        {state.status === 'loading' ? (
          <div className="space-y-3">
            <div className="h-28 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]" />
            <div className="h-28 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]" />
            <span className="sr-only">Revisando las sucursales…</span>
          </div>
        ) : state.status === 'error' ? (
          <RetryNotice tone="danger" role="alert" text={READINESS_ERROR} onRetry={onRetry} />
        ) : (
          <ReadinessList data={state.data} onRetry={onRetry} />
        )}
      </div>

      <p className="mt-5 border-t border-[var(--color-border)] pt-4 text-xs leading-relaxed text-[var(--color-fg-muted)]">
        {READINESS_FOOTER}
      </p>
    </section>
  );
}

function RetryNotice({
  tone,
  role,
  text,
  onRetry,
}: {
  tone: 'danger' | 'warning';
  role: 'alert' | 'status';
  text: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <ToneNotice tone={tone} role={role}>
        {text}
      </ToneNotice>
      <Button variant="secondary" size="sm" onClick={onRetry} className="self-start sm:self-auto">
        <RefreshCw aria-hidden="true" />
        Reintentar
      </Button>
    </div>
  );
}

function ReadinessList({ data, onRetry }: { data: HotelReadiness; onRetry: () => void }) {
  if (data.nodes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
        {READINESS_EMPTY}{' '}
        <Link
          href="/admin/tenants"
          className={cn(
            'rounded font-medium text-[var(--color-fg)] underline underline-offset-4',
            FOCUS_RING,
          )}
        >
          {READINESS_EMPTY_ACTION}
        </Link>
      </p>
    );
  }

  const omitted = omittedLine(data.omitted);
  return (
    <div className="space-y-3">
      {data.partial ? (
        <RetryNotice tone="warning" role="status" text={READINESS_PARTIAL} onRetry={onRetry} />
      ) : null}
      <ul className="space-y-3">
        {data.nodes.map((node) => (
          <li key={node.tenantId}>
            <NodeCard node={node} />
          </li>
        ))}
      </ul>
      {omitted === undefined ? null : (
        <p className="text-xs text-[var(--color-fg-muted)]">{omitted}</p>
      )}
    </div>
  );
}

function NodeCard({ node }: { node: ReadinessNode }) {
  const headingId = useId();
  const kind = nodeKindOf(node);
  return (
    <article
      aria-labelledby={headingId}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3
          id={headingId}
          className="min-w-0 break-words text-sm font-semibold text-[var(--color-fg)]"
        >
          {node.name}
        </h3>
        {kind === undefined ? null : (
          <span className="text-xs text-[var(--color-fg-muted)]">{kind}</span>
        )}
        {node.ready ? <ToneBadge tone="success">{READINESS_READY}</ToneBadge> : null}
      </header>
      <ul className="mt-2 divide-y divide-[var(--color-border)]">
        {readinessChecks(node).map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </ul>
    </article>
  );
}

function CheckRow({ check }: { check: ReadinessCheck }) {
  const Icon = STATE_ICON[check.state];
  return (
    <li className="flex items-start gap-2.5 py-2">
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', STATE_COLOR[check.state])} />
      <div className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-3">
        <p className="text-sm leading-snug text-[var(--color-fg)]">
          <span className="sr-only">{CHECK_STATE_LABEL[check.state]}: </span>
          {check.text}
        </p>
        {check.action === undefined ? null : (
          <Link
            href={check.action.href}
            className={cn(
              'mt-1 inline-flex shrink-0 items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline underline-offset-4 hover:text-[var(--color-primary)] sm:mt-0',
              FOCUS_RING,
            )}
          >
            {check.action.label}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        )}
      </div>
    </li>
  );
}
