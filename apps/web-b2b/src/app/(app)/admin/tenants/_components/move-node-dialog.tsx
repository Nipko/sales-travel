'use client';

import { ArrowDownRight, MoveRight, RefreshCw, Search } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { NodeKindBadge } from '../../../../../components/network/node-kind';
import { Button } from '../../../../../components/ui/button';
import { Dialog } from '../../../../../components/ui/dialog';
import { TextInput } from '../../../../../components/ui/field';
import { cn } from '../../../../../lib/cn';
import { moveNode, type AdminNetworkNode } from '../../../../../lib/tenant-admin-client';
import {
  lineageLabel,
  matchesQuery,
  moveBlockedReason,
  moveSummary,
  moveTargets,
  placementLabel,
} from '../../../../../lib/tenant-network';

/** Con más destinos que esto aparece el buscador. */
const SEARCH_THRESHOLD = 6;

/**
 * Mover un nodo con su subárbol bajo otro padre (D6 A). Sólo ofrece los padres que admite la red
 * (tipo, ciclo y 4 niveles) y, antes de confirmar, dice qué cambia y qué no: lo histórico queda
 * como está y desde el cambio rigen las credenciales, reglas y marca del nuevo padre. Las reservas
 * abiertas las comprueba la base al mover; si las hay, el error llega con su motivo.
 */
export function MoveNodeDialog({
  nodes,
  node,
  initialTargetId,
  onMoved,
  onClose,
}: {
  nodes: readonly AdminNetworkNode[];
  node: AdminNetworkNode;
  initialTargetId?: string;
  onMoved: (target: AdminNetworkNode, moved: number) => void;
  onClose: () => void;
}) {
  const targets = useMemo(() => moveTargets(nodes, node.id), [nodes, node.id]);
  const blocked = moveBlockedReason(nodes, node);
  const [targetId, setTargetId] = useState(
    targets.some((t) => t.id === initialTargetId) ? (initialTargetId ?? '') : '',
  );
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const groupName = useId();
  const summaryId = useId();
  const formId = useId();

  const savingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!savingRef.current) onCloseRef.current();
  }, []);

  const target = targets.find((t) => t.id === targetId);
  const summary = target === undefined ? undefined : moveSummary(nodes, node, target);
  const visible = targets.filter((t) => t.id === targetId || matchesQuery(t, query));

  async function confirm() {
    if (target === undefined || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const res = await moveNode(node.id, target.id);
    savingRef.current = false;
    if (!res.ok) {
      setSaving(false);
      setError(res.message);
      return;
    }
    onMoved(target, res.data.moved);
  }

  return (
    <Dialog
      open
      onClose={close}
      title={`Mover ${node.name}`}
      description="Elegí el nuevo padre. El nodo se mueve con todo lo que cuelga de él."
      className="max-w-lg"
      footer={
        blocked !== undefined ? (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={close}>
              Cerrar
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
              >
                {error}
              </p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={close} disabled={saving}>
                Cancelar
              </Button>
              <Button form={formId} type="submit" disabled={saving || target === undefined}>
                {saving ? (
                  <RefreshCw aria-hidden="true" className="animate-spin" />
                ) : (
                  <MoveRight aria-hidden="true" />
                )}
                {saving ? 'Moviendo…' : 'Mover'}
              </Button>
            </div>
          </div>
        )
      }
    >
      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
        <span className="font-medium text-[var(--color-fg)]">Hoy:</span>{' '}
        {placementLabel(nodes, node)}
      </p>

      {blocked !== undefined ? (
        <>
          <p
            role="note"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-fg)]"
          >
            {blocked}
          </p>
        </>
      ) : (
        <form
          id={formId}
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
          className="space-y-4"
        >
          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-[var(--color-fg)]">
              Nuevo padre
            </legend>
            {targets.length > SEARCH_THRESHOLD ? (
              <div className="relative mb-2">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
                />
                <TextInput
                  type="search"
                  aria-label="Buscar el nuevo padre por nombre o slug"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar por nombre o slug…"
                  className="pl-9"
                />
              </div>
            ) : null}
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
              {visible.length === 0 ? (
                <p className="px-1 py-3 text-xs text-[var(--color-fg-muted)]">
                  Ningún destino coincide con la búsqueda.
                </p>
              ) : (
                visible.map((t) => {
                  const checked = t.id === targetId;
                  return (
                    <label
                      key={t.id}
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
                        name={groupName}
                        value={t.id}
                        checked={checked}
                        onChange={() => setTargetId(t.id)}
                        aria-describedby={checked ? summaryId : undefined}
                        className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)] focus-visible:outline-none"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-[var(--color-fg)]">
                            {t.name}
                          </span>
                          <NodeKindBadge node={t} />
                          {t.status !== 'active' ? (
                            <span className="text-[11px] text-[var(--color-danger)]">
                              Suspendido
                            </span>
                          ) : null}
                        </span>
                        {t.parentTenantId !== null ? (
                          <span className="mt-0.5 block truncate text-[11px] text-[var(--color-fg-muted)]">
                            {lineageLabel(nodes, t.id)}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </fieldset>

          {summary !== undefined ? (
            <section
              id={summaryId}
              aria-label="Qué pasa al mover"
              className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-3 py-3"
            >
              <p className="flex items-start gap-1 text-xs text-[var(--color-fg)]">
                <ArrowDownRight
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]"
                />
                <span>
                  <span className="font-medium">Queda:</span> {summary.after}
                </span>
              </p>
              <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                {summary.consequences.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}
