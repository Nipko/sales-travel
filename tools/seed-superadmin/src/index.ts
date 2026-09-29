import { runCli } from './cli.js';

/**
 * Deja al superadmin en la plataforma (Planetour): promueve o crea el tenant `platform` y le da el
 * rol `superadmin` al usuario. One-shot e idempotente; se corre a mano en el VPS con `docker run`
 * en la red interna. Ver tools/seed-superadmin/README.md e infrastructure/hostinger/README.md §7.
 */
void runCli({ env: process.env }).then((code) => {
  process.exitCode = code;
});
