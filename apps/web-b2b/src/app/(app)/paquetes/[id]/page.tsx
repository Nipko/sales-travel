import type { Metadata } from 'next';
import Link from 'next/link';
import { getPackageAction } from '../actions';
import { agencyBranding } from '../_components/agency-branding';
import { quoteModel, quoteRefOf, whatsappText } from '../_components/package-quote';
import { QuoteActions } from '../_components/quote-actions';
import { QuoteDocument } from '../_components/quote-document';

export const metadata: Metadata = { title: 'Cotización de paquete' };

export default async function PackageQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [res, branding] = await Promise.all([getPackageAction(id), agencyBranding()]);

  if (!res.ok) {
    return (
      <div className="mx-auto max-w-md space-y-3 py-16 text-center">
        <p className="text-sm text-[var(--color-fg-muted)]">{res.error}</p>
        <Link
          href="/paquetes/guardados"
          className="text-sm font-medium text-[var(--color-primary)]"
        >
          Volver a los paquetes
        </Link>
      </div>
    );
  }

  const model = quoteModel(res.data.package, res.data.items);
  return (
    <div className="pb-10">
      <QuoteActions
        packageId={id}
        status={res.data.package.status}
        showBreakdown={res.data.package.showBreakdown}
        whatsappText={whatsappText(model, branding.name)}
      />
      <QuoteDocument model={model} branding={branding} quoteRef={quoteRefOf(id)} />
    </div>
  );
}
