import { runCli } from './cli.js';

/**
 * Seed del tenant de certificación de TBO (docs/tbo/07 §7.3; 09 PR-7.2). Lo corre el job
 * `deploy-cert` de .github/workflows/deploy.yml con `docker run --env-file seed.env` en la red
 * interna del stack, después de `up`. Ver el README.
 */
void runCli({ env: process.env }).then((code) => {
  process.exitCode = code;
});
