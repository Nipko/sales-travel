import { runCli } from './cli.js';

/**
 * Sync del catálogo de hoteles de TBO (docs/tbo/05 §6; 08 RF-30). Lo dispara un workflow de
 * GitHub Actions por SSH en el VPS, como `tools/sync-hotel-inventory`, pero es otra herramienta
 * (D-TBO-12 A): el job de Despegar, que funciona, no cambia.
 *
 * SIGTERM (el `timeout-minutes` del workflow o un `docker stop`) corta la corrida en orden: la
 * ciudad en curso termina o hace ROLLBACK, se libera el lock y se sale "ok parcial".
 */
const interrupt = new AbortController();
process.once('SIGTERM', () => interrupt.abort());
process.once('SIGINT', () => interrupt.abort());

void runCli({ env: process.env, interrupt: interrupt.signal }).then((code) => {
  process.exitCode = code;
});
