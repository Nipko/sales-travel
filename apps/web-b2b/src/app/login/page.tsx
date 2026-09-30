import type { Metadata } from 'next';
import { Compass, Globe, Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';
import { safeNextPath } from '../../lib/safe-next';
import { parseIdleMinutes, parseMotivo } from '../../lib/session-reasons';
import { LoginFlow } from './_components/login-flow';

export const metadata: Metadata = {
  title: 'Iniciar sesión · Sales-Travel',
};

/**
 * En modo claro, el naranja de marca da 3,9:1 con texto blanco y el rojo de error 4,4:1 sobre su
 * fondo tintado: ninguno llega al 4,5:1 de WCAG AA para texto de 14 px, y en el login están el
 * botón principal, los links y los errores. Acá se oscurecen lo justo (4,95:1 y 5,2:1) sólo para
 * esta pantalla; en modo oscuro quedan los tokens globales, que ya cumplen. Cuando se corrijan los
 * tokens en `globals.css` esto sobra.
 */
const ACCESSIBLE_LIGHT_TOKENS = cn(
  '[:root:not(.dark)_&]:[--color-primary:oklch(0.56_0.17_50)]',
  '[:root:not(.dark)_&]:[--color-primary-hover:oklch(0.5_0.16_48)]',
  '[:root:not(.dark)_&]:[--color-danger:oklch(0.54_0.19_25)]',
);

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params['next']);
  const motivo = parseMotivo(params['motivo']);
  const idleMinutes = motivo === 'inactividad' ? parseIdleMinutes(params['minutos']) : undefined;

  return (
    <main className={cn('flex min-h-dvh bg-[var(--color-bg)]', ACCESSIBLE_LIGHT_TOKENS)}>
      {/* Panel de marca: sólo en pantallas grandes, en el teléfono el formulario va primero. */}
      <section className="relative hidden w-[55%] flex-col justify-between overflow-hidden bg-[var(--color-navy-dark)] p-12 text-white lg:flex">
        <div className="absolute -left-40 -top-40 size-[500px] rounded-full bg-[var(--color-primary)]/15 mix-blend-screen animate-orbit-glow motion-reduce:animate-none" />
        <div className="absolute -bottom-20 right-0 size-[450px] rounded-full bg-[var(--color-navy-light)]/20 mix-blend-screen" />

        <div className="relative z-10 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--color-primary)] shadow-[var(--shadow-md)]">
            <Compass className="size-5 text-[var(--color-primary-fg)]" aria-hidden="true" />
          </div>
          <span className="text-lg font-bold tracking-tight text-white">
            Sales-Travel <span className="text-xs font-normal text-[var(--color-accent)]">B2B</span>
          </span>
        </div>

        <div className="relative z-10 my-auto max-w-lg space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-[var(--color-accent)] backdrop-blur-sm">
            <Sparkles className="size-3" aria-hidden="true" />
            Consolidador conversacional de turismo
          </div>
          <p className="text-4xl font-extrabold leading-tight tracking-tight text-white drop-shadow-sm">
            La plataforma de turismo más moderna y potente de LATAM.
          </p>
          <p className="text-sm leading-relaxed text-slate-300">
            Gestioná reservas, cotizaciones y vuelos en tiempo récord. Conectate con múltiples GDS y
            herramientas de inteligencia artificial para impulsar las ventas de tu agencia.
          </p>
        </div>

        <div className="relative z-10 flex items-center gap-3 text-xs text-slate-300">
          <Globe className="size-4 text-[var(--color-accent)]" aria-hidden="true" />
          <span>Para agencias de Colombia, Perú y Brasil.</span>
        </div>
      </section>

      <section className="flex flex-1 flex-col justify-center px-4 py-8 sm:px-12 sm:py-12 lg:px-20">
        {/* Sólo opacidad: un `transform` que queda aplicado al terminar la animación convierte al
            contenedor en el marco de los `position: fixed`, y el diálogo de confirmación de
            "Desconectar y entrar" quedaba atrapado adentro de la columna en vez de cubrir la
            pantalla. */}
        <div className="mx-auto w-full max-w-sm space-y-6 animate-fade-in motion-reduce:animate-none">
          <div className="flex items-center gap-3 lg:hidden">
            <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--color-primary)] shadow-[var(--shadow-md)]">
              <Compass className="size-5 text-[var(--color-primary-fg)]" aria-hidden="true" />
            </div>
            <div>
              <p className="text-base font-bold leading-tight tracking-tight text-[var(--color-fg)]">
                Sales-Travel
              </p>
              <p className="text-xs font-medium text-[var(--color-fg-muted)]">
                Portal de agencias · Planetour
              </p>
            </div>
          </div>

          <LoginFlow next={next} motivo={motivo} idleMinutes={idleMinutes} />

          <p className="text-sm text-[var(--color-fg-muted)]">
            ¿No podés ingresar? Pedile ayuda al administrador de tu agencia.
          </p>
        </div>
      </section>
    </main>
  );
}
