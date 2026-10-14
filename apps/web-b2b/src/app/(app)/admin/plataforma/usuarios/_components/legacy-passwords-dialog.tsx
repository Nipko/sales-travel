'use client';

import { CircleAlert, KeyRound, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../../components/ui/button';
import { Dialog, useConfirm } from '../../../../../../components/ui/dialog';
import { cn } from '../../../../../../lib/cn';
import {
  LEGACY_DIALOG_COPY,
  legacyAccountName,
  legacyConfirmCopy,
  legacyDoneMessage,
  legacyProgressLabel,
  legacyResultView,
  legacySubmitLabel,
  requireLegacyResets,
  type LegacyAccount,
  type LegacyAccountsList,
  type LegacyResetResult,
  type LegacyResetRun,
  type LegacyResultTone,
} from '../../../../../../lib/legacy-passwords';
import { isStepUpCancelled } from '../../../../../../lib/step-up';
import { exactTime, lastAccessLabel } from '../../../../../../lib/tenant-admin-format';
import { useNow } from '../../../usuarios/_components/seats-ui';

/**
 * Cuentas heredadas con una contraseña que eligió un admin (USR-14, founder D3 = B): el aviso en
 * Plataforma → Usuarios y el diálogo para revisarlas, elegir a cuáles forzarles el cambio y ver qué
 * pasó con cada una.
 */

/** Texto -700/-800 sobre fondo -50, como los estados del directorio: más de 4.5:1 a 12px. */
const TONE: Readonly<Record<LegacyResultTone, string>> = {
  ok: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
  muted: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
};

/** El aviso arriba del directorio, con "Revisarlas". Sin cuentas no se pinta. */
export function LegacyPasswordsCallout({ text, onReview }: { text: string; onReview: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2.5 text-sm text-[var(--color-fg)]">
        <KeyRound
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-[color-mix(in_oklab,var(--color-warning)_60%,var(--color-fg))]"
        />
        <span>{text}</span>
      </p>
      <Button variant="secondary" size="sm" className="self-start sm:self-auto" onClick={onReview}>
        Revisarlas
      </Button>
    </div>
  );
}

/** Dónde nació la cuenta y quién eligió la contraseña. */
export function legacyOriginLine(account: LegacyAccount): string {
  const date = exactTime(account.createdAt) ?? '';
  const by = account.origin.createdByEmail;
  return by === null
    ? `Creada en ${account.origin.tenantName} · ${date}`
    : `Creada por ${by} en ${account.origin.tenantName} · ${date}`;
}

function activeNodesLabel(n: number): string {
  if (n === 0) return 'Sin accesos activos';
  return n === 1 ? '1 nodo activo' : `${n} nodos activos`;
}

/** La lista con una casilla por cuenta y "Seleccionar todas". */
export function LegacyAccountsSelection({
  accounts,
  selected,
  now,
  disabled,
  onToggle,
  onToggleAll,
}: {
  accounts: readonly LegacyAccount[];
  selected: ReadonlySet<string>;
  now: number;
  disabled: boolean;
  onToggle: (id: string) => void;
  onToggleAll: (all: boolean) => void;
}) {
  const listId = useId();
  const allRef = useRef<HTMLInputElement>(null);
  const chosen = accounts.filter((a) => selected.has(a.id)).length;
  const all = chosen === accounts.length && accounts.length > 0;
  const some = chosen > 0 && !all;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = some;
  }, [some]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--color-fg)]">
          <input
            ref={allRef}
            type="checkbox"
            checked={all}
            disabled={disabled}
            aria-controls={listId}
            onChange={(e) => onToggleAll(e.target.checked)}
            className="size-4 rounded border-[var(--color-border)] accent-[var(--color-primary)]"
          />
          {LEGACY_DIALOG_COPY.selectAll}
        </label>
        <p className="text-xs text-[var(--color-fg-muted)]" aria-live="polite">
          {chosen} de {accounts.length} elegidas
        </p>
      </div>
      <ul id={listId} className="divide-y divide-[var(--color-border)]">
        {accounts.map((a) => {
          const name = legacyAccountName(a);
          return (
            <li key={a.id}>
              <label className="flex cursor-pointer items-start gap-3 py-2.5">
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  disabled={disabled}
                  onChange={() => onToggle(a.id)}
                  className="mt-0.5 size-4 shrink-0 rounded border-[var(--color-border)] accent-[var(--color-primary)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                    {name}
                  </span>
                  {name !== a.email ? (
                    <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                      {a.email}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block text-[11px] text-[var(--color-fg-muted)]">
                    {legacyOriginLine(a)}
                  </span>
                  <span className="block text-[11px] text-[var(--color-fg-muted)]">
                    {a.lastLoginAt === null
                      ? 'Nunca ingresó'
                      : `Último ingreso: ${lastAccessLabel(a.lastLoginAt, now)}`}{' '}
                    · {activeNodesLabel(a.activeNodes)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Qué pasó con cada cuenta, con el resumen arriba. */
export function LegacyResetResults({
  accounts,
  run,
}: {
  accounts: readonly LegacyAccount[];
  run: LegacyResetRun;
}) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm font-medium text-[var(--color-fg)]">
        {legacyDoneMessage(run)}
      </p>
      {run.error !== null ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-fg)]"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0 text-[var(--color-danger)]"
          />
          <span>{run.error}</span>
        </p>
      ) : null}
      <ul className="divide-y divide-[var(--color-border)]">
        {run.results.map((r: LegacyResetResult) => {
          const account = byId.get(r.userId);
          const view = legacyResultView(r);
          return (
            <li
              key={r.userId}
              className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                  {account === undefined ? r.userId : legacyAccountName(account)}
                </span>
                {account !== undefined && legacyAccountName(account) !== account.email ? (
                  <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                    {account.email}
                  </span>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-col gap-1 sm:max-w-[55%] sm:items-end sm:text-right">
                <span
                  className={cn(
                    'inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-medium',
                    TONE[view.tone],
                  )}
                >
                  {view.label}
                </span>
                {view.hint !== null ? (
                  <span className="text-[11px] text-[var(--color-fg-muted)]">{view.hint}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Phase =
  | { readonly kind: 'select' }
  | { readonly kind: 'running'; readonly done: number; readonly total: number }
  | { readonly kind: 'done'; readonly run: LegacyResetRun };

/**
 * Revisar las cuentas heredadas y forzarles el cambio. Todas vienen elegidas; se confirma con lo que
 * corta (destructivo) y, si el 2FA no es de los últimos minutos, se pide el código en el medio
 * (USR-13). Mientras corre no se cierra. Al terminar muestra qué pasó con cada una y avisa con
 * `onFinished` para que el aviso del directorio se vuelva a contar.
 */
export function LegacyPasswordsDialog({
  list,
  onClose,
  onFinished,
}: {
  list: LegacyAccountsList;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(list.users.map((u) => u.id)),
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'select' });
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const running = phase.kind === 'running';
  const chosen = list.users.filter((u) => selected.has(u.id)).map((u) => u.id);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (running || chosen.length === 0) return;
    const ok = await confirm({ ...legacyConfirmCopy(chosen.length), destructive: true });
    if (!ok) return;
    setError(null);
    setPhase({ kind: 'running', done: 0, total: chosen.length });
    const res = await requireLegacyResets(chosen, (done) =>
      setPhase({ kind: 'running', done, total: chosen.length }),
    );
    if (isStepUpCancelled(res)) {
      setPhase({ kind: 'select' });
      return;
    }
    if (!res.ok) {
      setPhase({ kind: 'select' });
      setError(res.message);
      return;
    }
    setPhase({ kind: 'done', run: res.data });
    const clean = res.data.error === null && res.data.results.every((r) => r.status !== 'failed');
    const message = legacyDoneMessage(res.data);
    if (clean) toast.success(message);
    else toast.warning(message);
    onFinished();
  }

  const footer =
    phase.kind === 'done' ? (
      <div className="flex justify-end">
        {/* El botón que forzó ya no está: sin esto el foco cae al fondo y el teclado se pierde. */}
        <Button variant="secondary" onClick={onClose} autoFocus>
          {LEGACY_DIALOG_COPY.close}
        </Button>
      </div>
    ) : (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" disabled={running} onClick={onClose}>
          {LEGACY_DIALOG_COPY.cancel}
        </Button>
        <Button
          variant="danger"
          disabled={running || chosen.length === 0}
          onClick={() => void submit()}
        >
          {running ? <RefreshCw aria-hidden="true" className="animate-spin" /> : null}
          {running
            ? legacyProgressLabel(phase.done, phase.total)
            : legacySubmitLabel(chosen.length)}
        </Button>
      </div>
    );

  return (
    <>
      <Dialog
        open
        onClose={running ? () => undefined : onClose}
        title={LEGACY_DIALOG_COPY.title}
        description={phase.kind === 'done' ? undefined : LEGACY_DIALOG_COPY.description}
        className="max-w-2xl"
        footer={footer}
      >
        {phase.kind === 'done' ? (
          <LegacyResetResults accounts={list.users} run={phase.run} />
        ) : list.users.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-muted)]">
            {LEGACY_DIALOG_COPY.empty}
          </p>
        ) : (
          <div className="space-y-3">
            {list.truncated ? (
              <p className="text-xs text-[var(--color-fg-muted)]">{LEGACY_DIALOG_COPY.truncated}</p>
            ) : null}
            {error !== null ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-fg)]"
              >
                <CircleAlert
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-[var(--color-danger)]"
                />
                <span>{error}</span>
              </p>
            ) : null}
            {running ? (
              <p className="sr-only" aria-live="polite">
                {legacyProgressLabel(phase.done, phase.total)}
              </p>
            ) : null}
            <LegacyAccountsSelection
              accounts={list.users}
              selected={selected}
              now={now}
              disabled={running}
              onToggle={toggle}
              onToggleAll={(all) => setSelected(new Set(all ? list.users.map((u) => u.id) : []))}
            />
          </div>
        )}
      </Dialog>
      {confirmDialog}
    </>
  );
}
