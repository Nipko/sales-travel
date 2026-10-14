'use client';

import Link from 'next/link';
import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { AuthShell, FormError, FormSuccess } from '../../../components/layout/auth-shell';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  acceptInvitationAction,
  joinInvitationAction,
  switchAccountAction,
  type InvitationState,
  type JoinState,
} from '../actions';
import {
  INVITATION_MESSAGES,
  invitationHeadline,
  invitationPath,
  type InvitationDetails,
  type InvitationView,
} from '../invitation-view';

/**
 * /invitacion (USR-17): lo que corresponde según la vista previa (`invitation-view.ts`). Cada paso
 * con formulario tiene su versión sin estado propio (`NewAccountStep`, `JoinStep`) para pintarla en
 * los tests con cualquier respuesta.
 */

const PRIMARY = 'w-full font-medium';
const INPUT_CLASS =
  'h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] rounded-lg';
const LABEL_CLASS = 'text-xs font-semibold text-[var(--color-fg)]';
const NOTE_CLASS = 'text-sm leading-relaxed text-[var(--color-fg-muted)]';

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} size="lg" className={PRIMARY}>
      {pending ? busy : idle}
    </Button>
  );
}

/**
 * Una navegación a otra pantalla con forma de botón. `/api/session/end` es un route handler, no una
 * pantalla: va con un enlace común, sin el router de Next.
 */
function LinkButton({
  href,
  children,
  variant,
}: {
  href: string;
  children: ReactNode;
  variant?: 'secondary';
}) {
  return (
    <Button asChild size="lg" variant={variant} className={PRIMARY}>
      {href.startsWith('/api/') ? (
        <a href={href}>{children}</a>
      ) : (
        <Link href={href}>{children}</Link>
      )}
    </Button>
  );
}

/** Salir de la sesión abierta, que es de otra cuenta, e ingresar con la que corresponde. */
function SwitchAccountForm({ token, label }: { token?: string; label: string }) {
  return (
    <form action={switchAccountAction}>
      {token ? <input type="hidden" name="token" value={token} /> : null}
      <SubmitButton idle={label} busy="Cerrando sesión…" />
    </form>
  );
}

/**
 * El pie de las pantallas con una sesión abierta: "Volver al inicio de sesión" llevaría al login, que
 * con sesión devuelve al panel. Se dice lo que pasa.
 */
const PANEL_FOOTER = (
  <p className="text-center text-xs text-[var(--color-fg-subtle)]">
    <Link href="/" className="font-medium text-[var(--color-primary)] hover:underline">
      Volver al panel
    </Link>
  </p>
);

/** El encabezado de toda invitación vigente: a qué nodo, con qué rol, quién y hasta cuándo. */
function InvitationShell({
  details,
  signedIn = false,
  children,
}: {
  details: InvitationDetails;
  /** Hay una sesión abierta en este navegador (la invitada o la de otra cuenta). */
  signedIn?: boolean;
  children: ReactNode;
}) {
  return (
    <AuthShell
      title={invitationHeadline(details)}
      description={details.summary}
      footer={signedIn ? PANEL_FOOTER : undefined}
    >
      {children}
    </AuthShell>
  );
}

export function NewAccountStep({
  details,
  token,
  signedInElsewhere,
  state,
  formAction,
}: {
  details: InvitationDetails;
  token: string;
  signedInElsewhere: boolean;
  state: InvitationState;
  formAction: (formData: FormData) => void;
}) {
  if (state.done) {
    return (
      <AuthShell title="Cuenta creada" description="Ya puedes entrar con tu contraseña.">
        <div className="space-y-4">
          <FormSuccess
            message={`Listo: ya formas parte de ${details.tenantName}. Tu correo quedó verificado al aceptar la invitación.`}
          />
          {signedInElsewhere ? (
            <SwitchAccountForm label="Salir e ingresar con tu cuenta nueva" />
          ) : (
            <LinkButton href="/login">Iniciar sesión</LinkButton>
          )}
        </div>
      </AuthShell>
    );
  }

  return (
    <InvitationShell details={details} signedIn={signedInElsewhere}>
      <form action={formAction} className="space-y-5">
        <input type="hidden" name="token" value={token} />
        <p className={NOTE_CLASS}>
          Elige tu nombre y una contraseña para crear tu cuenta. Sólo tú la vas a conocer.
        </p>
        {signedInElsewhere ? (
          <p className={NOTE_CLASS}>
            Tienes abierta la sesión de otra cuenta. La cuenta nueva es para el correo al que te
            llegó la invitación.
          </p>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="name" className={LABEL_CLASS}>
            Tu nombre
          </Label>
          <Input
            id="name"
            name="name"
            required
            autoFocus
            autoComplete="name"
            placeholder="Nombre y apellido"
            className={INPUT_CLASS}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className={LABEL_CLASS}>
            Contraseña
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            aria-describedby="password-hint"
            className={INPUT_CLASS}
          />
          <p id="password-hint" className="text-xs text-[var(--color-fg-subtle)]">
            Mínimo 12 caracteres.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm" className={LABEL_CLASS}>
            Repetir contraseña
          </Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
        </div>

        {state.error ? <FormError message={state.error} /> : null}
        {state.signInHref ? (
          <LinkButton href={state.signInHref}>Ingresar con mi cuenta</LinkButton>
        ) : (
          <SubmitButton idle="Crear cuenta y aceptar" busy="Creando cuenta…" />
        )}
      </form>
    </InvitationShell>
  );
}

function NewAccount(props: {
  details: InvitationDetails;
  token: string;
  signedInElsewhere: boolean;
}) {
  const [state, formAction] = useActionState(acceptInvitationAction, {});
  return <NewAccountStep {...props} state={state} formAction={formAction} />;
}

export function JoinStep({
  details,
  token,
  state,
  formAction,
}: {
  details: InvitationDetails;
  token: string;
  state: JoinState;
  formAction: (formData: FormData) => void;
}) {
  if (state.joined) {
    return (
      <AuthShell
        title={`Ya formas parte de ${details.tenantName}`}
        description={`Te sumaste como ${details.roleLabel}.`}
        footer={false}
      >
        <div className="space-y-4">
          <FormSuccess
            message={`Listo: ${details.tenantName} ya está en tus agencias. Elígela en el selector de agencia para operar con ella.`}
          />
          <LinkButton href="/">Ir al panel</LinkButton>
        </div>
      </AuthShell>
    );
  }

  return (
    <InvitationShell details={details} signedIn>
      <div className="space-y-5">
        <p className={NOTE_CLASS}>
          Ya tienes una cuenta con este correo. Acepta para sumar {details.tenantName} a tus
          agencias.
        </p>
        {state.message ? <FormError message={state.message} /> : null}
        {state.signInHref ? (
          <LinkButton href={state.signInHref}>Ingresar de nuevo</LinkButton>
        ) : state.switchAccount ? (
          <SwitchAccountForm token={token} label="Salir e ingresar con la cuenta invitada" />
        ) : (
          <form action={formAction}>
            <input type="hidden" name="token" value={token} />
            <SubmitButton idle="Aceptar invitación" busy="Aceptando…" />
          </form>
        )}
      </div>
    </InvitationShell>
  );
}

function Join(props: { details: InvitationDetails; token: string }) {
  const [state, formAction] = useActionState(joinInvitationAction, {});
  return <JoinStep {...props} state={state} formAction={formAction} />;
}

export function InvitationScreen({ view, token }: { view: InvitationView; token: string }) {
  switch (view.kind) {
    case 'missing-token':
      return (
        <AuthShell title="Invitación inválida" description={INVITATION_MESSAGES.missingToken}>
          <p className={NOTE_CLASS}>
            Puede que lo hayas copiado incompleto. Pídele a tu administrador que te reenvíe la
            invitación.
          </p>
        </AuthShell>
      );
    case 'invalid':
      return (
        <AuthShell title="Invitación no válida" description={INVITATION_MESSAGES.invalid}>
          <p className={NOTE_CLASS}>
            Puede que ya se haya usado, que haya vencido o que la hayan revocado. Si ya la
            aceptaste, ingresa con tu cuenta.
          </p>
        </AuthShell>
      );
    case 'unavailable':
      return (
        <AuthShell title="No pudimos abrir la invitación" description={view.message}>
          <LinkButton href={invitationPath(token)} variant="secondary">
            Reintentar
          </LinkButton>
        </AuthShell>
      );
    case 'create':
      return (
        <NewAccount
          details={view.details}
          token={token}
          signedInElsewhere={view.signedInElsewhere}
        />
      );
    case 'sign-in':
      return (
        <InvitationShell details={view.details}>
          <div className="space-y-5">
            <p className={NOTE_CLASS}>{INVITATION_MESSAGES.signInRequired}</p>
            <LinkButton href={view.loginHref}>Ingresar para aceptar</LinkButton>
          </div>
        </InvitationShell>
      );
    case 'join':
      return <Join details={view.details} token={token} />;
    case 'wrong-account':
      return (
        <InvitationShell details={view.details} signedIn>
          <div className="space-y-5">
            <p className={NOTE_CLASS}>{INVITATION_MESSAGES.wrongAccount}</p>
            <SwitchAccountForm token={token} label="Salir e ingresar con la cuenta invitada" />
          </div>
        </InvitationShell>
      );
  }
}
