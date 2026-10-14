import type { NextResponse } from 'next/server';
import { readProviders } from '../proxy';

/**
 * ¿Está respondiendo cada proveedor? Circuito, cuentas en pausa, apagado de emergencia y avisos de
 * cuenta de 24 h. El panel la relee cada 30 s mientras la pestaña está a la vista.
 */
export async function GET(): Promise<NextResponse> {
  return readProviders('/admin/providers/health');
}
