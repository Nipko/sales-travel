import type { NextResponse } from 'next/server';
import { writeEnablement } from '../../../proxy';

type Params = { params: Promise<{ code: string; tenantId: string }> };

/** Fija la excepción de un tenant (cubre también su red, salvo ajustes más cercanos). */
export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { code, tenantId } = await params;
  return writeEnablement(req, 'PUT', { scope: 'tenant', code, tenantId });
}

/** Quita la excepción: el tenant vuelve a heredar de su red o del ajuste global. */
export async function DELETE(req: Request, { params }: Params): Promise<NextResponse> {
  const { code, tenantId } = await params;
  return writeEnablement(req, 'DELETE', { scope: 'tenant', code, tenantId });
}
