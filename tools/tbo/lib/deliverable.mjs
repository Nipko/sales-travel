import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CERT_CASES, SYNTHETIC_FIRST_NAMES, SYNTHETIC_LAST_NAMES, certCase } from './cases.mjs';
import { isTboTestEndpoint } from './env.mjs';
import {
  blockingFailures,
  chainOf,
  checkpointTable,
  evaluateGuards,
  g1Credentials,
  pick,
} from './guards.mjs';
import { loadRunModel } from './run-model.mjs';
import { createZip, readZip } from './zip.mjs';

/**
 * `verify` y `zip` (docs/tbo/07 §6.3 y §5): las guardas sobre una corrida ya hecha, sin red.
 * `verify` escribe `selfcheck.md`; `zip` vuelve a pasar las guardas, escribe `README.txt` y
 * `manifest.json` (SHA-256 por archivo) y arma el zip. Si una guarda que aborta falla, no hay zip.
 */

const pad2 = (n) => String(n).padStart(2, '0');

function guardContext({ secrets, acl, allowNonTestHost }) {
  return {
    secrets,
    firstNames: SYNTHETIC_FIRST_NAMES,
    lastNames: SYNTHETIC_LAST_NAMES,
    isTestEndpoint: (baseUrl) => isTboTestEndpoint(baseUrl, acl),
    allowNonTestHost,
  };
}

const cell = (value) =>
  String(value ?? '—')
    .replaceAll('|', '\\|')
    .replace(/\s+/g, ' ');

/** Motivos de descarte que son hallazgos del ACL o del contrato, no falta de inventario. */
const FINDING =
  /Mapping|UNKNOWN_CODE|MALFORMED|CLIENT_BUG|unreadable|malformed|book-uncertain|book-recovered|detail:/;

export function renderSelfcheck(model, guards, checkpoints, generatedAt) {
  const blocking = blockingFailures(guards);
  const run = model.run ?? {};
  const lines = [
    `# selfcheck · corrida ${model.runId}`,
    '',
    `Endpoint: ${run.baseUrl ?? '—'} · build ${run.gitSha ?? 'sin SHA'}${run.gitDirty ? ' (con cambios sin commitear)' : ''} · generado ${generatedAt}`,
    '',
    blocking.length === 0
      ? '**Resultado: se puede armar el zip.** Revisa igual las advertencias y los checkpoints.'
      : `**Resultado: NO se puede armar el zip** (${blocking.map((g) => g.id).join(', ')}).`,
    '',
    '## Guardas (docs/tbo/07 §6.7)',
    '',
    '| ID | Guarda | Si falla | Resultado | Detalle |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const g of guards) {
    const detail = [...g.findings, ...g.notes].slice(0, 12).join('; ');
    lines.push(
      `| ${g.id} | ${cell(g.title)} | ${g.blocking ? 'aborta' : 'advierte'} | ${g.ok ? 'ok' : g.blocking ? 'FALLA' : 'advertencia'} | ${cell(detail || '—')} |`,
    );
  }
  lines.push(
    '',
    '## Checkpoints visibles en el JSON (07 §3, reconstruidos: TBO no publica su lista)',
    '',
    '| CK | Estado | Base | Nota |',
    '| --- | --- | --- | --- |',
  );
  for (const row of checkpoints) {
    lines.push(
      `| ${row.ck} | ${row.status} | ${cell(row.basis)} | ${cell((row.notes ?? []).join('; ') || '—')} |`,
    );
  }
  lines.push(
    '',
    'CK-07, CK-09, CK-16, CK-17 y CK-18 se ven sólo en el portal (U-01 a U-20).',
    '',
    '## Casos',
    '',
    '| Caso | Carpeta | Llamadas | HotelCode | ConfirmationNumber | BookingReferenceId | Estado final |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of caseRows(model)) {
    lines.push(
      `| ${row.id} | ${cell(row.folder)} | ${row.calls} | ${cell(row.hotelCode)} | ${cell(row.confirmationNumber)} | ${cell(row.bookingReferenceId)} | ${cell(row.cancelled)} |`,
    );
  }
  const discarded = model.attempts.filter((a) => a.promotedTo === undefined);
  lines.push(
    '',
    `## Intentos descartados (${discarded.length}, en attempts/; no entran al zip)`,
    '',
  );
  if (discarded.length === 0) lines.push('Ninguno.');
  for (const a of discarded) {
    lines.push(
      `- Caso ${pad2(a.case)} · ${a.try} · CheckIn ${a.checkIn} · ${a.status} · ${a.reason}`,
    );
  }
  const findings = discarded.filter((a) => FINDING.test(a.reason));
  lines.push('', '## Hallazgos', '');
  if (findings.length === 0) lines.push('Ninguno entre los intentos descartados.');
  for (const a of findings) {
    lines.push(
      `- Caso ${pad2(a.case)} · ${a.try}: ${a.reason}. El RQ y el RS están en esa carpeta: revisar contra el ACL antes de enviar (07 §6.4).`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function cancelledText(kase, afterCancel) {
  if (kase.meta?.cancelAfter === false) return 'no (TBO_CANCEL_AFTER=false)';
  const status = pick(pick(afterCancel?.response?.json, 'BookingDetail'), 'BookingStatus');
  if (typeof status === 'string') return status;
  return afterCancel === undefined ? 'no' : 'unknown';
}

/** Los datos de cada caso, leídos de los bytes que salieron y llegaron (no de `case.json`). */
export function caseRows(model) {
  const case4 = model.cases.find((c) => c.id === 4);
  return CERT_CASES.map((def) => {
    const kase = model.cases.find((c) => c.id === def.id);
    if (kase === undefined) return { id: pad2(def.id), folder: 'falta', calls: 0 };
    if (def.id === 8) {
      const book4 = case4 === undefined ? undefined : chainOf(case4).book;
      return {
        id: pad2(def.id),
        folder: kase.folder,
        calls: kase.calls.length,
        occupancy: def.occupancyText,
        confirmationNumber: pick(book4?.response?.json, 'ConfirmationNumber'),
        bookingReferenceId: pick(book4?.request?.json, 'BookingReferenceId'),
      };
    }
    const c = chainOf(kase);
    const hotel = pick(c.prebook?.response?.json, 'HotelResult');
    return {
      id: pad2(def.id),
      folder: kase.folder,
      calls: kase.calls.length,
      occupancy:
        def.occupancyOf === undefined
          ? def.occupancyText
          : `Supplements (occupancy of case ${pad2(kase.meta?.occupancyOf ?? def.occupancyOf[0])})`,
      nationality: pick(c.search?.request?.json, 'GuestNationality'),
      hotelCode: Array.isArray(hotel) ? pick(hotel[0], 'HotelCode') : undefined,
      bookingCode: pick(c.book?.request?.json, 'BookingCode'),
      confirmationNumber: pick(c.book?.response?.json, 'ConfirmationNumber'),
      bookingReferenceId: pick(c.book?.request?.json, 'BookingReferenceId'),
      cancelled: cancelledText(kase, c.afterCancel),
      supplements: supplementsText(c.prebook?.response?.json),
    };
  });
}

function supplementsText(prebookRs) {
  const hotel = pick(prebookRs, 'HotelResult');
  const rooms = pick(Array.isArray(hotel) ? hotel[0] : undefined, 'Rooms');
  const option = Array.isArray(rooms) ? rooms[0] : undefined;
  const supplements = pick(option, 'Supplements');
  if (!Array.isArray(supplements)) return [];
  return supplements
    .flatMap((item) => (Array.isArray(item) ? item : [item]))
    .map(
      (s) =>
        `${pick(s, 'Type')} ${pick(s, 'Description')} ${amountText(pick(s, 'Price'))} ${pick(s, 'Currency')} (room ${pick(s, 'Index') ?? '?'})`,
    );
}

/** `20` → `20.00`; con tres decimales o más sale como llegó, sin redondear. */
function amountText(value) {
  if (typeof value !== 'number') return String(value);
  const decimals = (String(value).split('.')[1] ?? '').length;
  return decimals < 2 ? value.toFixed(2) : String(value);
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) =>
    r
      .map((v, i) => String(v).padEnd(widths[i]))
      .join(' | ')
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** `README.txt` en inglés (07 §5): índice de casos y de cada llamada. */
export function renderReadme(model, { companySlug, generatedAt }) {
  const run = model.run ?? {};
  const rows = caseRows(model);
  const lines = [
    'TBO Holidays Hotel API (JSON V2.1) - certification samples',
    `Company: ${companySlug}   Run: ${model.runId}   Endpoint: ${run.baseUrl}`,
    `Application build: ${run.gitSha ?? 'unknown'}${run.gitDirty ? ' (with uncommitted changes)' : ''}   Generated: ${generatedAt}`,
    '',
    'Sequence per case: Search > PreBook > Book > BookingDetail > Cancel (If Required).',
    'Our cancellation reads BookingDetail right before sending Cancel and again right after it,',
    'as our application does; both reads are included (_BeforeCancel and _AfterCancel files).',
    'Case 08 is BookingDetail of the case 04 booking, by ConfirmationNumber and by',
    'BookingReferenceId, called after the case 04 Book and before its Cancel.',
    '',
    ...table(
      rows
        .filter((r) => r.id !== '08')
        .map((r) => [
          r.id,
          r.occupancy ?? '—',
          r.nationality ?? '—',
          r.hotelCode ?? '—',
          r.bookingCode ?? '—',
          r.confirmationNumber ?? '—',
          r.bookingReferenceId ?? '—',
          r.cancelled ?? '—',
        ]),
      [
        'Case',
        'Occupancy (as requested by TBO)',
        'GuestNationality',
        'HotelCode',
        'BookingCode',
        'ConfirmationNumber',
        'BookingReferenceId',
        'Cancelled',
      ],
    ),
  ];
  const seven = rows.find((r) => r.id === '07');
  if (seven?.supplements?.length > 0) {
    lines.push(`07 supplements found: ${seven.supplements.join('; ')}`);
  }
  const eight = rows.find((r) => r.id === '08');
  lines.push(
    `08 ${certCase(8).occupancyText} (ConfirmationNumber ${eight?.confirmationNumber ?? '—'}, BookingReferenceId ${eight?.bookingReferenceId ?? '—'})`,
    '',
    'Every call (file prefix, UTC start time, HTTP status, Status.Code, latency ms):',
  );
  const calls = [];
  for (const kase of [...model.cases].sort((a, b) => a.id - b.id)) {
    for (const call of [...kase.calls].sort((a, b) => a.seq - b.seq)) {
      const prefix = (call.request?.name ?? call.response?.name ?? '').replace(
        /_R[QS]\.(json|txt)$/,
        '',
      );
      calls.push([
        `${kase.folder}/${prefix}`,
        call.startedAt ?? '—',
        call.httpStatus ?? 'no response',
        call.tboCode ?? '—',
        call.latencyMs ?? '—',
      ]);
    }
  }
  lines.push(...table(calls, ['File', 'Start (UTC)', 'HTTP', 'Status.Code', 'ms']));
  lines.push(
    '',
    'PaymentMode is "Limit" in every PreBook, Book and BookingDetail. No card data is sent.',
    'All guest names, email and phone are synthetic test data.',
    'Request files (_RQ) are the exact bytes our application sent; response files (_RS) are the exact',
    'bytes received. Discarded attempts (no availability, rate no longer available, no supplements)',
    'are not included and can be sent on request.',
    '',
  );
  return lines.join('\r\n');
}

const ZIP_NAME = /_TBO_HotelAPI_JSON_Certification_\d{8}\.zip$/;

/** Zips que ya estaban en la corrida: si las guardas fallan ahora, ninguno se puede enviar. */
async function existingZips(dir) {
  return (await readdir(dir)).filter((name) => ZIP_NAME.test(name));
}

export function zipFileName(companySlug, epochMs) {
  const day = new Date(epochMs).toISOString().slice(0, 10).replaceAll('-', '');
  return `${companySlug}_TBO_HotelAPI_JSON_Certification_${day}.zip`;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function buildManifest(model, entries, { companySlug, generatedAt }) {
  return {
    runId: model.runId,
    company: companySlug,
    generatedAt,
    gitSha: model.run?.gitSha ?? null,
    gitDirty: model.run?.gitDirty ?? null,
    baseUrl: model.run?.baseUrl ?? null,
    files: entries.map((e) => ({ name: e.name, bytes: e.bytes.length, sha256: sha256(e.bytes) })),
  };
}

async function evaluate(evidence, ctx, now) {
  const model = await loadRunModel(evidence);
  const guards = evaluateGuards(model, guardContext(ctx));
  const checkpoints = checkpointTable(model, guards);
  const generatedAt = new Date(now()).toISOString();
  await evidence.writeText(
    'selfcheck.md',
    renderSelfcheck(model, guards, checkpoints, generatedAt),
  );
  await evidence.writeJson('selfcheck.json', {
    runId: model.runId,
    generatedAt,
    ok: blockingFailures(guards).length === 0,
    guards,
    checkpoints,
  });
  return { model, guards, checkpoints, generatedAt };
}

function printGuards(guards, say) {
  for (const g of guards) {
    const state = g.ok ? 'ok' : g.blocking ? 'FALLA' : 'advertencia';
    say(`  ${g.id.padEnd(4)} ${state.padEnd(11)} ${g.title}`);
    for (const line of g.findings.slice(0, 5)) say(`         - ${line}`);
    if (g.findings.length > 5) say(`         - … y ${g.findings.length - 5} más (selfcheck.md)`);
  }
}

/** `verify <runId>`: las guardas y `selfcheck.md`. `true` si ninguna que aborta falló. */
export async function verifyRun(evidence, ctx, { now, say }) {
  say(`TBO verify · corrida ${evidence.runId}`);
  const { guards, model } = await evaluate(evidence, ctx, now);
  printGuards(guards, say);
  if (model.run?.gitDirty === true) {
    say(
      '  OJO: la corrida se hizo con cambios sin commitear; el SHA de run.json no identifica el ' +
        'build que TBO certifica (RC-01). Conviene repetirla desde un commit limpio.',
    );
  }
  const blocking = blockingFailures(guards);
  say(
    blocking.length === 0
      ? '  Listo para `zip`. El detalle, los checkpoints y los intentos están en selfcheck.md.'
      : `  No se puede armar el zip: ${blocking.map((g) => g.id).join(', ')}. Detalle en selfcheck.md.`,
  );
  const stale = blocking.length > 0 ? await existingZips(evidence.dir) : [];
  if (stale.length > 0) {
    say(`  OJO: ${stale.join(', ')} es de antes y ya no pasa las guardas: no lo envíes.`);
  }
  return blocking.length === 0;
}

/**
 * `zip <runId>`: las guardas otra vez, `README.txt`, `manifest.json` y el zip. Después de escribirlo
 * lo vuelve a leer: cada CRC y G-1 sobre lo descomprimido. Si algo falla, borra el zip.
 */
export async function zipRun(evidence, ctx, { now, say, companySlug }) {
  say(`TBO zip · corrida ${evidence.runId}`);
  const { model, guards, generatedAt } = await evaluate(evidence, ctx, now);
  const blocking = blockingFailures(guards);
  if (blocking.length > 0) {
    printGuards(guards, say);
    say(`  Sin zip: fallan ${blocking.map((g) => g.id).join(', ')}. Detalle en selfcheck.md.`);
    for (const stale of await existingZips(evidence.dir)) {
      await rm(join(evidence.dir, stale), { force: true });
      say(`  Borré ${stale}: era de antes y ya no pasa las guardas.`);
    }
    return { ok: false };
  }

  const readme = {
    name: 'README.txt',
    bytes: Buffer.from(renderReadme(model, { companySlug, generatedAt }), 'utf8'),
  };
  const manifestJson = buildManifest(model, [readme, ...model.entries], {
    companySlug,
    generatedAt,
  });
  const manifest = {
    name: 'manifest.json',
    bytes: Buffer.from(`${JSON.stringify(manifestJson, null, 2)}\n`, 'utf8'),
  };
  const entries = [readme, manifest, ...model.entries];

  const name = zipFileName(companySlug, now());
  const path = join(evidence.dir, name);
  await writeFile(path, createZip(entries, { modifiedAt: now() }));

  const back = readZip(await readFile(path));
  const problems = [];
  if (back.length !== entries.length || back.some((e, i) => e.name !== entries[i].name)) {
    problems.push('las entradas leídas no son las escritas');
  }
  if (back.some((e) => !e.crcOk)) problems.push('un CRC no coincide');
  const recheck = g1Credentials({ files: [], entries: back }, guardContext(ctx));
  problems.push(...recheck.findings);
  if (problems.length > 0) {
    await rm(path, { force: true });
    say(`  G-1 sobre el zip escrito: ${problems.join('; ')}. Zip borrado.`);
    return { ok: false };
  }
  await evidence.writeText('README.txt', readme.bytes);
  await evidence.writeText('manifest.json', manifest.bytes);
  say(`  ${entries.length} archivos · ${back.length - 2} RQ/RS de ${model.cases.length} casos`);
  say(`  Zip: ${name}`);
  return { ok: true, name, path };
}
