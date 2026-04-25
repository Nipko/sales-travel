import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sales-Travel · Panel Agencia',
  description: 'Consolidador conversacional de turismo para LATAM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
