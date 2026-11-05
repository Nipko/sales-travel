'use client';

import { History, RefreshCw, ShieldCheck, ShieldHalf } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '../../../../../../components/ui/badge';
import { Button } from '../../../../../../components/ui/button';
import { Dialog } from '../../../../../../components/ui/dialog';
import { Field, Textarea, TextInput } from '../../../../../../components/ui/field';
import { SegmentedControl } from '../../../../../../components/ui/segmented-control';
import { cn } from '../../../../../../lib/cn';
import {
  CHANGE_REQUEST_STATUS_LABELS,
  PLATFORM_ADMINS_COPY,
  standingLabel,
  type ChangeRequest,
  type ChangeRequestAction,
  type PlatformAdmin,
  type PlatformViewer,
} from '../../../../../../lib/platform-admins';
import {
  CHANGE_REQUEST_PENDING,
  decideChangeRequest,
  grantPlatformAdmin,
  loadChangeRequests,
  loadPlatformAdmins,
  loadViewer,
  revokePlatformAdmin,
  setSupervision,
} from '../../../../../../lib/platform-admins-client';
import { formatActivityDate } from '../../../../../../lib/platform-audit';
import { isStepUpCancelled } from '../../../../../../lib/step-up';

type RequestsTab = 'pending' | 'all';

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly viewer: PlatformViewer;
      readonly admins: readonly PlatformAdmin[];
      readonly requests: readonly ChangeRequest[];
    };

/** Lo que pasó con la última acción: se anuncia arriba, una sola línea. */
type Notice = { readonly tone: 'ok' | 'info' | 'error'; readonly text: string } | null;

/** Lo que pide un motivo o una nota antes de hacerse. */
type Pending =
  | { readonly kind: 'supervision'; readonly admin: PlatformAdmin }
  | { readonly kind: 'revoke'; readonly admin: PlatformAdmin }
  | {
      readonly kind: 'decide';
      readonly request: ChangeRequest;
      readonly action: ChangeRequestAction;
    }
  | null;

/** El enlace a lo que hicieron los superadmins en Plataforma → Actividad. */
const ACTIVITY_HREF = '/admin/plataforma/actividad?solo=superadmins' as const;

/**
 * Plataforma → Superadmins (docs/platform/16): las solicitudes de los supervisados arriba (es lo que
 * espera a alguien), después quién es superadmin y, al final, dar acceso. Todo lo que se cambia acá
 * queda en Plataforma → Actividad, con el antes, el después y el motivo.
 */
export function SuperadminsPanel() {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [tab, setTab] = useState<RequestsTab>('pending');
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (requestsTab: RequestsTab) => {
    const [viewer, admins, requests] = await Promise.all([
      loadViewer(),
      loadPlatformAdmins(),
      loadChangeRequests(requestsTab === 'pending' ? 'pending' : null),
    ]);
    if (!viewer.ok) return setState({ status: 'error', message: viewer.message });
    if (!admins.ok) return setState({ status: 'error', message: admins.message });
    if (!requests.ok) return setState({ status: 'error', message: requests.message });
    setState({
      status: 'ready',
      viewer: viewer.data,
      admins: admins.data,
      requests: requests.data,
    });
  }, []);

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  /** El resultado de una acción: avisar, y releer todo (la solicitud pudo cambiar a otros). */
  const settle = useCallback(
    async (
      result: { ok: true } | { ok: false; message: string; reason?: string } | { cancelled: true },
      done: string,
    ) => {
      if (isStepUpCancelled(result)) return;
      if ('ok' in result && result.ok) setNotice({ tone: 'ok', text: done });
      else if ('reason' in result && result.reason === CHANGE_REQUEST_PENDING) {
        setNotice({ tone: 'info', text: result.message });
      } else if ('message' in result) setNotice({ tone: 'error', text: result.message });
      await load(tab);
    },
    [load, tab],
  );

  async function confirmPending(text: string): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    try {
      if (pending.kind === 'supervision') {
        const next = !pending.admin.supervised;
        await settle(
          await setSupervision(pending.admin.userId, next, text),
          `${pending.admin.email} ahora es superadmin ${standingLabel(next).toLowerCase()}.`,
        );
      } else if (pending.kind === 'revoke') {
        await settle(
          await revokePlatformAdmin(pending.admin.userId, text),
          `${pending.admin.email} ya no es superadmin.`,
        );
      } else {
        const done =
          pending.action === 'approve'
            ? 'Solicitud aprobada y aplicada.'
            : pending.action === 'reject'
              ? 'Solicitud rechazada.'
              : 'Solicitud cancelada.';
        await settle(await decideChangeRequest(pending.request.id, pending.action, text), done);
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            {PLATFORM_ADMINS_COPY.title}
          </h1>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fg-muted)]">
            {PLATFORM_ADMINS_COPY.intro}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" asChild>
            <Link href={ACTIVITY_HREF}>
              <History aria-hidden="true" className="size-3.5" />
              Lo que hicieron
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(tab)}
            aria-label="Volver a cargar"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </header>

      <div aria-live="polite" className="empty:hidden mb-4">
        {notice !== null ? (
          <p
            className={cn(
              'rounded-md border p-3 text-sm',
              notice.tone === 'ok' &&
                'border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-fg)]',
              notice.tone === 'info' &&
                'border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 text-[var(--color-fg)]',
              notice.tone === 'error' &&
                'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[var(--color-fg)]',
            )}
          >
            {notice.text}
          </p>
        ) : null}
      </div>

      {state.status === 'loading' ? (
        <p className="text-sm text-[var(--color-fg-muted)]">Cargando…</p>
      ) : state.status === 'error' ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-fg)]">{state.message}</p>
          <Button variant="secondary" size="sm" onClick={() => void load(tab)}>
            Reintentar
          </Button>
        </div>
      ) : (
        <div className="space-y-8">
          {state.viewer.standing === 'supervised' ? (
            <p className="rounded-md border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/10 p-3 text-sm text-[var(--color-fg)]">
              {PLATFORM_ADMINS_COPY.supervisedViewer}
            </p>
          ) : null}

          <RequestsSection
            tab={tab}
            onTab={setTab}
            requests={state.requests}
            viewer={state.viewer}
            onDecide={(request, action) => setPending({ kind: 'decide', request, action })}
          />

          <AdminsSection
            admins={state.admins}
            viewer={state.viewer}
            onSupervision={(admin) => setPending({ kind: 'supervision', admin })}
            onRevoke={(admin) => setPending({ kind: 'revoke', admin })}
          />

          <GrantSection
            onGrant={async (input) => {
              await settle(
                await grantPlatformAdmin(input),
                `${input.email} ahora es superadmin ${standingLabel(input.supervised).toLowerCase()}.`,
              );
            }}
          />
        </div>
      )}

      {pending !== null ? (
        <ReasonDialog
          pending={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(text) => void confirmPending(text)}
        />
      ) : null}
    </div>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">{children}</h2>
      {aside}
    </div>
  );
}

function RequestsSection({
  tab,
  onTab,
  requests,
  viewer,
  onDecide,
}: {
  tab: RequestsTab;
  onTab: (tab: RequestsTab) => void;
  requests: readonly ChangeRequest[];
  viewer: PlatformViewer;
  onDecide: (request: ChangeRequest, action: ChangeRequestAction) => void;
}) {
  return (
    <section aria-labelledby="solicitudes">
      <SectionTitle
        aside={
          <SegmentedControl
            legend="Qué solicitudes ver"
            options={[
              {
                value: 'pending',
                label: 'Pendientes',
                ...(tab === 'pending' ? { count: requests.length } : {}),
              },
              { value: 'all', label: 'Todas' },
            ]}
            value={tab}
            onChange={onTab}
            countLabel="por decidir"
          />
        }
      >
        <span id="solicitudes">Solicitudes de cambio</span>
      </SectionTitle>
      {requests.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-fg-muted)]">
          {PLATFORM_ADMINS_COPY.empty}
        </p>
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => {
            const own = r.requestedBy.id === viewer.userId;
            const canDecide = r.status === 'pending' && viewer.standing === 'full' && !own;
            return (
              <li
                key={r.id}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs)] sm:p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]">
                    {r.summary}
                  </p>
                  <Badge
                    variant={
                      r.status === 'pending' || r.status === 'failed' ? 'warning' : 'neutral'
                    }
                  >
                    {CHANGE_REQUEST_STATUS_LABELS[r.status]}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-[var(--color-fg-muted)] [overflow-wrap:anywhere]">
                  Pidió {r.requestedBy.email ?? r.requestedBy.id}
                  {own ? ' (tú)' : ''} · {formatActivityDate(r.createdAt)}
                  {r.decidedBy !== null
                    ? ` · Decidió ${r.decidedBy.email ?? r.decidedBy.id}${r.decidedAt !== null ? `, ${formatActivityDate(r.decidedAt)}` : ''}`
                    : ''}
                </p>
                {r.decisionNote !== null ? (
                  <p className="mt-1 text-xs text-[var(--color-fg)]">Nota: {r.decisionNote}</p>
                ) : null}
                {r.error !== null ? (
                  <p className="mt-1 text-xs text-[var(--color-danger)]">No se aplicó: {r.error}</p>
                ) : null}
                {r.status === 'pending' && (canDecide || own) ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {canDecide ? (
                      <>
                        <Button size="sm" onClick={() => onDecide(r, 'approve')}>
                          Aprobar y aplicar
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => onDecide(r, 'reject')}>
                          Rechazar
                        </Button>
                      </>
                    ) : null}
                    {own ? (
                      <Button size="sm" variant="ghost" onClick={() => onDecide(r, 'cancel')}>
                        Cancelar mi solicitud
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AdminsSection({
  admins,
  viewer,
  onSupervision,
  onRevoke,
}: {
  admins: readonly PlatformAdmin[];
  viewer: PlatformViewer;
  onSupervision: (admin: PlatformAdmin) => void;
  onRevoke: (admin: PlatformAdmin) => void;
}) {
  return (
    <section aria-labelledby="superadmins">
      <SectionTitle>
        <span id="superadmins">Quién es superadmin</span>
      </SectionTitle>
      <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
        {admins.map((a) => {
          const self = a.userId === viewer.userId;
          const Icon = a.supervised ? ShieldHalf : ShieldCheck;
          return (
            <li key={a.userId} className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
              <Icon aria-hidden="true" className="size-5 shrink-0 text-[var(--color-fg-muted)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                  {a.name ?? a.email}
                  {self ? (
                    <span className="font-normal text-[var(--color-fg-muted)]"> (tú)</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-[var(--color-fg-muted)]">
                  {a.name !== null ? `${a.email} · ` : ''}
                  {a.lastLoginAt !== null
                    ? `último ingreso ${formatActivityDate(a.lastLoginAt)}`
                    : 'sin ingresos'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge>{standingLabel(a.supervised)}</Badge>
                {a.membershipStatus !== 'active' || a.userStatus !== 'active' ? (
                  <Badge variant="warning">Suspendido</Badge>
                ) : null}
                {!a.mfaEnabled ? (
                  <Badge variant="warning" title={PLATFORM_ADMINS_COPY.noMfa}>
                    Sin 2FA
                  </Badge>
                ) : null}
              </div>
              {!self ? (
                <div className="flex w-full gap-2 sm:w-auto">
                  <Button size="sm" variant="secondary" onClick={() => onSupervision(a)}>
                    {a.supervised ? 'Hacer pleno' : 'Hacer supervisado'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onRevoke(a)}>
                    Quitar acceso
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function GrantSection({
  onGrant,
}: {
  onGrant: (input: { email: string; supervised: boolean; reason: string }) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [supervised, setSupervised] = useState<'full' | 'supervised'>('supervised');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onGrant({ email: email.trim(), supervised: supervised === 'supervised', reason });
      setEmail('');
      setReason('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="dar-acceso">
      <SectionTitle>
        <span id="dar-acceso">Dar acceso de superadmin</span>
      </SectionTitle>
      <form
        onSubmit={(e) => void submit(e)}
        className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Correo de la cuenta"
            hint="La cuenta tiene que existir y estar activa."
            required
          >
            {(props) => (
              <TextInput
                {...props}
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                value={email}
                maxLength={254}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nombre@empresa.com"
              />
            )}
          </Field>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--color-fg)]">Tipo</p>
            <SegmentedControl
              legend="Tipo de superadmin"
              options={[
                { value: 'supervised', label: 'Supervisado' },
                { value: 'full', label: 'Pleno' },
              ]}
              value={supervised}
              onChange={setSupervised}
            />
          </div>
        </div>
        <Field
          label="Motivo"
          hint="Queda en la auditoría. Opcional, pero ayuda a quien lo lea después."
        >
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || email.trim() === ''}>
            {busy ? 'Guardando…' : 'Dar acceso'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ReasonDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: NonNullable<Pending>;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const id = useId();
  const copy = dialogCopy(pending);
  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onCancel}
      title={copy.title}
      description={copy.description}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Volver
          </Button>
          <Button
            variant={copy.danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => onConfirm(text)}
          >
            {busy ? 'Un momento…' : copy.confirm}
          </Button>
        </div>
      }
    >
      {copy.field !== null ? (
        <div className="space-y-1.5">
          <label htmlFor={id} className="block text-xs font-semibold text-[var(--color-fg)]">
            {copy.field}
          </label>
          <Textarea
            id={id}
            rows={3}
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-xs text-[var(--color-fg-muted)]">Queda en la auditoría.</p>
        </div>
      ) : null}
    </Dialog>
  );
}

function dialogCopy(pending: NonNullable<Pending>): {
  title: string;
  description: string;
  confirm: string;
  field: string | null;
  danger: boolean;
} {
  if (pending.kind === 'supervision') {
    const next = pending.admin.supervised ? 'pleno' : 'supervisado';
    return {
      title: `Hacer ${next} a ${pending.admin.email}`,
      description: pending.admin.supervised
        ? 'Sus cambios sensibles se aplicarán sin esperar aprobación.'
        : 'Desde ahora, sus cambios sensibles esperarán la aprobación de un superadmin pleno.',
      confirm: `Hacer ${next}`,
      field: 'Motivo',
      danger: false,
    };
  }
  if (pending.kind === 'revoke') {
    return {
      title: `Quitarle el acceso a ${pending.admin.email}`,
      description:
        'Deja de ser superadmin y se cierran sus sesiones en la plataforma. Su cuenta y lo que hizo siguen en la auditoría.',
      confirm: 'Quitar acceso',
      field: 'Motivo',
      danger: true,
    };
  }
  const { request, action } = pending;
  if (action === 'approve') {
    return {
      title: 'Aprobar y aplicar',
      description: `${request.summary}. Se aplica ahora, a nombre de quien lo pidió, y queda que lo aprobaste.`,
      confirm: 'Aprobar y aplicar',
      field: 'Nota (opcional)',
      danger: false,
    };
  }
  if (action === 'reject') {
    return {
      title: 'Rechazar la solicitud',
      description: `${request.summary}. No se aplica nada.`,
      confirm: 'Rechazar',
      field: 'Por qué (opcional)',
      danger: true,
    };
  }
  return {
    title: 'Cancelar tu solicitud',
    description: `${request.summary}. No se aplica nada.`,
    confirm: 'Cancelar solicitud',
    field: null,
    danger: false,
  };
}
