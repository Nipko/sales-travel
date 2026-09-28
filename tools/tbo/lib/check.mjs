import {
  errorOutcome,
  parsedResponse,
  searchOutcome,
  searchSummary,
  variantResult,
} from './harness.mjs';

/**
 * Packs y hoteles que el ACL leyó de un `200` y descartó, con sus motivos (nombres del enum del
 * mapper, nunca valores). `undefined` si no descartó nada.
 */
function discardedByAcl(diagnostics) {
  if (diagnostics === undefined) return undefined;
  const count = (byReason) => Object.values(byReason ?? {}).reduce((sum, n) => sum + n, 0);
  const packs = Math.max(0, diagnostics.packsReceived - diagnostics.packsMapped);
  const hotels = count(diagnostics.hotelsRejected);
  if (packs === 0 && hotels === 0) return undefined;
  const reasons = Object.entries({ ...diagnostics.hotelsRejected, ...diagnostics.packsRejected })
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}×${n}`);
  return { packs, packsReceived: diagnostics.packsReceived, hotels, reasons };
}

/**
 * `check` (docs/tbo/07 §6.3): valida las credenciales con UN Search de la ocupación del caso 1, sin
 * reservar. Imprime `Status.Code`, la `Currency` del perfil de test (p. 13; Q-82), la latencia y
 * cuántas opciones hay. La evidencia queda en `<corrida>/check/`.
 *
 * Sale con 0 si TBO respondió `200` o `201` —las credenciales valen, aunque no haya disponibilidad—
 * y con 1 en cualquier otro caso. Que el ACL no pueda leer un `200` es un HALLAZGO y se imprime,
 * pero no invalida las credenciales (07 §6.4).
 */
export async function runCheck(harness, out) {
  const { settings } = harness;
  const folder = harness.evidence.folder('check');
  out(
    `TBO check · ${settings.baseUrl} · CheckIn ${settings.checkIn} · ${settings.nights} noches · ` +
      `${settings.hotelCodes.length} HotelCodes · caso 1 (1 adulto, CO)`,
  );

  const criteria = harness.criteriaCaseOne();
  const result = await harness.step(folder, 'caso1', (step) =>
    harness.adapter(step).searchAvailabilityReport(criteria, harness.searchContext),
  );
  const acl = result.error ? errorOutcome(result.error) : searchOutcome(result.value);
  const variant = variantResult('caso1', result, acl);
  const last = result.calls.at(-1);
  const summary = searchSummary(parsedResponse(last));
  const discarded = discardedByAcl(result.value?.diagnostics);

  const lines = [];
  if (variant.httpStatus === 0) {
    lines.push(
      `  Sin respuesta de TBO: ${variant.transportError ?? 'red'} (${result.calls.length} intentos)`,
    );
  } else {
    const description = variant.description ? ` (${variant.description})` : '';
    const code = variant.tboCode === null ? 'sin Status.Code' : `Status.Code ${variant.tboCode}`;
    lines.push(`  HTTP ${variant.httpStatus} · ${code}${description} · ${variant.latencyMs} ms`);
  }
  if (variant.tboCode === 200) {
    lines.push(
      `  Moneda del perfil (HotelResult[].Currency): ${summary.currencies.join(', ') || '— (ningún hotel la trajo)'}`,
    );
    lines.push(`  Opciones: ${summary.options} en ${summary.hotels} hoteles`);
  } else if (variant.tboCode === 201) {
    lines.push(
      '  Sin disponibilidad (201): las credenciales valen, pero la moneda del perfil no se ve.',
      '  Prueba con otro TBO_CHECKIN_OFFSET_DAYS o con TBO_HOTEL_CODES de una ciudad con inventario.',
    );
  }
  lines.push(`  Lectura del ACL: ${acl}`);
  if (variant.tboCode === 200 && result.error?.name === 'TboUnsupportedCurrencyError') {
    lines.push(
      '  HALLAZGO: el perfil cotiza en una moneda sin dos decimales, que el ACL no representa',
      '  (D-TBO-15 A): con esta cuenta TBO quedaría ausente de la búsqueda. Pedir un perfil en USD.',
    );
  } else if (variant.tboCode === 200 && result.error !== undefined) {
    lines.push(
      '  HALLAZGO: TBO respondió 200 y el ACL no pudo leerlo. El RS está en disco: revisar contra',
      '  el esquema del ACL antes de la certificación (07 §6.4).',
    );
  } else if (variant.tboCode === 200 && discarded !== undefined) {
    // El ACL no lanza por un pack o un hotel ilegible: los descarta y sigue. Sin esta línea, un
    // esquema que no encaja con el TBO real pasaría el check como "ok · N packs válidos".
    lines.push(
      `  HALLAZGO: el ACL descartó ${discarded.packs} de ${discarded.packsReceived} opciones y ` +
        `${discarded.hotels} hoteles (${discarded.reasons.join(', ')}). El RS está en disco:`,
      '  revisar contra el esquema del ACL antes de la certificación (07 §6.4).',
    );
  }
  for (const line of lines) out(line);

  const ok = variant.tboCode === 200 || variant.tboCode === 201;
  await harness.evidence.writeJson('check/check.json', {
    ok,
    checkIn: settings.checkIn,
    checkOut: settings.checkOut,
    hotelCodes: settings.hotelCodes,
    ...variant,
    currencies: summary.currencies,
    hotels: summary.hotels,
    options: summary.options,
    discardedByAcl: discarded ?? null,
  });
  if (!ok) {
    out(
      variant.tboCode === 401
        ? '  Las credenciales no valen (401): revisa TBO_USERNAME y TBO_PASSWORD en .env.tbo.'
        : '  El check no pasó: el detalle está en check/calls.jsonl.',
    );
  }
  return ok;
}
