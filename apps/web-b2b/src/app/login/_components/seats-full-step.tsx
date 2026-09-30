'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import { useId, useRef, useState, type MouseEvent } from 'react';
import { Button } from '../../../components/ui/button';
import { useConfirm } from '../../../components/ui/dialog';
import { cn } from '../../../lib/cn';
import type { SeatSession, SeatsState } from '../login-state';
import {
  describeDevice,
  lastActivityLabel,
  seatsHeadline,
  seatsTenantLabel,
  sessionDisplayName,
} from '../session-display';
import { FormAlert, PendingAnnouncer, StepCard, TEXT_ACTION_CLASS, describedBy } from './login-ui';

export const RELEASE_BUTTON_LABEL = 'Desconectar y entrar';

/**
 * Cupo lleno: todos los puestos simultáneos del nodo están ocupados.
 *
 * Quien administra el nodo del cupo puede desconectar a alguien y entrar en su lugar (la API manda
 * `release` sólo en ese caso); el resto ve a quién pedírselo. Desconectar a alguien le corta el
 * trabajo, así que se confirma antes.
 */
export function SeatsFullStep({
  state,
  pending,
  formAction,
  next,
  onBack,
}: {
  state: SeatsState;
  pending: boolean;
  formAction: (formData: FormData) => void;
  next: string;
  onBack: () => void;
}) {
  const { seats } = state;
  const release = seats.release;
  const tenant = seatsTenantLabel(seats);
  const [confirm, confirmDialog] = useConfirm();
  const [releasingId, setReleasingId] = useState<string | null>(null);
  // La sesión que ya se confirmó: el segundo clic (el que hacemos nosotros) envía de verdad.
  const confirmedRef = useRef<string | null>(null);
  // El "ahora" de "Activo hace 3 min" es cuándo llegó ESTA lista: no cambia en cada render y se
  // renueva con cada lista nueva (el paso no se remonta entre una respuesta y la siguiente).
  const nowMs = state.listedAt;
  const listLabelId = useId();
  const errorId = useId();
  const noticeId = useId();

  async function confirmRelease(
    event: MouseEvent<HTMLButtonElement>,
    session: SeatSession,
  ): Promise<void> {
    if (confirmedRef.current === session.sessionId) {
      // Confirmado: se deja seguir el clic, y el botón viaja como `submitter` con su
      // `name=sessionId`. Un clic y no `requestSubmit(boton)`, que Safari < 16 no tiene.
      confirmedRef.current = null;
      setReleasingId(session.sessionId);
      return;
    }
    event.preventDefault();
    const button = event.currentTarget;
    const device = session.device ? ` en ${describeDevice(session.device)}` : '';
    const ok = await confirm({
      title: `¿Desconectar a ${sessionDisplayName(session)}?`,
      description: `Se cierra su sesión${device} y entrás vos con ese puesto. Lo que no haya guardado se pierde.`,
      confirmLabel: RELEASE_BUTTON_LABEL,
    });
    if (!ok) return;
    confirmedRef.current = session.sessionId;
    button.click();
  }

  return (
    <StepCard
      title="No hay puestos libres"
      description={seatsHeadline(seats)}
      focusTitle
      // Tras cada respuesta el foco vuelve al título (el botón usado se deshabilitó al enviar, o
      // desapareció con su fila o con el formulario), que se lee junto con el error o aviso nuevo.
      focusKey={state.attempt}
      titleDescribedBy={describedBy(state.notice && noticeId, state.error && errorId)}
    >
      {/* Remontados en cada respuesta: dos errores iguales seguidos (dos 429) no cambiaban el DOM y
          el segundo no se anunciaba. */}
      {state.notice ? (
        <FormAlert key={`notice-${state.attempt}`} id={noticeId} tone="notice" className="mb-4">
          <p>{state.notice}</p>
        </FormAlert>
      ) : null}
      {state.error ? (
        <FormAlert key={`error-${state.attempt}`} id={errorId} tone="error" className="mb-4">
          <p>{state.error}</p>
        </FormAlert>
      ) : null}

      {release ? (
        <form action={formAction} aria-busy={pending} className="space-y-3">
          <input type="hidden" name="intent" value="release" />
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="email" value={state.email} />
          <input type="hidden" name="releaseToken" value={release.token} />

          <p id={listLabelId} className="text-sm text-[var(--color-fg-muted)]">
            Como administrás {tenant}, podés desconectar a alguien y entrar con su puesto.
          </p>

          {release.sessions.length > 0 ? (
            <ul aria-labelledby={listLabelId} className="space-y-2">
              {release.sessions.map((session) => (
                <SeatSessionRow
                  key={session.sessionId}
                  session={session}
                  poolTenantName={seats.tenantName}
                  nowMs={nowMs}
                  pending={pending}
                  releasing={pending && releasingId === session.sessionId}
                  onRelease={confirmRelease}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-fg)]">
              No encontramos sesiones que puedas cerrar desde acá. Probá de nuevo en unos minutos.
            </p>
          )}
          <PendingAnnouncer pending={pending} label="Desconectando y entrando…" />
        </form>
      ) : (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-[var(--color-fg)]">
            Un puesto se libera cuando alguien cierra sesión o deja de usar el panel por un rato.
            Pedile a un administrador de {tenant} que libere uno, o probá de nuevo en unos minutos.
          </p>
          <Button type="button" onClick={onBack} className="h-11 w-full font-semibold sm:h-10">
            Volver a intentar
          </Button>
        </div>
      )}

      {release ? (
        <div className="mt-4 border-t border-[var(--color-border)] pt-2">
          <button
            type="button"
            disabled={pending}
            onClick={onBack}
            className={cn(
              TEXT_ACTION_CLASS,
              'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Volver
          </button>
        </div>
      ) : null}
      {confirmDialog}
    </StepCard>
  );
}

function SeatSessionRow({
  session,
  poolTenantName,
  nowMs,
  pending,
  releasing,
  onRelease,
}: {
  session: SeatSession;
  poolTenantName: string | null;
  nowMs: number;
  pending: boolean;
  releasing: boolean;
  onRelease: (event: MouseEvent<HTMLButtonElement>, session: SeatSession) => void;
}) {
  const nameId = useId();
  const name = sessionDisplayName(session);
  const activity = lastActivityLabel(session.lastSeenAt, nowMs);
  // El nodo sólo se muestra si no es el del cupo (una sucursal que consume del cupo de su agencia).
  const node =
    session.tenantName && session.tenantName !== poolTenantName ? session.tenantName : null;
  const device = [describeDevice(session.device), session.ip].filter(Boolean).join(' · ');
  const detail = [activity, node].filter(Boolean).join(' · ');

  return (
    <li className="space-y-3 rounded-lg border border-[var(--color-border)] p-3">
      <div className="min-w-0 space-y-0.5">
        <p id={nameId} className="truncate text-sm font-medium text-[var(--color-fg)]">
          {name}
        </p>
        {session.name && session.email ? (
          <p className="truncate text-xs text-[var(--color-fg-muted)]">{session.email}</p>
        ) : null}
        <p className="text-xs text-[var(--color-fg-muted)]">{device}</p>
        {detail ? <p className="text-xs text-[var(--color-fg-muted)]">{detail}</p> : null}
      </div>
      <Button
        type="submit"
        name="sessionId"
        value={session.sessionId}
        variant="secondary"
        disabled={pending}
        // El nombre del botón se repite en cada fila: la descripción dice a quién desconecta.
        aria-describedby={nameId}
        onClick={(event) => onRelease(event, session)}
        className="h-11 w-full font-semibold sm:h-9"
      >
        {releasing ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            Entrando…
          </>
        ) : (
          RELEASE_BUTTON_LABEL
        )}
      </Button>
    </li>
  );
}
