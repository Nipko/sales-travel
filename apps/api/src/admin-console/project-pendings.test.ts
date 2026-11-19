import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCalendarDate } from './admin-overview.schemas.js';
import { PROJECT_PENDINGS, REPO_BLOB_BASE, pendingsView } from './project-pendings.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

describe('PROJECT_PENDINGS: la lista versionada de Plataforma → Estado', () => {
  it('cada id es único y en kebab-case', () => {
    const ids = PROJECT_PENDINGS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('cada fecha existe y no es futura', () => {
    for (const p of PROJECT_PENDINGS) {
      expect(isCalendarDate(p.since), p.id).toBe(true);
      expect(Date.parse(`${p.since}T00:00:00Z`), p.id).toBeLessThanOrEqual(Date.now());
    }
  });

  it('cada pendiente dice qué hacer y quién lo hace', () => {
    for (const p of PROJECT_PENDINGS) {
      expect(p.steps.length, p.id).toBeGreaterThan(0);
      for (const s of p.steps) expect(s.text.trim(), p.id).not.toBe('');
    }
  });

  it('cada enlace al repo apunta a un archivo que existe', () => {
    for (const p of PROJECT_PENDINGS) {
      for (const l of p.links) {
        if (l.target.startsWith('https://')) continue;
        expect(existsSync(resolve(REPO_ROOT, l.target)), `${p.id}: ${l.target}`).toBe(true);
      }
    }
  });
});

describe('pendingsView', () => {
  const NOW = new Date('2026-11-19T15:00:00Z');

  it('cuenta los días abiertos, ordena por gravedad y por antigüedad, y arma los enlaces', () => {
    const view = pendingsView(
      [
        {
          id: 'b',
          title: 'B',
          since: '2026-11-18',
          level: 'medium',
          why: '',
          steps: [{ owner: 'claude', text: 'x' }],
          links: [{ label: 'Doc', target: 'docs/x.md' }],
        },
        {
          id: 'a',
          title: 'A',
          since: '2026-11-19',
          level: 'critical',
          why: '',
          steps: [{ owner: 'founder', text: 'y' }],
          links: [{ label: 'PR', target: 'https://github.com/x/y/pull/1' }],
        },
        {
          id: 'c',
          title: 'C',
          since: '2026-10-01',
          level: 'medium',
          why: '',
          steps: [{ owner: 'founder', text: 'z' }],
          links: [],
        },
      ],
      NOW,
    );
    expect(view.map((p) => [p.id, p.daysOpen])).toEqual([
      ['a', 0],
      ['c', 49],
      ['b', 1],
    ]);
    expect(view[0]!.links[0]!.href).toBe('https://github.com/x/y/pull/1');
    expect(view[2]!.links[0]!.href).toBe(`${REPO_BLOB_BASE}docs/x.md`);
  });
});
