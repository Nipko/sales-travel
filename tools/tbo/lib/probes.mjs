import { randomUUID } from 'node:crypto';
import { BOOKING_PROBES } from './booking-probes.mjs';
import {
  acceptedByTbo,
  answered,
  describeVariant,
  errorOutcome,
  outcomeOfSearch,
  shortVariant as short,
  syntheticBookingCode,
  variantResult,
} from './harness.mjs';

/**
 * Sondas de contrato sin reserva (docs/tbo/07 §6.8). Cada una contesta con evidencia una pregunta
 * que el PDF deja abierta; lo que se versiona es la respuesta transcrita a docs/tbo/10, nunca la
 * captura cruda, y las sondas nunca entran al zip de certificación.
 *
 * El RQ lo arma siempre el ACL. Cuando la pregunta es justamente sobre algo que el ACL no manda
 * (el ordinal de `MealType`, 101 códigos, el casing de Postman), la sonda reescribe ESE campo del
 * RQ que armó el ACL, lo declara en `calls.jsonl` y guarda al lado el RQ original (`*_RQ.acl.json`).
 * El resto del request —fechas, `ResponseTime`, `Filters`, cabeceras— es el de producción.
 *
 * PR-09 a PR-11 crean reservas de test (`probe --bookings`) y las cancelan siempre, pida lo que
 * pida `TBO_CANCEL_AFTER`: no son entregables.
 */

const DAY_MS = 86_400_000;

function isoDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Con `201` en todas las variantes, TBO pudo no llegar a validar la forma: la lectura es débil. */
function availabilityCaveat(variants) {
  const answeredOnes = variants.filter((v) => v.tboCode !== null);
  return answeredOnes.length > 0 && answeredOnes.every((v) => v.tboCode === 201)
    ? ' OJO: todas dieron 201 (sin disponibilidad); repetir con fechas u hoteles con inventario antes de cerrar la pregunta.'
    : '';
}

/** Reescribe el último segmento del path que armó el ACL (PR-04). */
function pathRewrite(from, to) {
  return {
    description: `path ${from} → ${to}`,
    url: (url) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith(from)) throw new Error(`el ACL ya no llama a ${from}`);
      parsed.pathname = `${parsed.pathname.slice(0, -from.length)}${to}`;
      return parsed.href;
    },
  };
}

// ───────────────────────── Sondas ─────────────────────────

async function probeChildrenAges(h, folder) {
  const shapes = [
    ['empty-array', 'ChildrenAges: []'],
    ['zero', 'ChildrenAges: [0]'],
    ['omit', 'ChildrenAges omitido'],
  ];
  const criteria = h.criteriaCaseOne();
  const variants = [];
  for (const [shape, label] of shapes) {
    const result = await h.step(folder, `ChildrenAges-${shape}`, (step) =>
      h
        .adapter(step, { options: { emptyChildrenAges: shape } })
        .searchAvailabilityReport(criteria, h.searchContext),
    );
    variants.push(variantResult(label, result, outcomeOfSearch(result)));
  }
  const accepted = variants.filter(acceptedByTbo);
  const rejected = variants.filter((v) => !acceptedByTbo(v));
  let reading =
    `TBO acepta: ${accepted.map((v) => v.label).join('; ') || 'ninguna'}. ` +
    `No acepta: ${rejected.map((v) => `${v.label} (${short(v)})`).join('; ') || 'ninguna'}.`;
  if (!acceptedByTbo(variants[0]) && accepted.length > 0) {
    reading +=
      ' `[]` no pasa: el valor por defecto de `emptyChildrenAges` pasa a la forma aceptada (07 §4.2).';
  }
  return { variants, reading: reading + availabilityCaveat(variants) };
}

async function probeMealType(h, folder) {
  const criteria = h.criteriaCaseOne();
  const search = (label, rewrite) =>
    h.step(
      folder,
      label,
      (step) => h.adapter(step).searchAvailabilityReport(criteria, h.searchContext),
      { rewrite },
    );
  const all = await search('MealType-All');
  const ordinal = await search('MealType-0', {
    description: 'Filters.MealType: "All" → 0',
    body: (json) => {
      if (json?.Filters?.MealType !== 'All')
        throw new Error('el ACL ya no manda Filters.MealType "All"');
      return { ...json, Filters: { ...json.Filters, MealType: 0 } };
    },
  });
  const variants = [
    variantResult('MealType "All" (ACL)', all, outcomeOfSearch(all)),
    variantResult('MealType 0 (Postman)', ordinal, outcomeOfSearch(ordinal)),
  ];
  const [a, b] = variants;
  const reading =
    acceptedByTbo(a) && acceptedByTbo(b)
      ? 'TBO acepta también el ordinal 0. El builder sigue mandando el string (S-03).'
      : acceptedByTbo(a)
        ? `TBO no acepta el ordinal (${short(b)}): se confirma S-03.`
        : acceptedByTbo(b)
          ? `Sólo el ordinal pasa (${short(a)} con "All"): revisar S-03 y el builder.`
          : `Ninguna forma pasa: "All" → ${short(a)}; 0 → ${short(b)}.`;
  return { variants, reading: reading + availabilityCaveat(variants) };
}

async function probeHttps(h, folder) {
  const base = new URL(h.settings.baseUrl);
  const criteria = h.criteriaCaseOne();
  const variants = [];
  for (const protocol of ['http:', 'https:']) {
    const baseUrl = `${protocol}//${base.host}${base.pathname}`;
    const result = await h.step(folder, protocol.replace(':', ''), (step) =>
      h
        .adapter(step, { config: h.config({ baseUrl }) })
        .searchAvailabilityReport(criteria, h.searchContext),
    );
    variants.push(variantResult(`${protocol}//`, result, outcomeOfSearch(result)));
  }
  const https = variants[1];
  const reading = acceptedByTbo(https)
    ? 'Hay TLS en test: el mismo Search responde por https. `TBO_BASE_URLS.test` pasa a https y se borra la excepción http de config.ts (D-TBO-30).'
    : https.httpStatus === 0
      ? `https no responde (${https.transportError ?? 'red'}): no hay TLS utilizable en test. Se mantiene la excepción http sólo en test (D-TBO-30 A).`
      : `https responde pero no igual: ${short(https)}.`;
  return { variants, reading };
}

async function probeCasing(h, folder, state, flags) {
  const code = h.settings.hotelCodes[0];
  const criteria = h.criteriaCaseOne();
  const today = h.now();
  const byDateBody = { FromDate: isoDay(today - 7 * DAY_MS), ToDate: isoDay(today) };
  const pairs = [
    {
      name: 'Search',
      pdf: '/Search',
      postman: '/search',
      call: (step) => h.adapter(step).searchAvailabilityReport(criteria, h.searchContext),
      outcome: outcomeOfSearch,
    },
    {
      name: 'HotelDetails',
      pdf: '/HotelDetails',
      postman: '/Hoteldetails',
      call: (step) => h.staticClient(step).getHotelDetails([code], 'en'),
      outcome: (r) => (r.error ? errorOutcome(r.error) : `ok · ${r.value.hotels.length} hoteles`),
    },
    {
      // El ACL todavía no publica un builder de este método (lo trae la conciliación): el body es
      // el de docs/tbo/04 §5 y sale por el cliente HTTP del ACL, con su auth y su envelope.
      name: 'BookingDetailsbasedondate',
      pdf: '/BookingDetailsbasedondate',
      postman: '/BookingDetailsBasedOnDate',
      call: (step) =>
        h.httpClient(step).send('bookingDetailsByDate', byDateBody, { maxAttempts: 1 }),
      outcome: (r) => (r.error ? errorOutcome(r.error) : 'ok'),
    },
    {
      name: 'hotelcodelist',
      pdf: '/hotelcodelist',
      postman: '/HotelCodeList',
      skip: flags.skipHotelCodeList ? 'se pidió --skip-hotelcodelist' : undefined,
      call: (step) => h.staticClient(step).listAllHotelCodes(),
      outcome: (r) =>
        r.error ? errorOutcome(r.error) : `ok · ${r.value.hotelCodes.length} códigos`,
    },
  ];

  const variants = [];
  const readings = [];
  for (const pair of pairs) {
    if (pair.skip !== undefined) {
      readings.push(`${pair.name}: no se probó (${pair.skip}).`);
      continue;
    }
    const pdf = await h.step(folder, `${pair.name}-pdf`, pair.call);
    const postman = await h.step(folder, `${pair.name}-postman`, pair.call, {
      rewrite: pathRewrite(pair.pdf, pair.postman),
    });
    if (pair.name === 'hotelcodelist' && pdf.value !== undefined) {
      state.allHotelCodes = pdf.value.hotelCodes;
    }
    const a = variantResult(`${pair.pdf} (PDF, TBO_OPERATIONS)`, pdf, pair.outcome(pdf));
    const b = variantResult(`${pair.postman} (Postman)`, postman, pair.outcome(postman));
    variants.push(a, b);
    const same = a.httpStatus === b.httpStatus && a.tboCode === b.tboCode;
    readings.push(
      same && answered(a)
        ? `${pair.name}: las dos grafías responden igual (${short(a)}); el routing no distingue mayúsculas.`
        : answered(a) && !answered(b)
          ? `${pair.name}: sólo el casing del PDF responde (${pair.postman} → ${short(b)}); TBO_OPERATIONS queda como está.`
          : !answered(a) && answered(b)
            ? `${pair.name}: sólo ${pair.postman} responde (${pair.pdf} → ${short(a)}); TBO_OPERATIONS cambia a ${pair.postman} (08 §9 C-03).`
            : `${pair.name}: ${pair.pdf} → ${short(a)}; ${pair.postman} → ${short(b)}.`,
    );
  }
  return { variants, reading: readings.join(' ') };
}

async function probeUnknownReference(h, folder) {
  // Una referencia recién generada con la regla de producción (RF-19): no puede existir en TBO.
  const bookingReferenceId = h.acl.generateTboBookingReference('test');
  const result = await h.step(folder, 'referencia-inexistente', (step) =>
    h
      .adapter(step)
      .bookingDetailReport({ bookingReferenceId, purpose: 'interactive' }, h.searchContext),
  );
  const acl = result.error
    ? errorOutcome(result.error)
    : result.value.found
      ? 'found:true (!)'
      : `found:false (${result.value.failureKind})`;
  const variant = variantResult(`BookingReferenceId ${bookingReferenceId}`, result, acl);
  const reading =
    `"No existe" llega como ${short(variant)}. ` +
    (result.error === undefined && result.value.found === false
      ? 'El ACL ya lo lee como "no encontrada": fijar esta forma en el esquema (RF-21 CA-5) y quitar el aviso NOT_FOUND_SHAPE_UNCONFIRMED.'
      : `El ACL lo lee como ${acl}: ajustar la lectura de "no encontrada" del adapter (RF-21 CA-5).`);
  return { variants: [variant], reading };
}

async function probeBadCredentials(h, folder) {
  // Un usuario inventado, no una variación del real: una ráfaga de intentos fallidos no puede
  // bloquear la cuenta de test que se usa para certificar.
  const config = () =>
    h.config({ username: 'sales-travel-probe-pr06', password: `probe-${randomUUID()}` });
  const criteria = h.criteriaCaseOne();
  const result = await h.step(folder, 'credenciales-erroneas', (step) =>
    h.adapter(step, { config: config() }).searchAvailabilityReport(criteria, h.searchContext),
  );
  const variant = variantResult('usuario y contraseña inventados', result, outcomeOfSearch(result));
  const where =
    variant.httpStatus === 401 && variant.tboCode === 401
      ? 'en los dos: HTTP 401 y Status.Code 401'
      : variant.httpStatus === 401
        ? 'sólo en el HTTP (401), sin Status.Code en el body'
        : variant.tboCode === 401
          ? `sólo en el body (HTTP ${variant.httpStatus}, Status.Code 401)`
          : `como ${short(variant)}`;
  return { variants: [variant], reading: `Credenciales erróneas: TBO lo dice ${where}.` };
}

async function probeFakeBookingCode(h, folder) {
  const hotelCode = h.settings.hotelCodes[0];
  const bookingCode = syntheticBookingCode(hotelCode);
  const result = await h.step(folder, 'bookingcode-inventado', (step) =>
    h.adapter(step).prebookReport(
      {
        hotelCode,
        bookingCode,
        searchId: randomUUID(),
        // El reloj del ACL: la ventana de 27 min se mide contra él (RF-09).
        searchSentAt: Date.now(),
        rooms: [{ adults: 1, childrenAges: [] }],
      },
      h.searchContext,
    ),
  );
  const variant = variantResult(
    'BookingCode inventado',
    result,
    result.error ? errorOutcome(result.error) : 'ok (!)',
  );
  return {
    variants: [variant],
    reading: `Un BookingCode inventado en PreBook da ${short(variant)}.`,
  };
}

/**
 * 101 códigos válidos, de la fuente más específica que haya: `TBO_HOTEL_CODES`, la ciudad de
 * `TBO_CITY_CODE` o la lista completa que trajo PR-04. Sin 101 no hay sonda honesta.
 */
async function codesForLimitProbe(h, folder, state) {
  const wanted = 101;
  if (h.settings.hotelCodes.length >= wanted) {
    return { codes: h.settings.hotelCodes.slice(0, wanted), source: 'TBO_HOTEL_CODES' };
  }
  if (h.settings.cityCode !== undefined) {
    const result = await h.step(folder, 'codigos-de-ciudad', (step) =>
      h.staticClient(step).listCityHotels(h.settings.cityCode),
    );
    const codes = [...new Set((result.value?.hotels ?? []).map((hotel) => hotel.hotelId))];
    if (codes.length >= wanted) {
      return { codes: codes.slice(0, wanted), source: `TBOHotelCodeList ${h.settings.cityCode}` };
    }
  }
  if ((state.allHotelCodes?.length ?? 0) >= wanted) {
    return { codes: state.allHotelCodes.slice(0, wanted), source: 'hotelcodelist (PR-04)' };
  }
  return undefined;
}

async function probeHotelCodeLimit(h, folder, state) {
  const found = await codesForLimitProbe(h, folder, state);
  if (found === undefined) {
    return {
      skipped: true,
      variants: [],
      reading:
        'No se probó: hacen falta 101 códigos. Define TBO_HOTEL_CODES con 101 o más, o ' +
        'TBO_CITY_CODE de una ciudad con 101 hoteles, o corre PR-04 sin --skip-hotelcodelist.',
    };
  }
  const { codes, source } = found;
  const hundred = codes.slice(0, 100);
  const criteria = h.criteriaCaseOne(hundred);
  const search = (label, rewrite) =>
    h.step(
      folder,
      label,
      (step) => h.adapter(step).searchAvailabilityReport(criteria, h.searchContext),
      { rewrite },
    );
  const control = await search('100-codigos');
  const over = await search('101-codigos', {
    description: 'HotelCodes: 100 → 101 códigos',
    body: (json) => {
      if (json?.HotelCodes !== hundred.join(','))
        throw new Error('el ACL no mandó los 100 códigos pedidos');
      return { ...json, HotelCodes: codes.join(',') };
    },
  });
  const variants = [
    variantResult(`100 códigos (${source})`, control, outcomeOfSearch(control)),
    variantResult('101 códigos', over, outcomeOfSearch(over)),
  ];
  const [a, b] = variants;
  const reading =
    acceptedByTbo(a) && acceptedByTbo(b)
      ? '101 pasa: 100 es una recomendación, no un límite duro (el ACL sigue en 100, D-TBO-17 A).'
      : acceptedByTbo(a)
        ? `101 no pasa (${short(b)}): 100 es un límite duro.`
        : `El control con 100 no pasó (${short(a)}): la sonda no contesta nada.`;
  return { variants, reading: reading + availabilityCaveat(variants), source };
}

export const PROBES = Object.freeze([
  {
    id: 'PR-01',
    question: 'Q-13',
    title: 'Habitación sin niños: forma de ChildrenAges',
    run: probeChildrenAges,
  },
  {
    id: 'PR-02',
    question: 'Q-18',
    title: 'Filters.MealType como "All" y como 0',
    run: probeMealType,
  },
  { id: 'PR-03', question: 'Q-03', title: 'El mismo Search por https://', run: probeHttps },
  {
    id: 'PR-04',
    question: 'Q-05',
    title: 'Casing de los paths: PDF frente a Postman',
    run: probeCasing,
  },
  {
    id: 'PR-05',
    question: 'Q-37',
    title: 'BookingDetail con un BookingReferenceId inexistente',
    run: probeUnknownReference,
  },
  { id: 'PR-06', question: 'Q-07', title: 'Credenciales erróneas', run: probeBadCredentials },
  {
    id: 'PR-07',
    question: 'Q-08',
    title: 'PreBook con un BookingCode inventado',
    run: probeFakeBookingCode,
  },
  { id: 'PR-08', question: 'Q-15', title: 'Search con 101 HotelCodes', run: probeHotelCodeLimit },
]);

/** Las de reserva (PR-09 a PR-11) viven en `booking-probes.mjs`; sólo corren con `--bookings`. */
export { BOOKING_PROBES };

const ALL_PROBES = Object.freeze([...PROBES, ...BOOKING_PROBES]);

function renderMarkdown(summary) {
  const lines = [
    `# Sondas TBO — corrida ${summary.runId}`,
    '',
    `Endpoint: ${summary.baseUrl} · CheckIn ${summary.checkIn} · CheckOut ${summary.checkOut}`,
    '',
    'Capturas crudas: no se versionan (docs/tbo/07 §6.9). Lo que se versiona es la respuesta',
    'transcrita a docs/tbo/10-preguntas-para-tbo.md.',
    '',
  ];
  for (const probe of summary.probes) {
    lines.push(`## ${probe.id} · ${probe.question} · ${probe.title}`, '');
    if (probe.variants.length > 0) {
      lines.push(
        '| Variante | HTTP | Status.Code | Description | ms | ACL |',
        '| --- | --- | --- | --- | --- | --- |',
      );
      for (const v of probe.variants) {
        const cells = [
          v.label,
          v.httpStatus === 0 ? `— (${v.transportError ?? 'sin respuesta'})` : String(v.httpStatus),
          v.tboCode === null ? '—' : String(v.tboCode),
          v.description ?? '—',
          v.latencyMs === null ? '—' : String(v.latencyMs),
          v.acl ?? '—',
        ].map((cell) => String(cell).replaceAll('|', '\\|'));
        lines.push(`| ${cells.join(' | ')} |`);
      }
      lines.push('');
    }
    lines.push(`**Lectura.** ${probe.reading}`, '');
  }
  return lines.join('\n');
}

/**
 * Corre las sondas pedidas, en orden. Antes, un Search del caso 1 como control: si las
 * credenciales o el endpoint no responden, cada sonda contestaría "401" o "sin red" y no habría
 * nada que transcribir.
 *
 * @returns {Promise<boolean>} `false` si el control falló.
 */
export async function runProbes(harness, out, { ids, skipHotelCodeList }) {
  const { settings } = harness;
  out(
    `TBO probe · ${settings.baseUrl} · CheckIn ${settings.checkIn} · ${settings.nights} noches · ` +
      `sondas ${ids.join(', ')}`,
  );

  const preflight = await harness.step(
    harness.evidence.folder('probes/00-control'),
    'caso1',
    (step) =>
      harness
        .adapter(step)
        .searchAvailabilityReport(harness.criteriaCaseOne(), harness.searchContext),
  );
  const control = variantResult('control', preflight, outcomeOfSearch(preflight));
  out(`  Control (Search caso 1): ${describeVariant(control)}`);
  if (!acceptedByTbo(control)) {
    out(
      '  El control no pasó: sin un Search que funcione las sondas no contestan nada. Corre `check`.',
    );
    return false;
  }
  if (control.tboCode === 201) {
    out('  OJO: el control dio 201 (sin disponibilidad). Las sondas de Search contestarán poco.');
  }

  const state = {};
  const results = [];
  for (const probe of ALL_PROBES.filter((p) => ids.includes(p.id))) {
    out(`\n${probe.id} · ${probe.question} · ${probe.title}`);
    const folder = harness.evidence.folder(`probes/${probe.id}`);
    const outcome = await probe.run(harness, folder, state, { skipHotelCodeList });
    for (const variant of outcome.variants) {
      out(`  ${variant.label}: ${describeVariant(variant)}`);
    }
    out(`  Lectura: ${outcome.reading}`);
    results.push({
      id: probe.id,
      question: probe.question,
      title: probe.title,
      skipped: outcome.skipped === true,
      ...(outcome.source === undefined ? {} : { source: outcome.source }),
      reading: outcome.reading,
      variants: outcome.variants,
    });
  }

  const summary = {
    runId: harness.evidence.runId,
    baseUrl: settings.baseUrl,
    checkIn: settings.checkIn,
    checkOut: settings.checkOut,
    control,
    probes: results,
  };
  await harness.evidence.writeJson('probes/summary.json', summary);
  await harness.evidence.writeText('probes/summary.md', renderMarkdown(summary));
  return true;
}
