import { ArrowLeft, Building2 } from 'lucide-react';
import Link from 'next/link';
import { isTenantId } from '../../../../../lib/provider-enablement';
import { TenantProvidersPanel } from './_components/tenant-providers-panel';

/** Detalle de un tenant en el panel de la plataforma: por ahora, sus proveedores. */
export default async function AdminTenantDetailPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  if (!isTenantId(tenantId)) return <UnknownTenant />;
  return <TenantProvidersPanel tenantId={tenantId.toLowerCase()} />;
}

function UnknownTenant() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
        <Building2
          aria-hidden="true"
          className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]"
        />
        <h1 className="text-sm font-medium text-[var(--color-fg)]">No reconocemos ese tenant.</h1>
        <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-fg-muted)]">
          El enlace está incompleto. Abrilo desde la lista de agencias.
        </p>
        <Link
          href="/admin/tenants"
          className="mt-4 inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--color-fg)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Ir a Agencias
        </Link>
      </div>
    </div>
  );
}
