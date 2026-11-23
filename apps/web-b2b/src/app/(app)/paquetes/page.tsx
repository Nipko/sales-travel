import type { Metadata } from 'next';
import { PackageBuilder } from './_components/package-builder';

export const metadata: Metadata = { title: 'Paquetes' };

export default function PaquetesPage() {
  return <PackageBuilder />;
}
