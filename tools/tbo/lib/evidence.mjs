import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * La corrida en disco: `.tbo-cert/<runId>/` (docs/tbo/07 §6.3), ignorado por Git. Todo lo que el
 * arnés escribe pasa por aquí, así que la guarda final de secretos sabe dónde buscar.
 */

/** `2026-10-15T14-03-22Z`: ISO sin milisegundos y sin `:`, que Windows no admite en un nombre. */
export function newRunId(epochMs) {
  return new Date(epochMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '-');
}

/** Un nombre de archivo portable: sin separadores, sin `:` y sin espacios. */
export function safeName(label) {
  return String(label)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

class EvidenceFolder {
  #seq = 0;
  #resumed = false;

  constructor(root, rel) {
    this.rel = rel;
    this.dir = join(root, rel);
  }

  /**
   * Numeración por llamada dentro de la carpeta: el orden de la cadena se lee en el nombre. Una
   * carpeta que ya tiene capturas de otra invocación (`cancel` dos veces, `run --resume` con
   * `TBO_CITY_CODE`) sigue su numeración: con `01` otra vez se escribiría encima de evidencia.
   */
  nextSeq() {
    if (!this.#resumed) {
      this.#resumed = true;
      if (existsSync(this.dir)) {
        for (const name of readdirSync(this.dir)) {
          const match = /^(\d+)_/.exec(name);
          if (match !== null) this.#seq = Math.max(this.#seq, Number(match[1]));
        }
      }
    }
    this.#seq += 1;
    return String(this.#seq).padStart(2, '0');
  }

  /** Escribe y devuelve la ruta relativa a la corrida, con `/` en cualquier sistema. */
  async write(name, data) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), data);
    return toPosix(join(this.rel, name));
  }

  async appendJsonl(name, record) {
    await this.appendLine(name, JSON.stringify(record));
  }

  async appendLine(name, line) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, name), `${line}\n`);
  }
}

function toPosix(path) {
  return path.split(sep).join('/');
}

export class Evidence {
  #folders = new Map();

  constructor(dir, runId) {
    this.dir = dir;
    this.runId = runId;
  }

  folder(rel) {
    const key = toPosix(rel);
    let folder = this.#folders.get(key);
    if (folder === undefined) {
      folder = new EvidenceFolder(this.dir, rel);
      this.#folders.set(key, folder);
    }
    return folder;
  }

  async writeJson(rel, value) {
    const path = join(this.dir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    return toPosix(rel);
  }

  async writeText(rel, text) {
    const path = join(this.dir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
    return toPosix(rel);
  }

  async readJson(rel) {
    try {
      return JSON.parse(await readFile(join(this.dir, rel), 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /**
   * Mueve la carpeta de un intento a su nombre definitivo (`attempts/Case01_…/try-01` →
   * `Case01_1Room_1A`). Si el caso ya tenía carpeta —una corrida retomada con `--resume`; la del 7
   * puede llamarse distinto según la ocupación—, la anterior pasa a `attempts/superseded/<stamp>/`:
   * nunca se escribe encima de evidencia. Las rutas de `calls.jsonl` se reescriben para que sigan
   * apuntando a los archivos.
   *
   * @param {string} casePrefix `Case07_`: toda carpeta de la raíz con ese prefijo es del mismo caso.
   */
  async promote(fromRel, toRel, stamp, casePrefix) {
    const from = join(this.dir, fromRel);
    const to = join(this.dir, toRel);
    const previous = (await readdir(this.dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith(casePrefix ?? `${toRel}\u0000`))
      .map((e) => e.name);
    if (existsSync(to) && !previous.includes(toRel)) previous.push(toRel);
    for (const name of previous) {
      let parked = toPosix(join('attempts', 'superseded', stamp, name));
      for (let n = 2; existsSync(join(this.dir, parked)); n++) {
        parked = toPosix(join('attempts', 'superseded', `${stamp}-${n}`, name));
      }
      await mkdir(join(this.dir, parked, '..'), { recursive: true });
      await rename(join(this.dir, name), join(this.dir, parked));
      await relocateCalls(join(this.dir, parked), name, parked);
    }
    await mkdir(join(to, '..'), { recursive: true });
    await rename(from, to);
    this.#folders.delete(toPosix(fromRel));
    await relocateCalls(to, toPosix(fromRel), toPosix(toRel));
  }
}

async function relocateCalls(dir, fromRel, toRel) {
  const path = join(dir, 'calls.jsonl');
  if (!existsSync(path)) return;
  const move = (value) =>
    typeof value === 'string' && value.startsWith(`${fromRel}/`)
      ? `${toRel}${value.slice(fromRel.length)}`
      : value;
  const lines = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const record = JSON.parse(line);
      for (const key of ['requestFile', 'responseFile', 'aclRequestFile']) {
        if (key in record) record[key] = move(record[key]);
      }
      if (record.folder === fromRel) record.folder = toRel;
      return JSON.stringify(record);
    });
  await writeFile(path, lines.map((line) => `${line}\n`).join(''));
}

/**
 * Crea la carpeta de la corrida. Dos corridas en el mismo segundo no comparten carpeta: la segunda
 * lleva sufijo, y nunca se escribe encima de evidencia anterior.
 */
export async function createEvidence(rootDir, runId) {
  await mkdir(rootDir, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const id = attempt === 1 ? runId : `${runId}-${attempt}`;
    const dir = join(rootDir, id);
    try {
      await mkdir(dir);
      return new Evidence(dir, id);
    } catch (err) {
      if (err?.code !== 'EEXIST' || attempt >= 50) throw err;
    }
  }
}

/** Un id de corrida que vale como nombre de carpeta y no sale de `.tbo-cert/`. */
export function isRunId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value);
}

/** Una corrida existente (`run --resume`, `verify`, `zip`), o `undefined` si no está. */
export function openEvidence(rootDir, runId) {
  if (!isRunId(runId)) return undefined;
  const dir = join(rootDir, runId);
  return existsSync(dir) ? new Evidence(dir, runId) : undefined;
}

/** Todos los archivos de la corrida, con su ruta relativa en `/`, ordenados. */
export async function listRunFiles(dir) {
  const out = [];
  for await (const path of walk(dir)) out.push(toPosix(relative(dir, path)));
  return out.sort();
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * G-1 sobre el disco (07 §6.7): ningún archivo de la corrida contiene el usuario, la contraseña ni
 * el token Basic. La red de seguridad detrás de la redacción al escribir: si alguna vez encuentra
 * algo, es un bug del arnés y la corrida se da por comprometida.
 */
export async function findSecretsOnDisk(dir, secrets) {
  const leaks = [];
  for await (const path of walk(dir)) {
    const hits = secrets.findIn(await readFile(path));
    if (hits.length > 0) leaks.push({ file: toPosix(relative(dir, path)), secrets: hits });
  }
  return leaks;
}

function pick(object, name) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const key = Object.keys(object).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}

/**
 * Lo que el arnés lee de un RS para contarlo: el JSON (si lo es) y `Status.Code`/`Description`
 * sin distinguir mayúsculas, como el envelope del ACL (docs/tbo/01 §8.1). Sólo informa: la
 * clasificación que cuenta es la del ACL.
 */
export function peekEnvelope(bytes) {
  let json;
  try {
    // `TextDecoder` quita el BOM, que `JSON.parse` no acepta.
    json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    return { json: undefined, tboCode: undefined, description: undefined };
  }
  const status = pick(json, 'Status');
  const code = pick(status, 'Code');
  const description = pick(status, 'Description');
  const numeric = typeof code === 'string' && /^\d+$/.test(code) ? Number(code) : code;
  return {
    json,
    tboCode: Number.isInteger(numeric) ? numeric : undefined,
    description: typeof description === 'string' ? description : undefined,
  };
}

export { pick as pickInsensitive };
