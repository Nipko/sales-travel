/**
 * Humaniza un mensaje de error CRUDO de proveedor que aún llega como string al frontend (p.ej.
 * `result.error` / `last_error` de operaciones de orden LATAM, o warnings persistidos). La
 * humanización canónica vive en el BACKEND (un mensaje por error, testeado); este helper es la red
 * de seguridad única y compartida — antes había dos copias divergentes (reservas / cotizaciones).
 */
export function humanizeProviderError(raw: string): string {
  const m = (raw ?? '').toLowerCase();

  if (m.includes('passport') && (m.includes('mandatory') || m.includes('required'))) {
    return 'La aerolínea exige pasaporte para todos los pasajeros en esta reserva (habitual en rutas internacionales). En "Pasajeros", cambia el tipo de documento a "Pasaporte", completa el número y la fecha de vencimiento, y vuelve a reservar.';
  }
  if (m.includes('price') && (m.includes('changed') || m.includes('mismatch'))) {
    return 'El precio cambió desde la cotización. Usa "Verificar precio" para actualizarlo y reintenta.';
  }
  if (m.includes('sold out') || m.includes('no availability') || m.includes('unavailable')) {
    return 'La tarifa ya no está disponible. Vuelve a buscar para ver opciones vigentes.';
  }
  if (m.includes('933') || m.includes('not suitable for void')) {
    return 'Esta reserva no está en un estado que permita anularla (VOID). La anulación aplica a tiquetes ya emitidos dentro de la ventana de anulación. Si la reserva aún no está emitida, se libera automáticamente al expirar; si ya pasó la ventana, gestiona la cancelación con la aerolínea.';
  }
  if (m.includes('911') || m.includes('not ready for this flow')) {
    return 'La reserva todavía no está emitida. Usa "Pagar / Emitir tiquete" primero y luego reintenta esta operación.';
  }
  if (m.includes('missing agent') || m.includes('403111009') || m.includes('travel agent')) {
    return 'Falta el "Travel Agent ID" en tus credenciales de LATAM. Cárgalo en Mi Red → Credenciales → LATAM NDC y reintenta.';
  }

  // Limpia el prefijo técnico del proveedor: "LATAM NDC error 933:", "LATAM error: 933", etc.
  const cleaned = (raw ?? '').replace(/^latam(?:\s+\w+)*\s+error\b\s*:?\s*\d*\s*:?\s*/i, '').trim();
  return cleaned || raw;
}

/**
 * ¿El texto es técnico (de un parser, un validador o un proveedor) y no una frase para el vendedor?
 * Rutas de campo (`passengers.1.surname`), códigos del proveedor, nombres de excepciones o de clases.
 */
function looksTechnical(text: string): boolean {
  return (
    /\b[a-z]+(?:\.[a-z0-9]+){1,}\b/i.test(text) ||
    /\b(?:invalid|required|undefined|null|exception|error:|unexpected|validation|bad request|internal server|status code|stack|typeerror|syntaxerror)\b/i.test(
      text,
    ) ||
    /[A-Z_]{6,}/.test(text) ||
    /^error desconocido$/i.test(text.trim())
  );
}

/**
 * El error de una reserva que no salió, en palabras del vendedor (founder 2026-11-12: «dice un error
 * sin tratar»). Primero lo que el proveedor ya sabemos traducir; un pasajero repetido; y si lo que
 * queda sigue siendo técnico, una frase que dice qué hacer, en vez del texto crudo.
 */
export function humanizeBookingFailure(raw: string): string {
  const m = (raw ?? '').toLowerCase();
  if (
    /duplicate (?:name|passenger|traveler)|same name|nombre duplicado|pasajero repetido|passenger.*already|already.*passenger/.test(
      m,
    )
  ) {
    return 'La aerolínea rechazó la reserva porque hay pasajeros repetidos (mismo nombre o mismo documento). Revisa que cada pasajero sea una persona distinta y vuelve a reservar.';
  }
  const known = humanizeProviderError(raw);
  if (known !== raw && known !== raw.trim()) return known;
  if (!looksTechnical(known)) return known;
  return 'No pudimos crear la reserva y no se cobró nada. Revisa los datos de los pasajeros (nombres, fechas y documentos) y vuelve a intentarlo. Si se repite, avísale a soporte con el número de la cotización.';
}
