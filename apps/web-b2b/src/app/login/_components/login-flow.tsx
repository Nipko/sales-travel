'use client';

import { useActionState, useState } from 'react';
import type { SessionMotivo } from '../../../lib/session-reasons';
import { loginAction } from '../actions';
import { initialLoginState, type LoginState } from '../login-state';
import { CredentialsStep } from './credentials-step';
import { MfaStep } from './mfa-step';
import { SeatsFullStep } from './seats-full-step';

interface Run {
  key: number;
  email: string;
}

/**
 * "Volver" reinicia el flujo en el navegador, sin ir al servidor: se remonta el formulario con el
 * email ya cargado y `useActionState` arranca de cero (el desafío o el permiso de liberar puesto
 * del intento anterior se descartan).
 */
export function LoginFlow({
  next,
  motivo,
  idleMinutes,
}: {
  /** Ya validado con `safeNextPath`; la action lo vuelve a validar. */
  next: string;
  motivo: SessionMotivo | null;
  idleMinutes?: number;
}) {
  const [run, setRun] = useState<Run>({ key: 0, email: '' });

  return (
    <LoginSteps
      key={run.key}
      initial={initialLoginState(run.email)}
      next={next}
      // El motivo del cierre se muestra al llegar; si el usuario vuelve atrás ya lo leyó.
      motivo={run.key === 0 ? motivo : null}
      idleMinutes={idleMinutes}
      onRestart={(email) => setRun((prev) => ({ key: prev.key + 1, email }))}
    />
  );
}

function LoginSteps({
  initial,
  next,
  motivo,
  idleMinutes,
  onRestart,
}: {
  initial: LoginState;
  next: string;
  motivo: SessionMotivo | null;
  idleMinutes?: number;
  onRestart: (email: string) => void;
}) {
  const [state, formAction, pending] = useActionState(loginAction, initial);

  switch (state.step) {
    case 'mfa':
      return (
        <MfaStep
          state={state}
          pending={pending}
          formAction={formAction}
          next={next}
          onBack={() => onRestart(state.email)}
        />
      );
    case 'seats':
      return (
        <SeatsFullStep
          state={state}
          pending={pending}
          formAction={formAction}
          next={next}
          onBack={() => onRestart(state.email)}
        />
      );
    case 'credentials':
      return (
        <CredentialsStep
          state={state}
          pending={pending}
          formAction={formAction}
          next={next}
          motivo={motivo}
          idleMinutes={idleMinutes}
        />
      );
  }
}
