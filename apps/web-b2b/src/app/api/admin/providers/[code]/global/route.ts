import type { NextResponse } from 'next/server';
import { writeEnablement } from '../../proxy';

type Params = { params: Promise<{ code: string }> };

/** Fija el ajuste global ("Todos los tenants") de un proveedor. */
export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { code } = await params;
  return writeEnablement(req, 'PUT', { scope: 'global', code });
}

/** Quita el ajuste global: vuelve a mandar la variable legado o la política del proveedor. */
export async function DELETE(req: Request, { params }: Params): Promise<NextResponse> {
  const { code } = await params;
  return writeEnablement(req, 'DELETE', { scope: 'global', code });
}
