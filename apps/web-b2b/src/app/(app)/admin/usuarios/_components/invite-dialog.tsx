'use client';

import { RefreshCw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../../../components/ui/button';
import { Dialog } from '../../../../../components/ui/dialog';
import { Label } from '../../../../../components/ui/label';
import {
  pendingInvitationMessage,
  type InvitationKind,
  type IssuedInvitation,
} from '../../../../../lib/invitation-notice';
import { resendInvitation, sendInvitation } from '../../../../../lib/tenant-admin-seats-client';
import { inputClass, selectClass } from './field-classes';
import { roleLabel } from './roles';

/** La invitación pendiente que el API encontró para ese correo en el nodo (409). */
interface PendingMatch {
  readonly email: string;
  readonly invitationId: string;
  /** Su rol, si está en la lista que Equipo ya cargó. */
  readonly role: string | undefined;
}

/**
 * El aviso de que ya hay una invitación pendiente para el correo, con "Reenviar la invitación":
 * invitar otra vez dejaría a la persona con dos enlaces, y lo que sirve es mandarle uno nuevo.
 *
 * Reenviar conserva el rol con que se emitió, que puede no ser el que se eligió ahora: el aviso lo
 * dice (con el rol, si se conoce), para que nadie reenvíe sin querer un rol más alto o más bajo.
 */
export function PendingInvitationNotice({
  email,
  role,
  resending,
  onResend,
  buttonRef,
}: {
  email: string;
  role?: string | undefined;
  resending: boolean;
  onResend: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2.5 text-xs text-[var(--color-fg)]"
    >
      <p className="font-medium">{pendingInvitationMessage(email)}</p>
      <p className="text-[var(--color-fg-muted)]">
        {role === undefined
          ? 'Reenviarla le manda un enlace nuevo con el mismo rol, que vence en 7 días, y deja sin efecto el anterior.'
          : `Está pendiente como ${roleLabel(role)}. Reenviarla le manda un enlace nuevo con ese rol, que vence en 7 días, y deja sin efecto el anterior.`}{' '}
        Para darle otro rol, revoca esa invitación y vuelve a invitar a la persona.
      </p>
      <Button
        ref={buttonRef}
        type="button"
        size="sm"
        variant="secondary"
        onClick={onResend}
        disabled={resending}
      >
        {resending ? (
          <RefreshCw aria-hidden="true" className="animate-spin" />
        ) : (
          <Send aria-hidden="true" />
        )}
        {resending ? 'Reenviando…' : 'Reenviar la invitación'}
      </Button>
    </div>
  );
}

/**
 * "Invitar usuario" de Equipo. Si el correo ya tiene una invitación pendiente en el nodo, ofrece
 * reenviarla en vez de fallar. Al terminar avisa a Equipo qué se emitió y si el correo salió; el
 * aviso lo da Equipo.
 */
export function InviteDialog({
  tenantId,
  tenantName,
  roles,
  pendingRoleOf,
  onClose,
  onDone,
}: {
  tenantId: string;
  tenantName: string | undefined;
  roles: readonly { readonly value: string; readonly label: string; readonly hint: string }[];
  /** El rol de una invitación pendiente del nodo, si está en la lista ya cargada. */
  pendingRoleOf: (invitationId: string) => string | undefined;
  onClose: () => void;
  onDone: (kind: InvitationKind, email: string, issued: IssuedInvitation) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(
    roles.find((r) => r.value === 'vendedor')?.value ?? roles[0]?.value ?? '',
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingMatch | null>(null);
  const resendButton = useRef<HTMLButtonElement>(null);
  const hint = roles.find((r) => r.value === role)?.hint;

  // El aviso aparece donde estaba el foco del envío: se lleva el foco a su botón para que el teclado
  // y el lector de pantalla lleguen a la acción que sigue.
  useEffect(() => {
    if (pending !== null) resendButton.current?.focus();
  }, [pending]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    const address = email.trim();
    setSending(true);
    setError('');
    setPending(null);
    try {
      const res = await sendInvitation({ email: address, tenantId, role });
      if (res.ok) {
        onDone('invited', address, res.data);
        return;
      }
      if (res.pendingInvitationId !== undefined) {
        setPending({
          email: address,
          invitationId: res.pendingInvitationId,
          role: pendingRoleOf(res.pendingInvitationId),
        });
        return;
      }
      setError(res.message);
    } finally {
      setSending(false);
    }
  }

  async function resendPending() {
    if (pending === null || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await resendInvitation(tenantId, pending.invitationId);
      if (res.ok) {
        onDone('resent', pending.email, res.data);
        return;
      }
      // La aceptaron o la revocaron entre el 409 y el reenvío: ya no choca, se puede invitar.
      if (res.gone) setPending(null);
      setError(res.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!sending) onClose();
      }}
      title="Invitar usuario"
      description={
        tenantName
          ? `Se suma a ${tenantName} y elige su propia contraseña al aceptar.`
          : 'Elige su propia contraseña al aceptar.'
      }
      className="max-w-sm"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="inv-email" className="text-xs font-semibold">
            Correo electrónico
          </Label>
          <input
            id="inv-email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              // El aviso es de otro correo: deja de aplicar.
              setPending(null);
            }}
            placeholder="persona@agencia.com"
            className={inputClass}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="inv-role" className="text-xs font-semibold">
            Rol
          </Label>
          <select
            id="inv-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-describedby="inv-role-hint"
            className={selectClass}
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <p id="inv-role-hint" className="text-xs text-[var(--color-fg-muted)]">
            {hint ?? 'No puedes invitar con un rol igual o superior al tuyo.'}
          </p>
        </div>

        {pending !== null ? (
          <PendingInvitationNotice
            email={pending.email}
            role={pending.role}
            resending={sending}
            onResend={() => void resendPending()}
            buttonRef={resendButton}
          />
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5 px-3 py-2 text-xs text-[var(--color-danger)]"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
            Cancelar
          </Button>
          <Button type="submit" disabled={sending || role === '' || pending !== null}>
            {sending && pending === null ? (
              <RefreshCw aria-hidden="true" className="animate-spin" />
            ) : null}
            {sending && pending === null ? 'Enviando…' : 'Enviar invitación'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
