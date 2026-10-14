'use client';

import { Check, ChevronRight, Copy, Loader2, Smartphone } from 'lucide-react';
import { useEffect, useId, useRef, useState, useTransition, type RefObject } from 'react';
import { PasswordInput } from '../../../../../components/auth/password-input';
import { Button } from '../../../../../components/ui/button';
import {
  confirmMfaAction,
  enrollMfaAction,
  startPhoneChangeAction,
  type CodesResult,
  type EnrollResult,
} from '../actions';
import type { MfaEnrollmentSecret } from '../security-model';
import { Notice } from './notice';
import { QrCode } from './qr-code';
import { compactSecret, secretBlocks } from './security-format';
import { settleAction } from './settle-action';
import { TotpField } from './totp-field';
import { useSecurityForm } from './use-security-form';

export const QR_LABEL = 'Código QR para agregar tu cuenta a la app de autenticación';
export const SCAN_TITLE = 'Escanea este código con tu app de autenticación';
export const ENROLL_PASSWORD_LABEL = 'Tu contraseña';
export const ENROLL_PASSWORD_HINT =
  'La misma con la que ingresas. Así confirmamos que eres tú quien activa la verificación.';

function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-fg)] text-xs font-semibold text-[var(--color-bg)]"
    >
      {n}
    </span>
  );
}

/** La clave para cargar a mano, en bloques de 4, con "Copiar" (copia sin espacios). */
function ManualKey({ secret }: { secret: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const blocks = secretBlocks(secret);

  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => setCopied('idle'), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(compactSecret(secret));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <details className="group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 shrink-0 text-[var(--color-fg-muted)] transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        ¿No puedes escanear? Ingresa la clave a mano
      </summary>
      <div className="space-y-3 border-t border-[var(--color-border)] px-3 py-3">
        <p className="text-xs text-[var(--color-fg-muted)]">
          En tu app elige «Ingresar una clave de configuración» (o parecido), pon tu email como
          nombre de la cuenta y elige «Basada en el tiempo».
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code
            aria-label={`Clave: ${blocks.join(' ')}`}
            className="flex flex-wrap gap-x-2.5 gap-y-1 rounded-md bg-[var(--color-surface-muted)] px-3 py-2 font-mono text-base font-semibold tracking-wider text-[var(--color-fg)]"
          >
            {blocks.map((block, i) => (
              <span key={i}>{block}</span>
            ))}
          </code>
          <Button type="button" variant="secondary" onClick={copy} className="h-11 sm:h-9">
            {copied === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied === 'copied' ? 'Copiada' : 'Copiar'}
          </Button>
        </div>
        <p aria-live="polite" className="sr-only">
          {copied === 'copied' ? 'Copiamos la clave al portapapeles.' : ''}
        </p>
        {copied === 'failed' ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            No pudimos copiar: selecciona la clave y cópiala a mano.
          </p>
        ) : null}
      </div>
    </details>
  );
}

/**
 * La contraseña de la primera activación (USR-13b), con su ayuda y su error asociados al campo.
 * Exportado aparte para poder probar el estado con error sin pasar por la acción.
 */
export function EnrollPasswordField({
  id,
  error,
  pending,
  inputRef,
}: {
  id: string;
  error?: string;
  pending: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="max-w-sm space-y-1.5">
      <label htmlFor={id} className="block text-xs font-semibold text-[var(--color-fg)]">
        {ENROLL_PASSWORD_LABEL}
      </label>
      <PasswordInput
        ref={inputRef}
        id={id}
        name="currentPassword"
        autoComplete="current-password"
        required
        disabled={pending}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      />
      <p id={hintId} className="text-xs text-[var(--color-fg-muted)]">
        {ENROLL_PASSWORD_HINT}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Pasos 2 y 3 del enrolamiento: el QR con la clave manual y la confirmación con el primer código.
 * Exportado aparte para poder probar su primer pintado sin pasar por la acción que crea el secreto.
 *
 * `requirePassword`: la primera activación pide además la contraseña (USR-13b), antes del código
 * para que el sexto dígito siga enviando solo. Al cambiar de teléfono ya se pidió antes del QR.
 */
export function MfaSetupStep({
  enrollment,
  onConfirmed,
  onCancel,
  requirePassword = false,
}: {
  enrollment: MfaEnrollmentSecret;
  onConfirmed: (codes: string[]) => void;
  onCancel?: () => void;
  requirePassword?: boolean;
}) {
  const baseId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const form = useSecurityForm<CodesResult>(confirmMfaAction, (result) => {
    if (result.recoveryCodes) onConfirmed(result.recoveryCodes);
  });
  const passwordError = form.errorField === 'currentPassword' ? form.error : undefined;

  // Al aparecer el QR, el foco va al título: un lector de pantalla anuncia el paso nuevo.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Con la contraseña mala, el foco va a ella y queda seleccionada para reescribirla. El código no
  // se borra: no se llegó a usar y sigue sirviendo mientras la app lo muestre.
  useEffect(() => {
    if (form.failureKey > 0 && !form.pending && passwordError) {
      passwordRef.current?.focus();
      passwordRef.current?.select();
    }
  }, [form.failureKey, form.pending, passwordError]);

  return (
    <div className="space-y-5">
      <ol className="space-y-5">
        <li className="flex gap-3">
          <StepBadge n={1} />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-semibold text-[var(--color-fg)]">
              Abre tu app de autenticación
            </p>
            <p className="text-xs text-[var(--color-fg-muted)]">
              Google Authenticator, Microsoft Authenticator, Authy o 1Password. Si no tienes
              ninguna, bájala gratis de la tienda de tu teléfono.
            </p>
          </div>
        </li>

        <li className="flex gap-3">
          <StepBadge n={2} />
          <div className="min-w-0 flex-1 space-y-3">
            <h3
              id={`${baseId}-scan`}
              ref={titleRef}
              tabIndex={-1}
              className="text-sm font-semibold text-[var(--color-fg)] outline-none"
            >
              {SCAN_TITLE}
            </h3>
            <p className="text-xs text-[var(--color-fg-muted)]">
              En la app toca «+» o «Agregar cuenta» y apunta la cámara al código.
            </p>
            {/* Borde propio para que el QR se recorte sobre el fondo en modo oscuro; el margen
                blanco de 4 módulos ya viene dentro del dibujo. */}
            <div className="mx-auto w-full max-w-[15rem] rounded-xl border border-[var(--color-border-strong)] bg-white p-1 shadow-[var(--shadow-xs)] sm:mx-0">
              <QrCode value={enrollment.otpauthUri} label={QR_LABEL} />
            </div>
            {/* En el teléfono no se puede escanear la propia pantalla: el enlace otpauth abre la
                app de autenticación con la cuenta ya cargada. */}
            <a
              href={enrollment.otpauthUri}
              className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] sm:hidden"
            >
              <Smartphone className="size-4" aria-hidden="true" />
              Abrir en mi app de autenticación
            </a>
            <ManualKey secret={enrollment.secret} />
          </div>
        </li>

        <li className="flex gap-3">
          <StepBadge n={3} />
          <form onSubmit={form.onSubmit} noValidate className="min-w-0 flex-1 space-y-3">
            {requirePassword ? (
              <EnrollPasswordField
                id={`${baseId}-pass`}
                error={passwordError}
                pending={form.pending}
                inputRef={passwordRef}
              />
            ) : null}
            <TotpField
              id={`${baseId}-code`}
              label="Ingresa el código de 6 dígitos que muestra la app"
              hint={
                requirePassword
                  ? 'Con tu contraseña escrita, se envía solo al completar el sexto dígito.'
                  : 'Se envía solo al completar el sexto dígito.'
              }
              error={passwordError ? undefined : form.error}
              // Un error de la contraseña no vacía el código (ver el efecto de arriba).
              failureKey={passwordError ? 0 : form.failureKey}
              pending={form.pending}
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={form.pending} className="h-11 sm:h-9">
                {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                Activar
              </Button>
              {onCancel ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onCancel}
                  disabled={form.pending}
                  className="h-11 sm:h-9"
                >
                  Cancelar
                </Button>
              ) : null}
            </div>
          </form>
        </li>
      </ol>
    </div>
  );
}

/**
 * "Cambiar de teléfono", paso previo: contraseña + un código de la app ACTUAL. El secreto activo
 * no se toca hasta confirmar el nuevo, así que abandonar a mitad de camino no deja a nadie afuera.
 */
function PhoneChangeGate({
  onEnrollment,
  onCancel,
}: {
  onEnrollment: (enrollment: MfaEnrollmentSecret) => void;
  onCancel: () => void;
}) {
  const baseId = useId();
  const form = useSecurityForm<EnrollResult>(startPhoneChangeAction, (result) => {
    if (result.secret && result.otpauthUri) {
      onEnrollment({ secret: result.secret, otpauthUri: result.otpauthUri });
    }
  });

  return (
    <form onSubmit={form.onSubmit} className="space-y-4">
      <p className="text-sm text-[var(--color-fg-muted)]">
        Primero confirma que eres tú. Tu app actual sigue funcionando hasta que termines de
        configurar la nueva.
      </p>
      <div className="max-w-sm space-y-1.5">
        <label
          htmlFor={`${baseId}-pass`}
          className="block text-xs font-semibold text-[var(--color-fg)]"
        >
          Contraseña actual
        </label>
        <PasswordInput
          id={`${baseId}-pass`}
          name="currentPassword"
          autoComplete="current-password"
          required
          disabled={form.pending}
          autoFocus
        />
      </div>
      <TotpField
        id={`${baseId}-code`}
        label="Código de tu app actual"
        error={form.error}
        failureKey={form.failureKey}
        pending={form.pending}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={form.pending} className="h-11 sm:h-9">
          {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Continuar
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={form.pending}
          className="h-11 sm:h-9"
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/**
 * Enrolamiento del 2FA, en la pantalla de Seguridad y en la de enrolamiento obligatorio.
 *
 * - `enroll`: el usuario no tiene 2FA. Un botón pide el secreto (no se pide solo al montar: en
 *   desarrollo React monta dos veces y cada pedido reemplaza el secreto pendiente del anterior).
 * - `rotate`: ya tiene 2FA y cambia de teléfono: contraseña + código actual → QR nuevo.
 *
 * Al confirmar llama a `onConfirmed` con los códigos de recuperación; mostrarlos es del que lo usa,
 * que los tiene que poner por encima de cualquier otro estado.
 */
export function MfaEnrollment({
  mode,
  onConfirmed,
  onCancel,
  startLabel = 'Activar verificación en dos pasos',
}: {
  mode: 'enroll' | 'rotate';
  onConfirmed: (codes: string[]) => void;
  onCancel?: () => void;
  startLabel?: string;
}) {
  const [enrollment, setEnrollment] = useState<MfaEnrollmentSecret | null>(null);
  const [error, setError] = useState('');
  const [starting, startEnroll] = useTransition();

  function begin(): void {
    setError('');
    startEnroll(async () => {
      const res = await settleAction(enrollMfaAction);
      if (!res) return;
      if ('transport' in res || res.error || !res.secret || !res.otpauthUri) {
        setError(res.error ?? 'No pudimos empezar. Inténtalo de nuevo.');
        return;
      }
      setEnrollment({ secret: res.secret, otpauthUri: res.otpauthUri });
    });
  }

  if (enrollment) {
    return (
      <MfaSetupStep
        enrollment={enrollment}
        onConfirmed={onConfirmed}
        // La primera activación pide la contraseña al confirmar; el cambio de teléfono ya la pidió.
        requirePassword={mode === 'enroll'}
        // En el enrolamiento inicial "Cancelar" vuelve al botón de empezar; en el cambio de
        // teléfono cierra el panel (lo decide quien lo abrió).
        onCancel={mode === 'enroll' ? () => setEnrollment(null) : onCancel}
      />
    );
  }

  if (mode === 'rotate') {
    return <PhoneChangeGate onEnrollment={setEnrollment} onCancel={onCancel ?? (() => {})} />;
  }

  return (
    <div className="space-y-3">
      <Button onClick={begin} disabled={starting} className="h-11 w-full sm:h-9 sm:w-auto">
        {starting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {starting ? 'Generando…' : startLabel}
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
