import { describe, expect, it } from 'vitest';
import {
  countByLevel,
  daysOpenLabel,
  parsePlatformStatus,
  pendingsFor,
  shortVersion,
  type Pending,
} from './platform-status';

const PENDING = {
  id: 'sabre-h07',
  title: 'Sabre H-07',
  since: '2026-11-05',
  daysOpen: 14,
  level: 'critical',
  why: 'Rodeo temporal.',
  steps: [
    { owner: 'founder', text: 'Pedir a Sabre.' },
    { owner: 'claude', text: 'Quitar el rodeo.' },
  ],
  links: [{ label: 'Hallazgos', href: 'https://github.com/x/y/blob/main/docs/a.md' }],
};

const BODY = {
  generatedAt: '2026-11-19T15:00:00.000Z',
  overall: 'critical',
  areas: [
    {
      id: 'providers',
      label: 'Proveedores',
      level: 'critical',
      summary: '1 proveedor caído: tbo-hotels (hotels).',
      details: ['tbo-hotels (hotels): caído.'],
      href: '/admin/plataforma/salud',
    },
  ],
  runtime: {
    version: 'ccbf4027294181b6856996d7fce58ce5ef1ed1dd',
    startedAt: '2026-11-19T14:27:00.000Z',
  },
  pendings: [PENDING],
};

describe('parsePlatformStatus', () => {
  it('acepta la respuesta del API', () => {
    const s = parsePlatformStatus(BODY);
    expect(s?.overall).toBe('critical');
    expect(s?.areas[0]?.href).toBe('/admin/plataforma/salud');
    expect(s?.pendings[0]?.steps).toHaveLength(2);
  });

  it('rechaza un nivel desconocido, un área con enlace externo o un pendiente con enlace sin https', () => {
    expect(parsePlatformStatus({ ...BODY, overall: 'rojo' })).toBeUndefined();
    expect(
      parsePlatformStatus({ ...BODY, areas: [{ ...BODY.areas[0], href: 'https://otro.sitio' }] }),
    ).toBeUndefined();
    expect(
      parsePlatformStatus({
        ...BODY,
        pendings: [{ ...PENDING, links: [{ label: 'x', href: 'javascript:alert(1)' }] }],
      }),
    ).toBeUndefined();
    expect(
      parsePlatformStatus({
        ...BODY,
        pendings: [{ ...PENDING, steps: [{ owner: 'otro', text: 'x' }] }],
      }),
    ).toBeUndefined();
    expect(parsePlatformStatus(null)).toBeUndefined();
  });
});

describe('rótulos y filtros', () => {
  const pendings = parsePlatformStatus(BODY)!.pendings;
  const onlyFounder: Pending = {
    ...pendings[0]!,
    id: 'otro',
    level: 'medium',
    steps: [{ owner: 'founder', text: 'x' }],
  };

  it('filtra por responsable: un pendiente con pasos de los dos sale en los dos', () => {
    const all = [...pendings, onlyFounder];
    expect(pendingsFor(all, 'all')).toHaveLength(2);
    expect(pendingsFor(all, 'founder').map((p) => p.id)).toEqual(['sabre-h07', 'otro']);
    expect(pendingsFor(all, 'claude').map((p) => p.id)).toEqual(['sabre-h07']);
    expect(countByLevel(all)).toEqual({ critical: 1, high: 0, medium: 1, low: 0 });
  });

  it('días abiertos y versión corta', () => {
    expect(daysOpenLabel(0)).toBe('desde hoy');
    expect(daysOpenLabel(1)).toBe('hace 1 día');
    expect(daysOpenLabel(14)).toBe('hace 14 días');
    expect(shortVersion('ccbf4027294181b6856996d7fce58ce5ef1ed1dd')).toBe('ccbf402');
    expect(shortVersion('dev')).toBe('dev');
  });
});
