import { brandStyleSheet } from '../../lib/brand-tokens';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

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
}

export function AppShell({
  children,
  userEmail,
  tenantName,
  tenantSlug,
  role,
  branding,
}: AppShellProps) {
  // Hoja de estilo con alcance :root en vez de un style inline en este div. Dos razones:
  // los Portals de React (toasts, diálogos) se montan fuera de este árbol y con el style
  // inline se quedaban con los colores de la plataforma; y así se derivan hover y
  // foreground del color elegido en lugar de repetir el mismo hex (ver brand-tokens.ts).
  const brandCss = brandStyleSheet(branding?.primaryColor, branding?.accentColor);

  return (
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
      {brandCss ? <style dangerouslySetInnerHTML={{ __html: brandCss }} /> : null}
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
    </div>
  );
}
