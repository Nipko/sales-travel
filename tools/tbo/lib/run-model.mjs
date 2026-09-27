import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { listRunFiles, peekEnvelope } from './evidence.mjs';

/**
 * Una corrida en disco como la leen las guardas (`guards.mjs`): los casos promovidos
 * (`CaseNN_…/`), sus llamadas con los bytes de cada RQ y RS, y todos los archivos de la corrida.
 * Lo único que hace I/O antes de `verify` y `zip`; lo demás es puro.
 */

const CASE_DIR = /^Case(\d{2})_[A-Za-z0-9_]+$/;

function parseJsonl(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function requestJson(bytes) {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Busca el archivo de una llamada en la carpeta del caso: las rutas viejas no importan. */
function attach(byPath, folder, file, parse) {
  if (typeof file !== 'string') return undefined;
  const name = posix.basename(file);
  const found = byPath.get(`${folder}/${name}`);
  if (found === undefined) return { name, bytes: undefined, json: undefined, missing: true };
  return { name, bytes: found.bytes, json: parse(found.bytes) };
}

/** Lo que entra al zip, en orden: por caso, cada RQ y RS de `calls.jsonl` por número de llamada. */
export function zipEntriesOf(cases) {
  const entries = [];
  for (const kase of [...cases].sort((a, b) => a.id - b.id)) {
    for (const call of [...kase.calls].sort((a, b) => a.seq - b.seq)) {
      for (const part of [call.request, call.response]) {
        if (part?.bytes !== undefined) {
          entries.push({ name: `${kase.folder}/${part.name}`, bytes: part.bytes });
        }
      }
    }
  }
  return entries;
}

/**
 * @param {import('./evidence.mjs').Evidence} evidence
 * @param {{ skip?: (path: string) => boolean }} [options] Archivos que no se leen (el zip mismo).
 */
export async function loadRunModel(evidence, { skip = (path) => path.endsWith('.zip') } = {}) {
  const dir = evidence.dir;
  const files = [];
  for (const path of await listRunFiles(dir)) {
    if (skip(path)) continue;
    files.push({ path, bytes: await readFile(join(dir, path)) });
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const text = (path) => byPath.get(path)?.bytes.toString('utf8');

  const folders = [
    ...new Set(files.map((f) => f.path.split('/')[0]).filter((top) => CASE_DIR.test(top))),
  ].sort();
  const cases = [];
  const duplicates = [];
  for (const folder of folders) {
    const id = Number(CASE_DIR.exec(folder)[1]);
    if (cases.some((c) => c.id === id)) {
      duplicates.push(folder);
      continue;
    }
    const meta = text(`${folder}/case.json`);
    const calls = parseJsonl(text(`${folder}/calls.jsonl`) ?? '').map((record) => ({
      ...record,
      label: record.label || null,
      request: attach(byPath, folder, record.requestFile, requestJson),
      response: attach(byPath, folder, record.responseFile, (bytes) => peekEnvelope(bytes).json),
    }));
    cases.push({ id, folder, meta: meta === undefined ? undefined : JSON.parse(meta), calls });
  }

  const run = text('run.json');
  const index = text('attempts/index.jsonl');
  return {
    runId: evidence.runId,
    run: run === undefined ? undefined : JSON.parse(run),
    cases,
    duplicates,
    files,
    attempts: index === undefined ? [] : parseJsonl(index),
    entries: zipEntriesOf(cases),
  };
}
