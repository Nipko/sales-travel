import { readFileSync, rmSync } from 'node:fs';
import pg from 'pg';
import { E2E } from './support/env';

/**
 * Antes de cada corrida: vuelve a aplicar la red de prueba (e2e/env/seed.sql), que deja a los usuarios
 * @e2e.test sin MFA ni sesiones, y borra lo que el E2E recordaba de ellos (e2e/.auth). Así cada corrida
 * arranca igual aunque la anterior haya activado MFA.
 */
export default async function globalSetup(): Promise<void> {
  const health = await fetch(`${E2E.apiUrl}/api/health`).catch((err: unknown) => err as Error);
  if (health instanceof Error || !health.ok) {
    throw new Error(
      `El api de E2E no responde en ${E2E.apiUrl}/api/health. Levanta el stack:\n` +
        '  docker compose -f apps/web-b2b/e2e/docker-compose.e2e.yml up -d --build --wait',
    );
  }

  const client = new pg.Client({ connectionString: E2E.pgUrl });
  await client.connect();
  try {
    await client.query(readFileSync(E2E.seedFile, 'utf8'));
  } finally {
    await client.end();
  }

  rmSync(E2E.authDir, { recursive: true, force: true });
}
