'use client';

import { useId } from 'react';
import { cn } from '../../lib/cn';
import {
  CREATABLE_KIND_HINT,
  CREATABLE_KIND_LABEL,
  NODE_KIND_BADGE,
  NODE_KIND_LABEL,
  nodeKind,
  type CreatableKind,
  type NetworkNode,
} from '../../lib/tenant-network';

/** El tipo de un nodo como distintivo: Plataforma, Consolidador, Agencia, Sucursal, Sub-agencia. */
export function NodeKindBadge({
  node,
  className,
}: {
  node: Pick<NetworkNode, 'tenantType' | 'isBranch'>;
  className?: string;
}) {
  const kind = nodeKind(node);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
        kind === undefined
          ? 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'
          : NODE_KIND_BADGE[kind],
        className,
      )}
    >
      {kind === undefined ? 'Nodo' : NODE_KIND_LABEL[kind]}
    </span>
  );
}

/**
 * Qué tipo de nodo crear. Con una sola opción no hay nada que elegir: se dice cuál va a ser y
 * por qué, en vez de un selector con un único valor.
 */
export function NodeKindPicker({
  kinds,
  value,
  onChange,
}: {
  kinds: readonly CreatableKind[];
  value: CreatableKind | undefined;
  onChange: (kind: CreatableKind) => void;
}) {
  const name = useId();
  if (kinds.length === 0) return null;
  if (kinds.length === 1) {
    const only = kinds[0]!;
    return (
      <div className="space-y-1">
        <p className="text-xs font-semibold text-[var(--color-fg)]">Tipo</p>
        <p className="text-sm text-[var(--color-fg)]">{CREATABLE_KIND_LABEL[only]}</p>
        <p className="text-xs text-[var(--color-fg-muted)]">{CREATABLE_KIND_HINT[only]}</p>
      </div>
    );
  }
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-semibold text-[var(--color-fg)]">Tipo</legend>
      <div className="grid gap-2">
        {kinds.map((kind) => {
          const checked = value === kind;
          return (
            <label
              key={kind}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]/30',
                checked
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/[0.04]'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]',
              )}
            >
              <input
                type="radio"
                name={name}
                value={kind}
                checked={checked}
                onChange={() => onChange(kind)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)] focus-visible:outline-none"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--color-fg)]">
                  {CREATABLE_KIND_LABEL[kind]}
                </span>
                <span className="block text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  {CREATABLE_KIND_HINT[kind]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
