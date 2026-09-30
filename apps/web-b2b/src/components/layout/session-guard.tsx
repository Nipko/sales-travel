'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { useModalBehavior } from '../ui/dialog';
import { startSessionGuard, type SessionGuardController } from './session-guard-controller';
import {
  announceBucket,
  announceText,
  expiryWarningText,
  formatCountdown,
  type SessionSnapshot,
} from './session-guard-state';
import { logout } from './session-sync';

interface SessionGuardProps {
  /** El estado de la sesión que leyó el layout (`GET /auth/session`), para no esperar al primer ping. */
  initial?: SessionSnapshot | null;
  /** El layout está mostrando el enrolamiento obligatorio de 2FA en lugar del panel. */
  mfaEnrollmentGate?: boolean;
}

/**
 * El rol pasó a exigir 2FA en plena sesión: se recarga para que el layout, que no se vuelve a
 * ejecutar en una navegación de cliente, dibuje el enrolamiento. Se pierde lo que no se guardó,
 * pero desde ese momento el API rechaza todo lo demás igual.
 */
function reloadForMfaEnrollment(): void {
  window.location.reload();
}

/**
 * Guardia de sesión del panel: registra la actividad (compartida entre pestañas), consulta la
 * sesión cada minuto, avisa 2 minutos antes del cierre por inactividad, cierra todas las pestañas
 * juntas y avisa 10 minutos antes del vencimiento absoluto.
 *
 * No decide nada que el servidor no sepa: la API corta la sesión inactiva por su cuenta. Esto es
 * para que el corte no llegue por sorpresa, y para que cuando llegue el panel vaya al login con el
 * motivo en vez de quedar abierto y roto.
 */
export function SessionGuard({ initial = null, mfaEnrollmentGate = false }: SessionGuardProps) {
  const [warningMs, setWarningMs] = useState<number | null>(null);
  const controllerRef = useRef<SessionGuardController | null>(null);

  useEffect(() => {
    const controller = startSessionGuard({
      initial,
      mfaEnrollmentGate,
      onMfaEnrollmentRequired: reloadForMfaEnrollment,
      onWarning: setWarningMs,
      onExpiryWarning: (expiresAt) => {
        toast.warning(expiryWarningText(expiresAt), {
          id: 'session-expiry',
          description: 'Después vas a tener que volver a ingresar.',
          duration: Number.POSITIVE_INFINITY,
        });
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
    // `initial` sólo sirve al arrancar: después cada ping trae el estado vigente. Y
    // `mfaEnrollmentGate` no cambia sin que cambie también el lugar donde se monta la guardia
    // (dentro del shell o al lado del enrolamiento), que la vuelve a arrancar.
  }, []);

  const stay = useCallback(() => controllerRef.current?.stay(), []);
  const closeNow = useCallback(() => void logout(), []);

  if (warningMs === null) return null;
  const dialog = <IdleWarningDialog remainingMs={warningMs} onStay={stay} onLogout={closeNow} />;
  // En un portal al `<body>`, no dentro del shell: un menú de Radix abierto (modal) marca con
  // `aria-hidden` todo lo que existía al abrirse, así que dentro del shell el lector de pantalla no
  // anunciaba el aviso. Lo que se agrega después al `<body>` queda afuera de esa marca.
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

interface IdleWarningDialogProps {
  remainingMs: number;
  onStay: () => void;
  onLogout: () => void;
}

/**
 * El aviso de inactividad: `alertdialog` modal con el foco atrapado; Escape equivale a "Seguir
 * conectado" (quien aprieta una tecla está presente). La cuenta regresiva se VE cada segundo pero
 * se ANUNCIA cada 15 s: un `aria-live` que cambia cada segundo no deja al lector de pantalla decir
 * otra cosa.
 */
export function IdleWarningDialog({ remainingMs, onStay, onLogout }: IdleWarningDialogProps) {
  // `useModalBehavior` rearma el foco y los listeners si cambia su callback: con uno nuevo en cada
  // segundo de cuenta regresiva, el foco saltaría. Se le pasa uno estable.
  const onStayRef = useRef(onStay);
  onStayRef.current = onStay;
  const stableStay = useCallback(() => onStayRef.current(), []);
  const panelRef = useModalBehavior(true, stableStay);

  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [announcement, setAnnouncement] = useState('');
  const bucketRef = useRef(announceBucket(remainingMs));

  // Corre después del efecto de `useModalBehavior`, que enfoca el primer botón: la acción que se
  // espera es seguir, así que el foco arranca ahí.
  useEffect(() => {
    stayButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const bucket = announceBucket(remainingMs);
    if (bucket === bucketRef.current) return;
    bucketRef.current = bucket;
    if (bucket > 0) setAnnouncement(announceText(bucket));
  }, [remainingMs]);

  return (
    // `pointer-events-auto` explícito: un menú de Radix abierto (modal) deja el `<body>` con
    // `pointer-events: none`, y el primer clic en "Seguir conectado" sólo cerraba el menú.
    <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 animate-fade-in" aria-hidden />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative w-full max-w-sm animate-scale-up rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xl)]"
      >
        <h2 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
          ¿Seguís ahí?
        </h2>
        <p id={descriptionId} className="mt-1.5 text-sm text-[var(--color-fg-muted)]">
          Tu sesión se va a cerrar por inactividad en{' '}
          <span className="font-semibold tabular-nums text-[var(--color-fg)]">
            {formatCountdown(remainingMs)}
          </span>
          .
        </p>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onLogout}>
            Cerrar sesión
          </Button>
          <Button ref={stayButtonRef} onClick={onStay}>
            Seguir conectado
          </Button>
        </div>
      </div>
    </div>
  );
}
