/**
 * Humaniza un mensaje de error CRUDO de proveedor que aún llega como string al frontend (p.ej.
 * `result.error` / `last_error` de operaciones de orden LATAM, o warnings persistidos). La
 * humanización canónica vive en el BACKEND (un mensaje por error, testeado); este helper es la red
 * de seguridad única y compartida — antes había dos copias divergentes (reservas / cotizaciones).
 */
export function humanizeProviderError(raw: string): string {
  const m = (raw ?? '').toLowerCase();

  if (m.includes('passport') && (m.includes('mandatory') || m.includes('required'))) {
    return 'La aerolínea exige pasaporte para todos los pasajeros en esta reserva (habitual en rutas internacionales). En "Pasajeros", cambiá el tipo de documento a "Pasaporte", completá el número y la fecha de vencimiento, y volvé a reservar.';
  }
  if (m.includes('price') && (m.includes('changed') || m.includes('mismatch'))) {
    return 'El precio cambió desde la cotización. Usá "Verificar precio" para actualizarlo y reintentá.';
  }
  if (m.includes('sold out') || m.includes('no availability') || m.includes('unavailable')) {
    return 'La tarifa ya no está disponible. Volvé a buscar para ver opciones vigentes.';
  }
  if (m.includes('933') || m.includes('not suitable for void')) {
    return 'Esta reserva no está en un estado que permita anularla (VOID). La anulación aplica a tiquetes ya emitidos dentro de la ventana de anulación. Si la reserva aún no está emitida, se libera automáticamente al expirar; si ya pasó la ventana, gestioná la cancelación con la aerolínea.';
  }
  if (m.includes('911') || m.includes('not ready for this flow')) {
    return 'La reserva todavía no está emitida. Usá "Pagar / Emitir tiquete" primero y luego reintentá esta operación.';
  }
  if (m.includes('missing agent') || m.includes('403111009') || m.includes('travel agent')) {
    return 'Falta el "Travel Agent ID" en tus credenciales de LATAM. Cargalo en Mi Red → Credenciales → LATAM NDC y reintentá.';
  }

  // Limpia el prefijo técnico del proveedor: "LATAM NDC error 933:", "LATAM error: 933", etc.
  const cleaned = (raw ?? '').replace(/^latam(?:\s+\w+)*\s+error\b\s*:?\s*\d*\s*:?\s*/i, '').trim();
  return cleaned || raw;
}
