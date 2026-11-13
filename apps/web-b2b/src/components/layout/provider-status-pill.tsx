'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { verticalLabel } from '../../lib/platform-health';
import { providerLabel } from '../../lib/platform-system';

type Kind = 'ok' | 'provider' | 'paused' | 'internal' | 'idle';

interface ProviderStatus {
  readonly providerCode: string;
  readonly vertical: string;
  readonly status: Kind;
  readonly message: string;
}

const KINDS: readonly Kind[] = ['ok', 'provider', 'paused', 'internal', 'idle'];
/** Lo más grave manda en la pastilla. */
const SEVERITY: Record<Kind, number> = { internal: 4, provider: 3, paused: 2, ok: 1, idle: 0 };

const DOT: Record<Kind, string> = {
  ok: 'bg-[var(--color-success)]',
  idle: 'bg-[var(--color-fg-subtle)]',
  paused: 'bg-[var(--color-warning)]',
  provider: 'bg-[var(--color-warning)]',
  internal: 'bg-[var(--color-danger)]',
};

const LABEL: Record<Kind, string> = {
  ok: 'Operando',
  idle: 'Sin uso reciente',
  paused: 'En pausa',
  provider: 'Falla del proveedor',
  internal: 'Falla nuestra',
};

const PILL: Record<Kind, string> = {
  ok: 'Proveedores operando',
  idle: 'Proveedores operando',
  paused: 'Un proveedor en pausa',
  provider: 'Falla de un proveedor',
  internal: 'Falla en la plataforma',
};

/** Cada cuánto se vuelve a mirar: es una lectura barata, sin llamadas a proveedores. */
const REFRESH_MS = 120_000;

export function parseProviderStatus(body: unknown): ProviderStatus[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { providers?: unknown }).providers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): ProviderStatus[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const r = raw as Record<string, unknown>;
    const status = r['status'];
    if (
      typeof r['providerCode'] !== 'string' ||
      typeof r['vertical'] !== 'string' ||
      typeof status !== 'string' ||
      !KINDS.includes(status as Kind)
    ) {
      return [];
    }
    return [
      {
        providerCode: r['providerCode'],
        vertical: r['vertical'],
        status: status as Kind,
        message: typeof r['message'] === 'string' ? r['message'] : '',
      },
    ];
  });
}

/** El estado más grave de la lista: es el que dice la pastilla. */
export function worstStatus(providers: readonly { status: Kind }[]): Kind {
  return providers.reduce<Kind>(
    (acc, p) => (SEVERITY[p.status] > SEVERITY[acc] ? p.status : acc),
    'idle',
  );
}

/**
 * El estado de los proveedores que usa la agencia, en la barra superior: un punto y una frase. Al
 * abrirlo, cada proveedor con lo que le pasa y de quién depende («falla del proveedor», «en pausa
 * por Planetour», «falla nuestra»). Sin proveedores usados, no se pinta.
 */
export function ProviderStatusPill() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);

  useEffect(() => {
    let vigente = true;
    async function load() {
      try {
        const res = await fetch('/api/provider-status', { cache: 'no-store' });
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (vigente) setProviders(parseProviderStatus(body));
      } catch {
        // Un indicador no puede romper la pantalla: si no responde, se queda como estaba.
      }
    }
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      vigente = false;
      clearInterval(timer);
    };
  }, []);

  if (providers.length === 0) return null;
  const worst = worstStatus(providers);

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Estado de los proveedores: ${PILL[worst]}`}
          className={cn(
            'flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-surface-muted)]',
            worst === 'internal'
              ? 'border-[var(--color-danger)]/40 text-[var(--color-fg)]'
              : worst === 'provider' || worst === 'paused'
                ? 'border-[var(--color-warning)]/50 text-[var(--color-fg)]'
                : 'border-[var(--color-border)] text-[var(--color-fg-muted)]',
          )}
        >
          <span className="relative flex size-2">
            {worst === 'ok' || worst === 'idle' ? null : (
              <span
                aria-hidden="true"
                className={cn('absolute inset-0 animate-ping rounded-full opacity-60', DOT[worst])}
              />
            )}
            <span aria-hidden="true" className={cn('relative size-2 rounded-full', DOT[worst])} />
          </span>
          <span className="hidden lg:inline">{PILL[worst]}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-80 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-lg)]"
        >
          <p className="text-sm font-semibold text-[var(--color-fg)]">Estado de los proveedores</p>
          <ul className="mt-2 space-y-2.5">
            {providers.map((p) => (
              <li key={`${p.providerCode}-${p.vertical}`} className="flex items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[p.status])}
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[var(--color-fg)]">
                    {providerLabel(p.providerCode)} · {verticalLabel(p.vertical)}{' '}
                    <span className="font-normal text-[var(--color-fg-muted)]">
                      — {LABEL[p.status]}
                    </span>
                  </p>
                  <p className="text-xs text-[var(--color-fg-muted)]">{p.message}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-fg-subtle)]">
            Según las búsquedas de toda la red en las últimas 6 horas.
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
