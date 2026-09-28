import { describe, expect, it } from 'vitest';
import { JsonLogger, REDACTED } from './log.js';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): {
  logger: JsonLogger;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = new JsonLogger({
    level,
    sink: (line) => lines.push(line),
    clock: () => new Date('2026-09-25T08:00:00.000Z'),
  });
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('una línea JSON por evento, con las bindings del hijo', () => {
    const { logger, lines } = capture();
    logger.child({ component: 'tbo-http' }).info('tbo.sync.stage', { stage: 'E1', calls: 1 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-09-25T08:00:00.000Z',
      level: 'info',
      msg: 'tbo.sync.stage',
      component: 'tbo-http',
      stage: 'E1',
      calls: 1,
    });
  });

  it('respeta el nivel', () => {
    const { logger, lines } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['c', 'd']);
  });

  it('una clave con forma de credencial nunca sale con su valor, a cualquier profundidad (RF-30 CA 4)', () => {
    const { logger, lines } = capture();
    logger.error('x', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz', accept: 'application/json' },
      password: 'secreto',
      username: 'usuario',
      nested: [{ apiKey: 'k', accountRef: 'abcd' }],
    });
    const line = lines[0] ?? '';
    expect(line).not.toContain('dXNlcjpwYXNz');
    expect(line).not.toContain('secreto');
    expect(line).not.toContain('usuario');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['headers']).toEqual({ Authorization: REDACTED, accept: 'application/json' });
    expect(parsed['nested']).toEqual([{ apiKey: REDACTED, accountRef: 'abcd' }]);
  });

  it('meta imposible de serializar o un sink que lanza no tumban la corrida', () => {
    const { logger, lines } = capture();
    logger.info('ciclo', { big: 10n, when: new Date('2026-01-01T00:00:00Z') });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      big: '10',
      when: '2026-01-01T00:00:00.000Z',
    });

    const broken = new JsonLogger({
      level: 'info',
      sink: () => {
        throw new Error('stdout cerrado');
      },
    });
    expect(() => broken.info('x')).not.toThrow();
  });
});
