import { ProviderHealthPanel } from './_components/provider-health';

/** Plataforma → Salud (sólo superadmin; la guarda es el layout de `/admin/plataforma`). */
export default function PlatformHealthPage() {
  return <ProviderHealthPanel />;
}
