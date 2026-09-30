'use client';

import {
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  RefreshCw,
  Shield,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type ReactNode } from 'react';
import { PasswordInput } from '../../../../components/auth/password-input';
import { Button } from '../../../../components/ui/button';
import {
  changePasswordAction,
  disableMfaAction,
  regenerateRecoveryCodesAction,
  type ActionResult,
  type CodesResult,
} from './actions';
import { MfaEnrollment } from './_components/mfa-enrollment';
import { Notice } from './_components/notice';
import { RecoveryCodeField } from './_components/recovery-code-field';
import { RecoveryCodes, type RecoveryCodesReason } from './_components/recovery-codes';
import { SessionsList } from './_components/sessions-list';
import { TotpField } from './_components/totp-field';
import { TrustedDevices } from './_components/trusted-devices';
import { useSecurityForm } from './_components/use-security-form';
import {
  pickMfaView,
  recoveryCodesLow,
  type MfaPanel,
  type MfaStatus,
  type SessionRow,
  type TrustedDeviceRow,
} from './security-model';

export type { SessionRow } from './security-model';

function Section({
  icon: Icon,
  title,
  description,
  badge,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
    >
      <header className="space-y-1 border-b border-[var(--color-border)] px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon className="size-4 shrink-0 text-[var(--color-fg-muted)]" aria-hidden="true" />
          <h2 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
            {title}
          </h2>
          {badge}
        </div>
        {description ? <p className="text-sm text-[var(--color-fg-muted)]">{description}</p> : null}
      </header>
      <div className="px-4 py-4 sm:px-5 sm:py-5">{children}</div>
    </section>
  );
}

function Badge({ tone, children }: { tone: 'on' | 'off' | 'required'; children: ReactNode }) {
  const cls = {
    on: 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10',
    off: 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]',
    required: 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/15',
  }[tone];
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium text-[var(--color-fg)] ${cls}`}
    >
      {children}
    </span>
  );
}

/** Una fila "qué es · estado · acción" del 2FA activo. Apilada en el teléfono. */
function SettingRow({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: LucideIcon;
  title: string;
  detail: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
          <div className="text-xs text-[var(--color-fg-muted)]">{detail}</div>
        </div>
      </div>
      {/* En el teléfono, el botón se alinea con el texto (ícono de 36 px + 12 px de separación). */}
      {action ? <div className="shrink-0 pl-12 sm:pl-0">{action}</div> : null}
    </li>
  );
}

function MfaEnabledSummary({ mfa, onOpen }: { mfa: MfaStatus; onOpen: (panel: MfaPanel) => void }) {
  const remaining = mfa.recoveryCodesRemaining;
  return (
    <div className="space-y-4">
      {recoveryCodesLow(mfa) ? (
        <Notice
          tone="warning"
          title={
            remaining === 0
              ? 'No te quedan códigos de recuperación'
              : remaining === 1
                ? 'Te queda 1 código de recuperación'
                : `Te quedan ${remaining} códigos de recuperación`
          }
        >
          <p>Generá códigos nuevos: son la forma de entrar si perdés o te roban el teléfono.</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpen('regenerate')}
            className="mt-2 h-11 sm:h-8"
          >
            Generar códigos nuevos
          </Button>
        </Notice>
      ) : null}

      {mfa.pendingEnrollment ? (
        <Notice tone="info">
          Empezaste a cambiar de teléfono y no terminaste. Tu app actual sigue funcionando; si
          querés, empezá de nuevo con «Cambiar de teléfono».
        </Notice>
      ) : null}

      <ul className="divide-y divide-[var(--color-border)]">
        <SettingRow
          icon={Smartphone}
          title="App de autenticación"
          detail="Te pedimos un código de la app al entrar desde un equipo nuevo."
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpen('rotate')}
              className="h-11 sm:h-8"
            >
              Cambiar de teléfono
            </Button>
          }
        />
        <SettingRow
          icon={KeyRound}
          title="Códigos de recuperación"
          detail={
            remaining === 1
              ? 'Queda 1 sin usar. Cada uno sirve una sola vez.'
              : `Quedan ${remaining} sin usar. Cada uno sirve una sola vez.`
          }
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpen('regenerate')}
              className="h-11 sm:h-8"
            >
              <RefreshCw aria-hidden="true" />
              Regenerar
            </Button>
          }
        />
        {mfa.required ? (
          <SettingRow
            icon={ShieldCheck}
            title="Obligatoria para tu rol"
            detail="Tu rol exige la verificación en dos pasos, así que no se puede desactivar. Si perdés el teléfono, entrá con un código de recuperación o pedile a un administrador que te la restablezca."
          />
        ) : (
          <SettingRow
            icon={ShieldOff}
            title="Desactivar"
            detail="Tu cuenta quedaría protegida sólo por la contraseña."
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpen('disable')}
                className="h-11 text-[var(--color-danger)] hover:text-[var(--color-danger)] sm:h-8"
              >
                Desactivar
              </Button>
            }
          />
        )}
      </ul>
    </div>
  );
}

function RegenerateCodesForm({
  onGenerated,
  onCancel,
}: {
  onGenerated: (codes: string[]) => void;
  onCancel: () => void;
}) {
  const baseId = useId();
  const form = useSecurityForm<CodesResult>(regenerateRecoveryCodesAction, (result) => {
    if (result.recoveryCodes) onGenerated(result.recoveryCodes);
  });
  return (
    <form onSubmit={form.onSubmit} noValidate className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">
          Generar códigos de recuperación nuevos
        </h3>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Los códigos que tenés ahora dejan de servir y te damos otros. Confirmá con un código de tu
          app.
        </p>
      </div>
      <TotpField
        id={`${baseId}-code`}
        label="Código de tu app de autenticación"
        error={form.error}
        failureKey={form.failureKey}
        pending={form.pending}
        autoFocus
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={form.pending} className="h-11 sm:h-9">
          {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Generar códigos nuevos
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

/** Qué código pide el formulario de desactivar: el de la app o uno de recuperación. */
type ReauthCodeMode = 'totp' | 'recovery';

const TEXT_ACTION_CLASS =
  'inline-flex min-h-11 items-center rounded-md text-sm font-medium text-[var(--color-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-50 sm:min-h-8';

/**
 * Desactivar el 2FA: contraseña + un código. El código puede ser el de la app o uno de
 * recuperación: quien perdió el teléfono y entró con un código de recuperación tiene que poder
 * apagarlo desde acá (el API lo acepta). Exportado para probar su primer pintado.
 */
export function DisableMfaForm({ onCancel }: { onCancel: () => void }) {
  const baseId = useId();
  const [mode, setMode] = useState<ReauthCodeMode>('totp');
  // El foco va al código sólo cuando el usuario cambió de tipo; al abrir, lo tiene la contraseña.
  const [switched, setSwitched] = useState(false);
  // Un error del otro tipo de código ("Ingresá los 6 dígitos…") no se muestra bajo el campo nuevo.
  const [errorsBefore, setErrorsBefore] = useState(0);
  // Éxito: la acción revalida y la tarjeta pasa sola a "desactivada" (o manda al login si el API
  // cerró también esta sesión).
  const form = useSecurityForm<ActionResult>(disableMfaAction, () => onCancel());
  const error = form.failureKey > errorsBefore ? form.error : undefined;
  const recovery = mode === 'recovery';

  function switchMode(): void {
    setMode(recovery ? 'totp' : 'recovery');
    setSwitched(true);
    setErrorsBefore(form.failureKey);
  }

  return (
    <form onSubmit={form.onSubmit} className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">
          Desactivar la verificación en dos pasos
        </h3>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Sin ella, alcanza con tu contraseña para entrar a tu cuenta. Se cierran tus sesiones
          abiertas y se olvidan los equipos de confianza.
        </p>
      </div>
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
      <input type="hidden" name="mode" value={mode} />
      {recovery ? (
        <RecoveryCodeField
          id={`${baseId}-recovery`}
          label="Código de recuperación"
          // Guion que no corta (U+2011): partido en dos renglones, el ejemplo parecía dos códigos.
          hint={
            'Uno de los códigos que guardaste al activar la verificación, como A1B2C\u20113D4E5.'
          }
          error={error}
          pending={form.pending}
          autoFocus={switched}
        />
      ) : (
        // Sin auto-envío: es una acción destructiva, que se confirme con el botón.
        <TotpField
          id={`${baseId}-code`}
          label="Código de tu app de autenticación"
          error={error}
          failureKey={form.failureKey}
          pending={form.pending}
          autoFocus={switched}
          autoSubmit={false}
        />
      )}
      <button
        type="button"
        onClick={switchMode}
        disabled={form.pending}
        className={TEXT_ACTION_CLASS}
      >
        {recovery ? 'Usar el código de la app' : 'Usar un código de recuperación'}
      </button>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" variant="danger" disabled={form.pending} className="h-11 sm:h-9">
          {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Desactivar
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

function PasswordField({
  id,
  label,
  name,
  autoComplete,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  name: string;
  autoComplete: string;
  hint?: string;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-semibold text-[var(--color-fg)]">
        {label}
      </label>
      <PasswordInput
        id={id}
        name={name}
        autoComplete={autoComplete}
        required
        minLength={name === 'currentPassword' ? undefined : 12}
        maxLength={128}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-[var(--color-fg-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function ChangePasswordForm() {
  const baseId = useId();
  const [changed, setChanged] = useState(false);
  const form = useSecurityForm<ActionResult>(changePasswordAction, (_result, el) => {
    el.reset();
    setChanged(true);
  });
  return (
    <form onSubmit={form.onSubmit} onInput={() => setChanged(false)} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <PasswordField
          id={`${baseId}-current`}
          label="Contraseña actual"
          name="currentPassword"
          autoComplete="current-password"
          disabled={form.pending}
        />
        <PasswordField
          id={`${baseId}-new`}
          label="Nueva"
          name="newPassword"
          autoComplete="new-password"
          hint="Mínimo 12 caracteres."
          disabled={form.pending}
        />
        <PasswordField
          id={`${baseId}-confirm`}
          label="Repetir la nueva"
          name="confirm"
          autoComplete="new-password"
          disabled={form.pending}
        />
      </div>
      {form.error ? <Notice tone="error">{form.error}</Notice> : null}
      {changed ? (
        <Notice tone="success" title="Contraseña actualizada">
          Cerramos tus sesiones en los otros dispositivos. Esta sigue abierta.
        </Notice>
      ) : null}
      <Button type="submit" disabled={form.pending} className="h-11 w-full sm:h-9 sm:w-auto">
        {form.pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {form.pending ? 'Guardando…' : 'Cambiar contraseña'}
      </Button>
    </form>
  );
}

/**
 * No se pudo leer `GET /auth/mfa`. Se dice eso y nada más: sin badge y sin "Activar" ni
 * "Desactivar", que partirían de un estado que no conocemos.
 */
function MfaStatusUnavailable() {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  return (
    <Notice tone="error" title="No pudimos cargar el estado de la verificación en dos pasos">
      <p>Tu configuración no cambió. Probá de nuevo en unos segundos.</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={retrying}
        onClick={() => startRetry(() => router.refresh())}
        className="mt-2 h-11 sm:h-8"
      >
        <RefreshCw className={retrying ? 'animate-spin' : undefined} aria-hidden="true" />
        {retrying ? 'Reintentando…' : 'Reintentar'}
      </Button>
    </Notice>
  );
}

export interface SecurityClientProps {
  /** `null`: `GET /auth/mfa` falló y no sabemos si el 2FA está activo. */
  mfa: MfaStatus | null;
  sessions: SessionRow[];
  /** `GET /auth/sessions` falló: la lista vacía no quiere decir "0 sesiones". */
  sessionsError?: string;
  trustedDevices: TrustedDeviceRow[];
  trustedDevicesError?: string;
  /** Para el .txt y la hoja impresa de los códigos de recuperación. */
  email?: string;
  /** Hora del servidor al pintar: los tiempos relativos se calculan contra ella (ver formatRelative). */
  now: number;
  /** El rol exige 2FA y no está activo (llegó del login con `?enrolar=1` o lo dice `/auth/mfa`). */
  enrollmentRequired: boolean;
}

export function SecurityClient({
  mfa,
  sessions,
  sessionsError,
  trustedDevices,
  trustedDevicesError,
  email,
  now,
  enrollmentRequired,
}: SecurityClientProps) {
  const router = useRouter();
  const [revealed, setRevealed] = useState<{
    codes: string[];
    reason: RecoveryCodesReason;
  } | null>(null);
  const [panel, setPanel] = useState<MfaPanel | null>(null);
  const [finishing, startFinishing] = useTransition();

  const view = pickMfaView({ revealedCodes: revealed?.codes ?? null, status: mfa, panel });

  function reveal(codes: string[], reason: RecoveryCodesReason): void {
    setPanel(null);
    setRevealed({ codes, reason });
  }

  function finish(): void {
    // Borrar los códigos y refrescar en la MISMA transición: React no pinta la tarjeta sin códigos
    // hasta que llega la página nueva (con el 2FA activo), así no aparece un instante el botón
    // "Activar" con los datos viejos.
    startFinishing(() => {
      setRevealed(null);
      router.refresh();
    });
  }

  const badge = !mfa ? null : mfa.enabled ? (
    <Badge tone="on">Activa</Badge>
  ) : mfa.required ? (
    <Badge tone="required">Obligatoria para tu rol</Badge>
  ) : (
    <Badge tone="off">Desactivada</Badge>
  );

  // Sin 2FA no hay equipos de confianza que mostrar (ni un error de carga que importe). Si no
  // sabemos si está activo, se muestran: esconderlos daría por hecho que no lo está.
  const showTrustedDevices = !mfa || mfa.enabled || trustedDevices.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[var(--color-fg)]">Seguridad</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Verificación en dos pasos, contraseña, equipos de confianza y dispositivos con sesión
          abierta.
        </p>
      </div>

      <Section
        icon={!mfa ? Shield : mfa.enabled ? ShieldCheck : ShieldOff}
        title="Verificación en dos pasos"
        badge={view === 'codes' ? null : badge}
        description={
          view === 'enroll'
            ? 'Además de la contraseña, un código que cambia cada 30 segundos en tu teléfono. Aunque alguien sepa tu contraseña, sin tu teléfono no entra.'
            : undefined
        }
      >
        {view === 'codes' && revealed ? (
          <RecoveryCodes
            codes={revealed.codes}
            reason={revealed.reason}
            email={email}
            onDone={finish}
            finishing={finishing}
          />
        ) : view === 'unavailable' || !mfa ? (
          <MfaStatusUnavailable />
        ) : view === 'enroll' ? (
          <div className="space-y-4">
            {enrollmentRequired ? (
              <Notice tone="warning" title="Tu rol requiere la verificación en dos pasos">
                Activala ahora para seguir operando con normalidad.
              </Notice>
            ) : null}
            <MfaEnrollment mode="enroll" onConfirmed={(codes) => reveal(codes, 'enabled')} />
          </div>
        ) : view === 'rotate' ? (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Cambiar de teléfono</h3>
            <MfaEnrollment
              mode="rotate"
              onConfirmed={(codes) => reveal(codes, 'rotated')}
              onCancel={() => setPanel(null)}
            />
          </div>
        ) : view === 'regenerate' ? (
          <RegenerateCodesForm
            onGenerated={(codes) => reveal(codes, 'regenerated')}
            onCancel={() => setPanel(null)}
          />
        ) : view === 'disable' ? (
          <DisableMfaForm onCancel={() => setPanel(null)} />
        ) : (
          <MfaEnabledSummary mfa={mfa} onOpen={setPanel} />
        )}
      </Section>

      <Section
        icon={KeyRound}
        title="Contraseña"
        description="Al cambiarla se cierran tus sesiones en otros dispositivos y se olvidan los equipos de confianza. Esta sesión se mantiene."
      >
        <ChangePasswordForm />
      </Section>

      {showTrustedDevices ? (
        <Section
          icon={Laptop}
          title="Equipos de confianza"
          description="Navegadores donde marcaste «Recordar este equipo»: ahí no te pedimos el código durante 30 días."
        >
          <TrustedDevices devices={trustedDevices} now={now} loadError={trustedDevicesError} />
        </Section>
      ) : null}

      <Section
        icon={Monitor}
        title="Dispositivos con sesión abierta"
        description={
          sessionsError
            ? undefined
            : sessions.length === 1
              ? '1 sesión activa.'
              : `${sessions.length} sesiones activas.`
        }
      >
        <SessionsList sessions={sessions} now={now} loadError={sessionsError} />
      </Section>
    </div>
  );
}
