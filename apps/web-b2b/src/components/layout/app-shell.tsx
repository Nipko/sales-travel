import { brandStyleSheet } from '../../lib/brand-tokens';
import { ANONYMOUS_VIEWER, type Viewer } from '../../lib/viewer';
import { SessionGuard } from './session-guard';
import type { SessionSnapshot } from './session-guard-state';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { ViewerProvider } from './viewer-context';

interface TenantBranding {
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

interface AppShellProps {
  children: React.ReactNode;
  userEmail?: string;
  tenantName?: string;
  tenantSlug?: string;
  role?: string;
  branding?: TenantBranding;
  /** Quién mira: decide si se ofrecen las pantallas de venta (el superadmin no vende). */
  viewer?: Viewer;
  /**
   * El estado de la sesión (`GET /auth/session`) que leyó el layout: la guardia arranca sabiendo
   * la inactividad y el vencimiento, sin esperar al primer ping.
   */
  session?: SessionSnapshot | null;
}

/**
 * Los colores de la agencia como hoja de estilo con alcance :root, en vez de un style inline. Dos
 * razones: los Portals de React (toasts, diálogos) se montan fuera del árbol del shell y con el
 * style inline se quedaban con los colores de la plataforma; y así se derivan hover y foreground
 * del color elegido en lugar de repetir el mismo hex (ver brand-tokens.ts).
 *
 * Exportada para la pantalla de enrolamiento de 2FA, que se dibuja sin el shell pero con la marca.
 * Vive acá porque es uno de los dos lugares autorizados a inyectar HTML (ver
 * `rate-conditions.guard.test.ts`): el contenido son colores ya validados, nunca texto de nadie.
 */
export function BrandStyle({ branding }: { branding?: TenantBranding }) {
  const brandCss = brandStyleSheet(branding?.primaryColor, branding?.accentColor);
  return brandCss ? <style dangerouslySetInnerHTML={{ __html: brandCss }} /> : null;
}

export function AppShell({
  children,
  userEmail,
  tenantName,
  tenantSlug,
  role,
  branding,
  viewer = ANONYMOUS_VIEWER,
  session = null,
}: AppShellProps) {
  const shell = (
    // `h-dvh` + `overflow-hidden`, NO `min-h-screen`: con `min-h-screen` el contenedor crece
    // con el contenido, así que quien scrollea es el documento entero y el sidebar se va con
    // él. El `overflow-y-auto` del `<main>` no salvaba nada porque `main` no tenía altura
    // acotada de la que desbordar. Acotando la raíz a la altura de la ventana, el único que
    // scrollea es `main` y el menú se queda quieto, que es lo que hace un shell de aplicación.
    //
    // `dvh` y no `vh`: en móvil la barra de direcciones del navegador se recoge al scrollear y
    // `100vh` cuenta la ventana SIN recoger, así que el shell quedaba más alto que la pantalla
    // y volvía a aparecer un scroll del documento — el fallo original, disfrazado.
    <div className="flex h-dvh overflow-hidden bg-[var(--color-bg)]">
      <BrandStyle branding={branding} />
      <Sidebar
        role={role}
        tenantName={tenantName}
        tenantSlug={tenantSlug}
        logoUrl={branding?.logoUrl ?? undefined}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          userEmail={userEmail}
          tenantName={tenantName}
          tenantSlug={tenantSlug}
          logoUrl={branding?.logoUrl ?? undefined}
          role={role}
        />
        {/* `min-h-0` es obligatorio, no cosmético: un item de flex column arranca con
            `min-height: auto` y se niega a encoger por debajo de su contenido, con lo que
            `overflow-y-auto` nunca llega a desbordar y el scroll se escapa otra vez al padre. */}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <SessionGuard initial={session} />
    </div>
  );

  return <ViewerProvider viewer={viewer}>{shell}</ViewerProvider>;
}
