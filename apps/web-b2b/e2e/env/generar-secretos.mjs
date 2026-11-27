// Crea e2e/.env.e2e (fuera de git) con contraseñas y llaves al azar para el stack E2E local
// (docker-compose.e2e.yml). Si ya existe no lo toca: la base del stack se crea con esas contraseñas.
// Lo corre `pnpm e2e:up`; `pnpm e2e:down` borra la base, y se puede borrar el archivo para rotarlas.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const destino = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.e2e');

if (existsSync(destino)) {
  console.log(`e2e: uso los secretos de ${path.relative(process.cwd(), destino)}`);
  // Un archivo de antes del secreto del proxy: se le suma sin tocar lo demás (la base ya existe).
  if (!readFileSync(destino, 'utf8').includes('E2E_INTERNAL_PROXY_SECRET=')) {
    appendFileSync(destino, `E2E_INTERNAL_PROXY_SECRET=${randomBytes(32).toString('hex')}\n`);
  }
} else {
  const texto = (bytes) => randomBytes(bytes).toString('hex');
  const llave = () => randomBytes(32).toString('base64');
  const contenido = [
    '# Generado por e2e/env/generar-secretos.mjs. Sólo para el stack E2E local; nunca va a git.',
    `E2E_PG_PASSWORD=${texto(16)}`,
    `E2E_APP_USER_PASSWORD=${texto(16)}`,
    `E2E_JWT_SECRET=${texto(32)}`,
    `E2E_PROVIDER_CREDENTIALS_KEY=${llave()}`,
    `E2E_PROVIDER_PAYLOADS_KEY=${llave()}`,
    `E2E_INTERNAL_PROXY_SECRET=${texto(32)}`,
    '',
  ].join('\n');
  writeFileSync(destino, contenido, { mode: 0o600 });
  console.log(`e2e: secretos nuevos en ${path.relative(process.cwd(), destino)}`);
}
