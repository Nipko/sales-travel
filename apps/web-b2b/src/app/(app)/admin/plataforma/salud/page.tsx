import { ProviderHealthPanel } from './_components/provider-health';

/** Plataforma → Salud (sólo superadmin; la guarda es el layout de `/admin/plataforma`). */
export default function PlatformHealthPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <ProviderHealthPanel />
    </div>
  );
}
