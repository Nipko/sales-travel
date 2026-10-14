import { describe, expect, it } from 'vitest';
import {
  CERT_RUN_DEFAULT_OUT,
  CERT_RUN_DEFAULT_ROUTES,
  CertRunArgsError,
  parseCertRunArgs,
} from './cli-args.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function problems(argv: string[]): readonly string[] {
  try {
    parseCertRunArgs(argv);
  } catch (e) {
    if (e instanceof CertRunArgsError) return e.problems;
    throw e;
  }
  throw new Error('se esperaba un rechazo');
}

describe('parseCertRunArgs', () => {
  it('con lo mínimo aplica los defaults', () => {
    expect(parseCertRunArgs(['--owner-tenant', TENANT, '--scenarios', 'sab-12'])).toEqual({
      ownerTenant: TENANT,
      scenarios: ['sab-12'],
      routes: CERT_RUN_DEFAULT_ROUTES.split(','),
      pax: '1ADT',
      days: 30,
      allowMoney: false,
      out: CERT_RUN_DEFAULT_OUT,
      planOnly: false,
      help: false,
    });
  });

  it('lee todas las opciones', () => {
    const args = parseCertRunArgs([
      '--owner-tenant',
      TENANT,
      '--account',
      TENANT,
      '--scenarios',
      'book-issue-void,shop',
      '--routes',
      'BOG-LIM,LIM-GRU',
      '--book-route',
      'LIM-GRU',
      '--pax',
      '2ADT1CHD',
      '--days',
      '45',
      '--return-days',
      '7',
      '--allow-money',
      '--out',
      '/tmp/cert',
      '--run-id',
      'gh-123-1',
    ]);
    expect(args).toMatchObject({
      scenarios: ['book-issue-void', 'shop'],
      bookRoute: 'LIM-GRU',
      days: 45,
      returnDays: 7,
      allowMoney: true,
      out: '/tmp/cert',
      runId: 'gh-123-1',
    });
  });

  it('--plan no necesita tenant: no toca la base', () => {
    expect(parseCertRunArgs(['--plan', '--scenarios', 'auth']).planOnly).toBe(true);
    expect(problems(['--scenarios', 'auth'])).toEqual([
      '--owner-tenant: falta --owner-tenant: el tenant desde el que se resuelve la cuenta CERT',
    ]);
  });

  it.each([
    [['--run-id', '../../etc']],
    [['--run-id', '..']],
    [['--out', '/tmp/../etc']],
    [['--out', 'relativa']],
    [['--owner-tenant', 'no-es-uuid']],
    [['--routes', 'BOG-LIM;rm -rf /']],
    [['--desconocida']],
  ])('rechaza %j', (extra) => {
    expect(problems(['--plan', '--scenarios', 'auth', ...extra]).length).toBeGreaterThan(0);
  });
});
