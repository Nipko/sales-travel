import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** e2e/.env.e2e: los secretos al azar del stack local (e2e/env/generar-secretos.mjs). */
const ENV_FILE = path.resolve(__dirname, '..', '.env.e2e');

function secretoLocal(nombre: string): string | undefined {
  if (!existsSync(ENV_FILE)) return undefined;
  const linea = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${nombre}=`));
  return linea?.slice(nombre.length + 1).trim();
}

function pgUrlLocal(): string {
  const password = secretoLocal('E2E_PG_PASSWORD');
  if (!password) {
    throw new Error('Falta e2e/.env.e2e: corre `pnpm e2e:up`, o define E2E_PG_URL.');
  }
  return `postgres://postgres:${encodeURIComponent(password)}@localhost:55442/sales_travel`;
}

/** Puertos y rutas del stack E2E (docker-compose.e2e.yml). Todo se puede sobrescribir por env. */
export const E2E = {
  webUrl: process.env['E2E_WEB_URL'] ?? 'http://localhost:3101',
  apiUrl: process.env['E2E_API_URL'] ?? 'http://localhost:4102',
  get pgUrl(): string {
    return process.env['E2E_PG_URL'] ?? pgUrlLocal();
  },
  authDir: path.resolve(__dirname, '..', '.auth'),
  seedFile: path.resolve(__dirname, '..', 'env', 'seed.sql'),
};
