import type { NextResponse } from 'next/server';
import { catalogTarget } from '../../../../../lib/governance-proxy';
import { forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/** El catálogo gobernado: proveedores y sus formas de pago, con su alcance PCI. */
export async function GET(): Promise<NextResponse> {
  return forwardRead(catalogTarget());
}
