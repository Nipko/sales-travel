'use client';

import { ArrowLeft, RefreshCw, Save, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { useViewer } from '../../../../../../components/layout/viewer-context';
import { Button } from '../../../../../../components/ui/button';
import { Field, Select, TextInput } from '../../../../../../components/ui/field';
import { cn } from '../../../../../../lib/cn';
import { loadAdminNetwork, type AdminNetworkNode } from '../../../../../../lib/tenant-admin-client';
import {
  SEATS_MAX,
  SEATS_MIN,
  DEFAULT_IDLE_MINUTES,
  idleChoices,
  idleLabel,
  inheritIdleLabel,
  inheritSeatsLabel,
  loweredSeatsNotice,
  seatPolicyChanged,
  seatPolicyDraftOf,
  seatPolicyPayload,
  seatPolicySavedMessage,
  validateSeatPolicy,
  type SeatPolicyDraft,
  type SeatsView,
} from '../../../../../../lib/tenant-admin-seats';
import { saveSeatPolicy } from '../../../../../../lib/tenant-admin-seats-client';
import { SeatsCard, useSeatsView } from '../../../usuarios/_components/seats-ui';
import { NodeSectionNav } from './node-section-nav';

type NodeInfo =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly node: AdminNetworkNode };

/**
 * "Puestos y sesión" de un nodo, para el superadmin (decisiones del founder, 2026-09-29): cuántas
 * sesiones simultáneas admite (o si comparte el cupo de su padre) y a los cuántos minutos sin
 * actividad se cierran, con el uso de hoy y quiénes lo ocupan.
 */
export function SeatsSettingsPanel({ tenantId }: { tenantId: string }) {
  const { superadmin } = useViewer();
  const seats = useSeatsView(tenantId);
  const [info, setInfo] = useState<NodeInfo>({ status: 'loading' });

  // El nombre del nodo y de su padre salen de la red del superadmin: la vista de puestos sólo
  // nombra al dueño del cupo, y la opción "Heredar de …" tiene que decir de quién.
  useEffect(() => {
    let alive = true;
    void loadAdminNetwork().then((res) => {
      if (!alive) return;
      const node = res.ok ? res.data.find((n) => n.id === tenantId) : undefined;
      setInfo(node === undefined ? { status: 'missing' } : { status: 'ready', node });
    });
    return () => {
      alive = false;
    };
  }, [tenantId]);

  const node = info.status === 'ready' ? info.node : undefined;
  const nodeName = node?.name ?? 'Nodo';
  // Sin la red no sabemos si tiene padre: se nombra genérico en vez de decir "sin límite".
  const parentName =
    node === undefined
      ? 'su nodo padre'
      : node.parentTenantId === null
        ? null
        : (node.parentName ?? 'su nodo padre');

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <Link
        href="/admin/tenants"
        className="mb-4 inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg-muted)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Agencias
      </Link>

      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
          {info.status === 'loading' ? (
            <span className="inline-block h-7 w-48 animate-pulse rounded bg-[var(--color-surface-muted)] align-middle" />
          ) : (
            nodeName
          )}
        </h1>
        <p className="max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
          Cuántas personas pueden estar conectadas a la vez y cuándo se cierra una sesión inactiva.
          Un nodo sin cupo propio comparte el de su padre; los usuarios de plataforma no ocupan
          puesto.
        </p>
      </header>

      <NodeSectionNav tenantId={tenantId} current="seats" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <section aria-labelledby="seat-policy-title" className="space-y-3">
          <h2 id="seat-policy-title" className="text-sm font-semibold text-[var(--color-fg)]">
            Puestos y sesión
          </h2>
          {!superadmin ? (
            <p
              role="note"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-xs text-[var(--color-fg-muted)]"
            >
              Sólo el superadmin fija los puestos y la inactividad de un nodo.
            </p>
          ) : seats.state.status === 'ready' ? (
            <SeatPolicyForm
              // Tras guardar, el borrador vuelve a salir de lo guardado.
              key={`${seats.state.view.ownSeats ?? 'h'}-${seats.state.view.ownIdleTimeoutMinutes ?? 'h'}`}
              tenantId={tenantId}
              view={seats.state.view}
              nodeName={nodeName}
              parentName={parentName}
              onSaved={() => seats.reload(true)}
            />
          ) : seats.state.status === 'error' ? (
            <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-xs text-[var(--color-fg-muted)]">
              Para editar hace falta leer primero los puestos del nodo. Reintentá desde “Uso
              actual”.
            </p>
          ) : (
            <div
              aria-busy="true"
              className="h-72 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
            />
          )}
        </section>

        <SeatsCard
          tenantId={tenantId}
          state={seats.state}
          reload={seats.reload}
          title="Uso actual"
          description="Quiénes ocupan un puesto de este nodo ahora. Desconectar a alguien libera su puesto al instante."
        />
      </div>
    </div>
  );
}

function SeatPolicyForm({
  tenantId,
  view,
  nodeName,
  parentName,
  onSaved,
}: {
  tenantId: string;
  view: SeatsView;
  nodeName: string;
  parentName: string | null;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<SeatPolicyDraft>(() => seatPolicyDraftOf(view));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const seatsId = useId();
  const seatsHintId = `${seatsId}-hint`;
  const seatsErrorId = `${seatsId}-error`;

  const errors = submitted ? validateSeatPolicy(draft) : {};
  const changed = seatPolicyChanged(draft, view);
  const lowered = loweredSeatsNotice(draft, view);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSubmitted(true);
    setServerError('');
    const payload = seatPolicyPayload(draft);
    if (payload === undefined) return;
    setSaving(true);
    const res = await saveSeatPolicy(tenantId, payload);
    if (!res.ok) {
      setSaving(false);
      setServerError(res.message);
      return;
    }
    toast.success(seatPolicySavedMessage(payload, nodeName));
    await onSaved();
    setSaving(false);
  }

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5"
    >
      <fieldset className="space-y-2" aria-describedby={seatsHintId}>
        <legend className="text-xs font-semibold text-[var(--color-fg)]">
          Puestos simultáneos
        </legend>
        <p id={seatsHintId} className="text-xs text-[var(--color-fg-muted)]">
          Sesiones abiertas a la vez, contando las de los nodos de abajo que no tengan cupo propio.
        </p>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-sm has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[var(--color-primary)]/5">
          <input
            type="radio"
            name="seats-mode"
            value="inherit"
            checked={draft.seatsMode === 'inherit'}
            onChange={() => setDraft((d) => ({ ...d, seatsMode: 'inherit' }))}
            className="mt-0.5 accent-[var(--color-primary)]"
          />
          <span className="text-[var(--color-fg)]">{inheritSeatsLabel(view, parentName)}</span>
        </label>
        <div
          className={cn(
            'rounded-lg border px-3 py-2.5',
            draft.seatsMode === 'own'
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
              : 'border-[var(--color-border)]',
          )}
        >
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="radio"
              name="seats-mode"
              value="own"
              checked={draft.seatsMode === 'own'}
              onChange={() => setDraft((d) => ({ ...d, seatsMode: 'own' }))}
              className="mt-0.5 accent-[var(--color-primary)]"
            />
            <span className="text-[var(--color-fg)]">Cupo propio</span>
          </label>
          <div className="mt-2 pl-6">
            <label htmlFor={seatsId} className="sr-only">
              Cantidad de puestos simultáneos
            </label>
            <TextInput
              id={seatsId}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              value={draft.seats}
              placeholder={`${SEATS_MIN} a ${SEATS_MAX.toLocaleString('es-CO')}`}
              aria-invalid={errors.seats !== undefined}
              aria-describedby={errors.seats !== undefined ? seatsErrorId : undefined}
              // Pasa a "Cupo propio" al escribir, no al recibir el foco: si no, atravesarlo con Tab
              // para llegar a la inactividad cambiaba la opción sin avisar y el guardado pedía un
              // número que nadie quería poner (WCAG 3.2.1).
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  seatsMode: 'own',
                  seats: e.target.value.replace(/\D/g, ''),
                }))
              }
              className="max-w-[10rem] tabular-nums"
            />
            {errors.seats !== undefined ? (
              <p id={seatsErrorId} role="alert" className="mt-1 text-xs text-[var(--color-danger)]">
                {errors.seats}
              </p>
            ) : null}
          </div>
        </div>
        {lowered !== undefined ? (
          <p className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-fg)]">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {lowered}
          </p>
        ) : null}
      </fieldset>

      <Field
        label="Cierre por inactividad"
        error={errors.idle}
        hint="Pasado ese tiempo sin actividad se cierra la sesión y se libera el puesto. Se avisa 2 minutos antes."
      >
        {(a11y) => (
          <Select
            {...a11y}
            value={draft.idle}
            onChange={(e) => setDraft((d) => ({ ...d, idle: e.target.value }))}
            className="max-w-xs"
          >
            <option value="">{inheritIdleLabel(view, parentName)}</option>
            {idleChoices(view.ownIdleTimeoutMinutes).map((m) => (
              <option key={m} value={String(m)}>
                {idleLabel(m)}
                {m === DEFAULT_IDLE_MINUTES ? ' (por defecto)' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {serverError ? (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
        >
          {serverError}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {changed ? null : (
          <p className="text-xs text-[var(--color-fg-subtle)] sm:mr-auto">Sin cambios.</p>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={saving || !changed}
          onClick={() => {
            setDraft(seatPolicyDraftOf(view));
            setSubmitted(false);
            setServerError('');
          }}
        >
          Descartar
        </Button>
        <Button type="submit" disabled={saving || !changed}>
          {saving ? (
            <RefreshCw aria-hidden="true" className="animate-spin" />
          ) : (
            <Save aria-hidden="true" />
          )}
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </form>
  );
}
