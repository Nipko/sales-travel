'use client';

import { AlertTriangle, Check, KeyRound, Monitor, ShieldCheck, ShieldOff } from 'lucide-react';
import { useActionState, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '../../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../components/ui/card';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import {
  changePasswordAction,
  confirmMfaAction,
  disableMfaAction,
  enrollMfaAction,
  revokeAllSessionsAction,
  type ActionResult,
  type ConfirmResult,
} from './actions';

export interface SessionRow {
  id: string;
  issuedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

const emptyResult: ActionResult = {};
const emptyConfirm: ConfirmResult = {};

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)]"
    >
      {pending ? busy : label}
    </Button>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'error' | 'success' | 'warning';
  children: React.ReactNode;
}) {
  const map = {
    error: 'border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 text-[var(--color-danger)]',
    success:
      'border-[var(--color-success)]/20 bg-[var(--color-success)]/5 text-[var(--color-success)]',
    warning: 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 text-[var(--color-fg)]',
  } as const;
  return (
    <div role="alert" className={`rounded-lg border px-3 py-2.5 text-xs ${map[tone]}`}>
      {children}
    </div>
  );
}

/** "Chrome en Windows" a partir del user-agent, sin pretender exactitud forense. */
function describeDevice(ua: string | null): string {
  if (!ua) return 'Dispositivo desconocido';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : 'Navegador';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} en ${os}` : browser;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SecurityClient({
  mfaEnabled,
  recoveryCodesRemaining,
  sessions,
  enrollmentRequired,
  loadError,
}: {
  mfaEnabled: boolean;
  recoveryCodesRemaining: number;
  sessions: SessionRow[];
  enrollmentRequired: boolean;
  loadError?: string;
}) {
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [enrollError, setEnrollError] = useState('');
  const [enrolling, startEnroll] = useTransition();

  const [confirmState, confirmForm] = useActionState(confirmMfaAction, emptyConfirm);
  const [disableState, disableForm] = useActionState(disableMfaAction, emptyResult);
  const [passwordState, passwordForm] = useActionState(changePasswordAction, emptyResult);

  const [revoking, startRevoke] = useTransition();

  function beginEnrollment() {
    setEnrollError('');
    startEnroll(async () => {
      const res = await enrollMfaAction();
      if (res.error || !res.secret || !res.otpauthUri) {
        setEnrollError(res.error ?? 'No pudimos iniciar el enrolamiento.');
        return;
      }
      setEnrollment({ secret: res.secret, otpauthUri: res.otpauthUri });
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[var(--color-fg)]">Seguridad</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Verificación en dos pasos, contraseña y dispositivos con sesión abierta.
        </p>
      </div>

      {loadError ? <Notice tone="error">{loadError}</Notice> : null}

      {enrollmentRequired ? (
        <Notice tone="warning">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              Tu rol requiere verificación en dos pasos. Activala ahora para seguir operando con
              normalidad.
            </span>
          </span>
        </Notice>
      ) : null}

      {/* ================= MFA ================= */}
      <Card className="border border-[var(--color-border)]/60 bg-[var(--color-surface)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-[var(--color-fg)]">
            {mfaEnabled ? (
              <ShieldCheck className="size-4 text-[var(--color-success)]" />
            ) : (
              <ShieldOff className="size-4 text-[var(--color-fg-subtle)]" />
            )}
            Verificación en dos pasos
          </CardTitle>
          <CardDescription className="text-xs text-[var(--color-fg-muted)]">
            {mfaEnabled
              ? `Activa. Te quedan ${recoveryCodesRemaining} códigos de recuperación sin usar.`
              : 'Un código temporal de tu teléfono además de la contraseña.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {mfaEnabled ? (
            <form action={disableForm} className="space-y-3">
              <p className="text-xs text-[var(--color-fg-muted)]">
                Para desactivarla necesitamos tu contraseña actual. Al hacerlo se cierran todas tus
                sesiones.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="mfa-pass" className="text-xs font-semibold">
                    Contraseña actual
                  </Label>
                  <Input id="mfa-pass" name="currentPassword" type="password" required />
                </div>
                <Submit label="Desactivar" busy="Desactivando…" />
              </div>
              {disableState.error ? <Notice tone="error">{disableState.error}</Notice> : null}
            </form>
          ) : confirmState.recoveryCodes ? (
            <div className="space-y-3">
              <Notice tone="success">
                <span className="flex items-center gap-2">
                  <Check className="size-4" /> Verificación en dos pasos activada.
                </span>
              </Notice>
              <div>
                <p className="mb-2 text-xs font-semibold text-[var(--color-fg)]">
                  Guardá estos códigos de recuperación ahora. No se vuelven a mostrar.
                </p>
                <ul className="grid grid-cols-2 gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-xs text-[var(--color-fg)] sm:grid-cols-5">
                  {confirmState.recoveryCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                  Cada uno sirve una sola vez, por si perdés el teléfono.
                </p>
              </div>
            </div>
          ) : enrollment ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Agregá esta clave en Google Authenticator, 1Password o Authy, en la opción de
                  ingreso manual:
                </p>
                <code className="block break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5 font-mono text-sm tracking-wider text-[var(--color-fg)]">
                  {enrollment.secret}
                </code>
              </div>
              <form action={confirmForm} className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="mfa-code" className="text-xs font-semibold">
                      Código que muestra la app
                    </Label>
                    <Input
                      id="mfa-code"
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      required
                      className="font-mono tracking-[0.3em]"
                    />
                  </div>
                  <Submit label="Activar" busy="Verificando…" />
                </div>
                {confirmState.error ? <Notice tone="error">{confirmState.error}</Notice> : null}
              </form>
            </div>
          ) : (
            <div className="space-y-3">
              <Button
                onClick={beginEnrollment}
                disabled={enrolling}
                className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)]"
              >
                {enrolling ? 'Generando…' : 'Activar verificación en dos pasos'}
              </Button>
              {enrollError ? <Notice tone="error">{enrollError}</Notice> : null}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ================= Contraseña ================= */}
      <Card className="border border-[var(--color-border)]/60 bg-[var(--color-surface)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-[var(--color-fg)]">
            <KeyRound className="size-4 text-[var(--color-fg-muted)]" />
            Contraseña
          </CardTitle>
          <CardDescription className="text-xs text-[var(--color-fg-muted)]">
            Al cambiarla se cierran tus sesiones en otros dispositivos. Esta se mantiene.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={passwordForm} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="cur-pass" className="text-xs font-semibold">
                  Actual
                </Label>
                <Input
                  id="cur-pass"
                  name="currentPassword"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-pass" className="text-xs font-semibold">
                  Nueva
                </Label>
                <Input
                  id="new-pass"
                  name="newPassword"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conf-pass" className="text-xs font-semibold">
                  Repetir nueva
                </Label>
                <Input
                  id="conf-pass"
                  name="confirm"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
              </div>
            </div>
            {passwordState.error ? <Notice tone="error">{passwordState.error}</Notice> : null}
            {passwordState.ok ? <Notice tone="success">Contraseña actualizada.</Notice> : null}
            <Submit label="Cambiar contraseña" busy="Guardando…" />
          </form>
        </CardContent>
      </Card>

      {/* ================= Sesiones ================= */}
      <Card className="border border-[var(--color-border)]/60 bg-[var(--color-surface)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-[var(--color-fg)]">
            <Monitor className="size-4 text-[var(--color-fg-muted)]" />
            Dispositivos con sesión abierta
          </CardTitle>
          <CardDescription className="text-xs text-[var(--color-fg-muted)]">
            {sessions.length === 1 ? '1 sesión activa.' : `${sessions.length} sesiones activas.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessions.length === 0 ? (
            <p className="text-xs text-[var(--color-fg-subtle)]">No hay sesiones para mostrar.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--color-fg)]">
                      {describeDevice(s.userAgent)}
                      {s.current ? (
                        <span className="ml-2 rounded-full bg-[var(--color-success)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">
                          Esta sesión
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-[var(--color-fg-subtle)]">
                      {s.ip ?? 'IP desconocida'} · última actividad {formatDate(s.lastSeenAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
            <Button
              variant="danger"
              disabled={revoking || sessions.length === 0}
              onClick={() => startRevoke(async () => void (await revokeAllSessionsAction()))}
            >
              {revoking ? 'Cerrando…' : 'Cerrar sesión en todos los dispositivos'}
            </Button>
            <p className="text-xs text-[var(--color-fg-subtle)]">
              Incluye esta sesión: vas a tener que volver a entrar.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
