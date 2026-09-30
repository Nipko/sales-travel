'use client';

import Link from 'next/link';
import { useEffect, useId, useRef } from 'react';
import { PasswordInput } from '../../../components/auth/password-input';
import { TextInput } from '../../../components/ui/field';
import type { SessionMotivo } from '../../../lib/session-reasons';
import { LOGIN_MESSAGES, type CredentialsState } from '../login-state';
import {
  FormAlert,
  PendingAnnouncer,
  PendingButton,
  StepCard,
  TEXT_ACTION_CLASS,
  describedBy,
} from './login-ui';
import { ReasonBanner } from './reason-banner';

const LABEL_CLASS = 'block text-sm font-medium text-[var(--color-fg)]';
const RESET_LINK_CLASS = 'font-medium text-[var(--color-fg)] underline underline-offset-2';

export function CredentialsStep({
  state,
  pending,
  formAction,
  next,
  motivo,
  idleMinutes,
}: {
  state: CredentialsState;
  pending: boolean;
  formAction: (formData: FormData) => void;
  next: string;
  /** Sólo en la primera pantalla: después de un intento el aviso ya no es lo importante. */
  motivo?: SessionMotivo | null;
  idleMinutes?: number;
}) {
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const noticeId = useId();
  const { error, notice } = state;
  // Credenciales rechazadas: los dos campos (la API no dice cuál falló, y no debe). Si faltó algo,
  // sólo el que quedó vacío.
  const emailInvalid = error?.kind === 'invalid' || (error?.kind === 'missing' && !state.email);
  const passwordInvalid =
    error?.kind === 'invalid' || (error?.kind === 'missing' && Boolean(state.email));
  // El aviso de por qué se volvió a este paso aparece junto con el paso, y un `role="status"` que
  // se monta con su texto no se anuncia en todos los lectores: se lee como descripción del campo
  // que recibe el foco (la contraseña si el email ya está, si no el email).
  const noticeOnEmail = notice && !state.email ? noticeId : undefined;
  const noticeOnPassword = notice && state.email ? noticeId : undefined;

  // Tras cada respuesta, el foco va a lo que hay que escribir: la contraseña (el email se conserva)
  // o el email si falta. Al volver del paso del código con el email cargado, también la contraseña.
  useEffect(() => {
    if (state.email) {
      passwordRef.current?.focus();
    } else if (error) {
      emailRef.current?.focus();
    }
  }, [state.attempt, state.email, state.notice, error]);

  return (
    <StepCard title="Ingresá a tu cuenta" description="Usá el correo con el que te dieron acceso.">
      {motivo && state.attempt === 0 ? (
        <ReasonBanner motivo={motivo} idleMinutes={idleMinutes} />
      ) : null}
      {notice ? (
        <FormAlert key={`notice-${state.attempt}`} id={noticeId} tone="notice" className="mb-5">
          <p>{notice}</p>
          {state.offerPasswordReset ? (
            <p>
              <Link href="/olvide-password" className={RESET_LINK_CLASS}>
                Restablecer contraseña
              </Link>
            </p>
          ) : null}
        </FormAlert>
      ) : null}

      <form action={formAction} aria-busy={pending} className="space-y-4">
        <input type="hidden" name="intent" value="credentials" />
        <input type="hidden" name="next" value={next} />

        <div className="space-y-1.5">
          <label htmlFor="login-email" className={LABEL_CLASS}>
            Correo electrónico
          </label>
          <TextInput
            ref={emailRef}
            id="login-email"
            name="email"
            type="email"
            inputMode="email"
            // `username` y no `email`: es lo que buscan los gestores de contraseñas para
            // completar el par usuario/contraseña.
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus={!state.email}
            // React 19 vacía el formulario al terminar la acción: sin `defaultValue` desde el
            // estado, cada error borraba el email y en el celular había que tipearlo de nuevo.
            defaultValue={state.email}
            placeholder="nombre@agencia.com"
            aria-invalid={emailInvalid || undefined}
            aria-describedby={describedBy(error && errorId, noticeOnEmail)}
            className="h-11 text-base sm:h-10 sm:text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="login-password" className={LABEL_CLASS}>
            Contraseña
          </label>
          <PasswordInput
            ref={passwordRef}
            id="login-password"
            name="password"
            autoComplete="current-password"
            required
            aria-invalid={passwordInvalid || undefined}
            aria-describedby={describedBy(error && errorId, noticeOnPassword)}
            className="h-11 sm:h-10"
          />
        </div>

        {error ? (
          // Remontado en cada respuesta: la misma contraseña mala dos veces (enviada con Enter, con
          // el foco que no se mueve) daba el mismo texto y el lector no volvía a anunciarlo.
          <FormAlert key={`error-${state.attempt}`} id={errorId} tone="error">
            <p className="font-medium">{error.message}</p>
            {error.kind === 'invalid' ? (
              <p className="text-[var(--color-fg-muted)]">
                {LOGIN_MESSAGES.lockoutHint}{' '}
                <Link href="/olvide-password" className={RESET_LINK_CLASS}>
                  Restablecer contraseña
                </Link>
              </p>
            ) : null}
          </FormAlert>
        ) : null}

        <PendingButton type="submit" pending={pending} pendingLabel="Ingresando…">
          Iniciar sesión
        </PendingButton>
        <PendingAnnouncer pending={pending} label="Verificando tus datos…" />

        {/* Después del botón y no junto a la etiqueta de la contraseña: ahí quedaba entre el email
            y la contraseña en el orden de tabulación, y Tab desde el email caía en el link. */}
        <div className="flex justify-center">
          <Link href="/olvide-password" className={TEXT_ACTION_CLASS}>
            ¿Olvidaste tu contraseña?
          </Link>
        </div>
      </form>
    </StepCard>
  );
}
