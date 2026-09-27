import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cert-cases.mjs';
import { TEST_PASSWORD, TEST_TOKEN, TEST_USERNAME, createFakeTbo } from './fake-tbo.mjs';

/**
 * El arnés de punta a punta contra el TBO falso, para los tests: el ACL real (`dist`), el `fetch`
 * grabador y la escritura en disco, sin red y sin credenciales reales. Cada llamada usa una raíz
 * temporal propia salvo que se le pase `outRoot` (para encadenar `run` y `zip` sobre una corrida).
 */

export const NOW = Date.parse('2026-09-26T12:00:00Z');

/** Lo que exigen los comandos que reservan y el zip: buzón de rol, teléfono ficticio y empresa. */
export const BOOKING_ENV = Object.freeze({
  TBO_CERT_EMAIL: 'reservas-cert@example.com',
  TBO_CERT_PHONE: '573000000000',
  TBO_COMPANY_SLUG: 'SalesTravel',
});

const roots = [];

export async function cleanup() {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

export async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'tbo-cert-'));
  roots.push(root);
  return root;
}

export async function runHarness(
  argv,
  {
    fake = createFakeTbo(),
    env = {},
    outRoot,
    now = NOW,
    sleeps = [],
    withBooking = true,
    gitDirty = false,
  } = {},
) {
  const root = outRoot ?? (await newRoot());
  const stdout = [];
  const stderr = [];
  const code = await main(argv, {
    env: {
      TBO_USERNAME: TEST_USERNAME,
      TBO_PASSWORD: TEST_PASSWORD,
      ...(withBooking ? BOOKING_ENV : {}),
      ...env,
    },
    envFile: join(root, 'no-existe.env'),
    fetch: fake.fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    outRoot: root,
    gitSha: 'sha-de-prueba',
    gitDirty,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  const runs = (await readdir(root)).filter((n) => n !== 'no-existe.env');
  return {
    code,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    fake,
    root,
    runs,
    dir: runs.length === 1 ? join(root, runs[0]) : undefined,
  };
}

export async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

export const SECRET_NEEDLES = Object.freeze([
  TEST_USERNAME,
  TEST_PASSWORD,
  JSON.stringify(TEST_PASSWORD).slice(1, -1),
  TEST_TOKEN,
]);

/** G-1: nada de lo escrito ni de lo impreso contiene la credencial, en ninguna forma. */
export async function assertNoSecrets(result) {
  for (const needle of SECRET_NEEDLES) {
    assert.ok(!result.stdout.includes(needle), 'stdout');
    assert.ok(!result.stderr.includes(needle), 'stderr');
  }
  if (result.dir === undefined) return;
  for await (const path of files(result.dir)) {
    const content = await readFile(path);
    for (const needle of SECRET_NEEDLES) assert.ok(!content.includes(needle), path);
  }
}

export async function jsonl(path) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
