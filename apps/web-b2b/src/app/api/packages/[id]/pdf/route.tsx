import { renderToBuffer } from '@react-pdf/renderer';
import { NextResponse } from 'next/server';
import { getPackageAction } from '../../../../(app)/paquetes/actions';
import { agencyBranding } from '../../../../(app)/paquetes/_components/agency-branding';
import { quoteModel, quoteRefOf } from '../../../../(app)/paquetes/_components/package-quote';
import { loadImages, PackagePDF } from './package-pdf';

/*
 * `GET /api/packages/:id/pdf`: la cotización del paquete en PDF (package-pdf.tsx). Con la sesión
 * del vendedor, como el PDF de vuelos.
 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [res, branding] = await Promise.all([getPackageAction(id), agencyBranding()]);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });

  const model = quoteModel(res.data.package, res.data.items);
  const images = await loadImages(model, branding);
  const quoteRef = quoteRefOf(id);
  const buffer = await renderToBuffer(
    <PackagePDF model={model} branding={branding} images={images} quoteRef={quoteRef} />,
  );
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="paquete-${quoteRef}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
