'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Compass, Globe, Sparkles, AlertCircle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { loginAction, type LoginState } from './actions';

const initialState: LoginState = {};

function SubmitButton({ mfaStep }: { mfaStep: boolean }) {
  const { pending } = useFormStatus();
  const label = mfaStep ? 'Verificar código' : 'Iniciar sesión';
  return (
    <Button
      type="submit"
      disabled={pending}
      size="lg"
      className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)] transition-all duration-200 shadow-md font-medium tracking-wide"
    >
      {pending ? `${label}…` : label}
    </Button>
  );
}

export default function LoginPage() {
  const [state, formAction] = useActionState(loginAction, initialState);
  const mfaStep = Boolean(state.mfaToken);

  return (
    <main className="flex min-h-screen bg-[var(--color-bg)]">
      {/* Panel Izquierdo: Visual Inmersivo Premium (Solo visible en LG y superior) */}
      <section className="relative hidden w-[55%] lg:flex flex-col justify-between overflow-hidden bg-[var(--color-navy-dark)] p-12 text-white">
        {/* Esfera de Luz Difuminada Dinámica */}
        <div className="absolute -top-40 -left-40 size-[500px] rounded-full bg-[var(--color-primary)]/15 mix-blend-screen animate-orbit-glow" />
        <div className="absolute -bottom-20 right-0 size-[450px] rounded-full bg-[var(--color-navy-light)]/20 mix-blend-screen" />

        {/* Logo/Branding Header */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--color-primary)] shadow-[var(--shadow-md)]">
            <Compass className="size-5 text-[var(--color-primary-fg)] animate-spin-slow" />
          </div>
          <span className="text-lg font-bold tracking-tight text-white">
            Sales-Travel{' '}
            <span className="text-xs font-normal text-[var(--color-primary)]">B2B</span>
          </span>
        </div>

        {/* Mensaje de Valor Central */}
        <div className="relative z-10 max-w-lg my-auto space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs backdrop-blur-sm text-[var(--color-accent)] font-medium">
            <Sparkles className="size-3" />
            Consolidador Conversacional de Turismo
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight leading-tight text-white drop-shadow-sm">
            La plataforma de turismo más moderna y potente de LATAM.
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed">
            Gestione reservas, cotizaciones y vuelos en tiempo récord. Conéctese directamente con
            múltiples GDS y herramientas de inteligencia artificial para impulsar las ventas de su
            agencia.
          </p>
        </div>

        {/* Footer del Panel */}
        <div className="relative z-10 flex items-center gap-3 text-xs text-slate-400">
          <Globe className="size-4 text-[var(--color-primary)]" />
          <span>Solución multi-tenant white-label para Colombia, Perú y Brasil.</span>
        </div>
      </section>

      {/* Panel Derecho: Formulario de Login */}
      <section className="flex flex-1 flex-col justify-center px-6 py-12 sm:px-12 lg:px-20 bg-[var(--color-bg)]">
        <div className="mx-auto w-full max-w-sm space-y-8 animate-fade-in-up">
          {/* Cabecera Móvil */}
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-[var(--color-primary)] shadow-[var(--shadow-md)] lg:hidden">
              <Compass className="size-6 text-[var(--color-primary-fg)]" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)]">
              Sales-Travel
            </h1>
            <p className="mt-1.5 text-xs font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
              Portal de Agencia · Planetour
            </p>
          </div>

          <Card className="border border-[var(--color-border)]/50 bg-[var(--color-surface)] shadow-[var(--shadow-md)] rounded-xl overflow-hidden">
            <CardHeader className="space-y-1.5 pb-4">
              <CardTitle className="text-lg font-bold text-[var(--color-fg)]">
                {mfaStep ? 'Verificación en dos pasos' : 'Ingrese a su cuenta'}
              </CardTitle>
              <CardDescription className="text-xs text-[var(--color-fg-muted)]">
                {mfaStep
                  ? `Ingresá el código de 6 dígitos de tu app de autenticación${state.email ? ` para ${state.email}` : ''}.`
                  : 'Use su dirección de correo electrónico corporativo'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction} className="space-y-5">
                {mfaStep ? (
                  <>
                    <input type="hidden" name="mfaToken" value={state.mfaToken} />
                    <div className="space-y-2">
                      <Label
                        htmlFor="code"
                        className="text-xs font-semibold text-[var(--color-fg)]"
                      >
                        Código de verificación
                      </Label>
                      <Input
                        id="code"
                        name="code"
                        // `inputMode` numérico abre el teclado correcto en móvil, pero el
                        // campo acepta texto porque los códigos de recuperación son hex.
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoFocus
                        required
                        placeholder="000000"
                        className="h-12 text-center text-lg font-mono tracking-[0.4em] border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] shadow-sm rounded-lg"
                      />
                      <p className="text-xs text-[var(--color-fg-subtle)]">
                        ¿Perdiste el acceso a la app? Usá uno de tus códigos de recuperación.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label
                        htmlFor="email"
                        className="text-xs font-semibold text-[var(--color-fg)]"
                      >
                        Correo electrónico
                      </Label>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        required
                        autoComplete="email"
                        placeholder="ejemplo@agencia.com"
                        className="h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] shadow-sm rounded-lg"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label
                          htmlFor="password"
                          className="text-xs font-semibold text-[var(--color-fg)]"
                        >
                          Contraseña
                        </Label>
                        <Link
                          href="/olvide-password"
                          className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                        >
                          ¿Olvidaste tu contraseña?
                        </Link>
                      </div>
                      <Input
                        id="password"
                        name="password"
                        type="password"
                        required
                        autoComplete="current-password"
                        className="h-10 border-[var(--color-border)] bg-[var(--color-bg)] focus-visible:ring-[var(--color-primary)]/20 focus-visible:border-[var(--color-primary)] shadow-sm rounded-lg"
                      />
                    </div>
                  </>
                )}

                {state.error ? (
                  <div
                    role="alert"
                    className="flex gap-2 rounded-lg border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 px-3 py-2.5 text-xs text-[var(--color-danger)]"
                  >
                    <AlertCircle className="size-4 shrink-0 mt-0.5" />
                    <span>{state.error}</span>
                  </div>
                ) : null}

                <SubmitButton mfaStep={mfaStep} />
              </form>
            </CardContent>
          </Card>

          <p className="text-center text-xs text-[var(--color-fg-subtle)] lg:text-left">
            ¿Tiene problemas para ingresar?{' '}
            <span className="font-medium text-[var(--color-primary)] hover:underline cursor-pointer">
              Contacte al administrador
            </span>{' '}
            de su agencia.
          </p>
        </div>
      </section>
    </main>
  );
}
