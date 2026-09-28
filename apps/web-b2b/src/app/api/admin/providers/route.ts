import type { NextResponse } from 'next/server';
import { readProviders } from './proxy';

/** Los proveedores de la plataforma con su ajuste global y sus excepciones por tenant. */
export async function GET(): Promise<NextResponse> {
  return readProviders('/admin/providers');
}
