import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import { proxyTravelersChange, proxyTravelersRead } from './travelers-proxy';

/** Los datos de los pasajeros de la reserva, enmascarados (SAB-25). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reply = await proxyTravelersRead(id, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}

/** Corrige en bloque documento, viajero frecuente y servicios especiales (SAB-25). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reply = await proxyTravelersChange(req, id, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
