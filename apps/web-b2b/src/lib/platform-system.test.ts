import { describe, expect, it } from 'vitest';
import {
  PLATFORM_SISTEMA,
  airportsLine,
  catalogBadge,
  catalogLine,
  catalogTitle,
  durationLabel,
  elapsedText,
  lastRunLabel,
  parseSystemJobs,
  reconciliationStatus,
  runnerLabel,
  sweepStatus,
  systemErrorMessage,
  systemUpdatedLabel,
  type PostSaleSweep,
  type SystemJobs,
} from './platform-system';
import { runningSweep, systemJobsPayload } from './platform-system.fixture';
import { VOSEO_WORDS, voseoIn } from './voseo';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const MIN = 60_000;

function parsed(overrides: Record<string, unknown> = {}): SystemJobs {
  const jobs = parseSystemJobs(systemJobsPayload(overrides));
  if (jobs === undefined) throw new Error('el fixture no se pudo leer');
  return jobs;
}

function sweep(overrides: Record<string, unknown> = {}): PostSaleSweep {
  return parsed({ postSaleSweep: runningSweep(overrides) }).postSaleSweep;
}

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('parseSystemJobs', () => {
  it('lee la respuesta del API', () => {
    const jobs = parsed();
    expect(jobs.postSaleSweep).toMatchObject({ lastOk: true, stale: false, runs24h: 96 });
    expect(jobs.reconciliation.byProvider[0]).toMatchObject({
      providerCode: 'tbo-hotels',
      criticalItems: 2,
      stale: false,
    });
    expect(jobs.catalogs[0]).toMatchObject({ cities: 1200, failedCities: 3 });
    expect(jobs.airports).toEqual({ count: 8214 });
    expect(jobs.schedules.map((s) => [s.id, s.runner, s.workflow, s.cron])).toEqual([
      ['post-sale-sweep', 'api', null, null],
      ['sync-tbo-hotel-inventory', 'github', 'sync-tbo-hotel-inventory.yml', '17 6-9 * * *'],
    ]);
  });

  it('un barrido que no se puede leer rompe la lectura: no se dice "Corriendo" por error', () => {
    for (const postSaleSweep of [
      undefined,
      runningSweep({ stale: 'no' }),
      runningSweep({ lastOkAt: 'ayer' }),
      runningSweep({ runs24h: -1 }),
      runningSweep({ lastOk: 'sí' }),
      runningSweep({ durationMs: 1.5 }),
      runningSweep({ everyMinutes: 0 }),
    ]) {
      expect(parseSystemJobs(systemJobsPayload({ postSaleSweep }))).toBeUndefined();
    }
    expect(parseSystemJobs(systemJobsPayload({ airports: { count: '8' } }))).toBeUndefined();
    expect(parseSystemJobs(systemJobsPayload({ catalogs: null }))).toBeUndefined();
    expect(parseSystemJobs(systemJobsPayload({ generatedAt: 'ahora' }))).toBeUndefined();
    expect(parseSystemJobs(null)).toBeUndefined();
  });

  it('sin ninguna corrida: fechas y números en null', () => {
    const s = sweep({
      lastRunAt: null,
      lastOk: null,
      lastOkAt: null,
      durationMs: null,
      tenantsFailed: null,
      runs24h: 0,
      stale: true,
    });
    expect(s).toMatchObject({ lastRunAt: null, lastOk: null, lastOkAt: null, stale: true });
  });

  it('una fila rota de una lista se descarta, no la respuesta', () => {
    const jobs = parsed({
      catalogs: [{ providerCode: 'tbo-hotels', cities: 'muchas' }],
      reconciliation: { sinceDays: 7, byProvider: [{ providerCode: '' }] },
      schedules: [{ id: 'x', label: 'X', runner: 'cron', schedule: 'a veces' }],
    });
    expect(jobs.catalogs).toEqual([]);
    expect(jobs.reconciliation.byProvider).toEqual([]);
    expect(jobs.schedules).toEqual([]);
  });
});

describe('el barrido en palabras', () => {
  it('corriendo: cuándo fue la última correcta y cada cuánto corre', () => {
    expect(sweepStatus(sweep(), NOW)).toEqual({
      tone: 'success',
      badge: 'Corriendo',
      headline: 'Última ejecución correcta hace 5 minutos · corre cada 15 minutos',
      details: ['96 ejecuciones en 24 h · la última tardó 8 s'],
    });
  });

  it('detenido: desde cuándo no corre y qué revisar', () => {
    const status = sweepStatus(
      sweep({ lastOkAt: ago(3 * 60 * MIN), lastRunAt: ago(3 * 60 * MIN), stale: true }),
      NOW,
    );
    expect(status).toMatchObject({
      tone: 'danger',
      badge: 'Detenido',
      headline: 'No corre hace 3 horas: revisa el contenedor del api.',
    });
  });

  it('con errores en 24 h y nodos que no se pudieron revisar', () => {
    const status = sweepStatus(
      sweep({
        failures24h: 4,
        tenantsFailed: 2,
        lastOk: false,
        lastRunAt: ago(MIN),
        lastOkAt: ago(16 * MIN),
      }),
      NOW,
    );
    expect(status.tone).toBe('warning');
    expect(status.headline).toBe(
      'Última ejecución correcta hace 16 minutos · corre cada 15 minutos',
    );
    expect(status.details).toEqual([
      '4 ejecuciones con error en 24 h',
      'La última ejecución terminó con error; la anterior terminó bien.',
      'En la última ejecución correcta, 2 nodos no se pudieron revisar.',
      '96 ejecuciones en 24 h · la última tardó 8 s',
    ]);
    expect(sweepStatus(sweep({ failures24h: 1, tenantsFailed: 1 }), NOW).details).toEqual([
      '1 ejecución con error en 24 h',
      'En la última ejecución correcta, 1 nodo no se pudo revisar.',
      '96 ejecuciones en 24 h · la última tardó 8 s',
    ]);
  });

  it('corre sin errores pero sin llegar a todos los nodos: no es verde', () => {
    const status = sweepStatus(sweep({ tenantsFailed: 3 }), NOW);
    expect(status).toMatchObject({ tone: 'warning', badge: 'Corriendo' });
    expect(status.details).toContain(
      'En la última ejecución correcta, 3 nodos no se pudieron revisar.',
    );
  });

  it('con la pantalla abierta, el atraso se vuelve a medir: no sigue "Corriendo" junto a "hace 2 horas"', () => {
    // Leído a las 12:00 con la última correcta a las 11:55; la pantalla sigue abierta dos horas.
    const later = NOW + 2 * 60 * MIN;
    expect(sweepStatus(sweep(), later)).toMatchObject({
      tone: 'danger',
      badge: 'Detenido',
      headline: 'No corre hace 2 horas: revisa el contenedor del api.',
    });
    // Justo en el borde de los 45 minutos todavía corre.
    expect(sweepStatus(sweep(), NOW + 40 * MIN).badge).toBe('Corriendo');
    expect(sweepStatus(sweep(), NOW + 40 * MIN + 1).badge).toBe('Detenido');
  });

  it('sin registro de ninguna ejecución, o con todas cayéndose', () => {
    const never = sweepStatus(
      sweep({
        lastRunAt: null,
        lastOk: null,
        lastOkAt: null,
        durationMs: null,
        tenantsFailed: null,
        runs24h: 0,
        stale: true,
      }),
      NOW,
    );
    expect(never).toEqual({
      tone: 'warning',
      badge: 'Sin registro',
      headline: 'No hay registro de ninguna ejecución: revisa el contenedor del api.',
      details: [],
    });
    const failing = sweepStatus(
      sweep({
        lastRunAt: ago(MIN),
        lastOk: false,
        lastOkAt: null,
        durationMs: null,
        tenantsFailed: null,
        runs24h: 3,
        failures24h: 3,
        stale: true,
      }),
      NOW,
    );
    expect(failing).toMatchObject({
      tone: 'danger',
      badge: 'Detenido',
      headline: 'Ninguna ejecución terminó bien: revisa el contenedor del api.',
      details: ['3 ejecuciones con error en 24 h', '3 ejecuciones en 24 h'],
    });
  });

  it('cuánto pasó y cuánto tardó', () => {
    expect(elapsedText(ago(30_000), NOW)).toBe('menos de un minuto');
    expect(elapsedText(ago(MIN), NOW)).toBe('1 minuto');
    expect(elapsedText(ago(59 * MIN), NOW)).toBe('59 minutos');
    expect(elapsedText(ago(60 * MIN), NOW)).toBe('1 hora');
    expect(elapsedText(ago(25 * 60 * MIN), NOW)).toBe('1 día');
    expect(elapsedText(ago(72 * 60 * MIN), NOW)).toBe('3 días');
    expect(elapsedText('nunca', NOW)).toBe('');
    // Un reloj del navegador atrasado no da tiempos negativos.
    expect(elapsedText(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('menos de un minuto');
    expect(durationLabel(400)).toBe('menos de un segundo');
    expect(durationLabel(8_400)).toBe('8 s');
    expect(durationLabel(120_000)).toBe('2 min');
    expect(durationLabel(125_000)).toBe('2 min 5 s');
  });
});

describe('conciliación, catálogos, aeropuertos y programación', () => {
  it('el estado de la última corrida, en palabras', () => {
    expect(reconciliationStatus('completed')).toEqual({ label: 'Correcta', tone: 'success' });
    expect(reconciliationStatus('failed')).toEqual({ label: 'Falló', tone: 'danger' });
    expect(reconciliationStatus('invalid').label).toBe('Respuesta inválida');
    expect(reconciliationStatus('abandoned').label).toBe('Se interrumpió');
    expect(reconciliationStatus('running').label).toBe('En curso');
    expect(reconciliationStatus(null)).toEqual({ label: 'Sin corridas', tone: 'neutral' });
    expect(reconciliationStatus('nuevo')).toEqual({ label: 'nuevo', tone: 'neutral' });
    expect(lastRunLabel(ago(5 * 60 * MIN), NOW)).toBe('hace 5 horas');
    expect(lastRunLabel(null, NOW)).toBe('Nunca terminó una');
  });

  it('un catálogo: ciudades, sincronizadas en 48 h, con error y la última', () => {
    const [catalog] = parsed().catalogs;
    expect(catalogTitle('tbo-hotels')).toBe('Catálogo de hoteles · TBO Holidays');
    expect(catalogLine(catalog!, NOW)).toBe(
      '1.200 ciudades · sincronizadas en 48 h: 1.180 · con error: 3 · última hace 2 horas',
    );
    expect(catalogBadge(catalog!)).toEqual({ label: 'Al día', tone: 'success' });
    expect(catalogBadge({ stale: true })).toEqual({ label: 'Atrasado', tone: 'warning' });
    expect(
      catalogLine(
        { ...catalog!, cities: 1, syncedLast48h: 0, failedCities: 0, lastSyncedAt: null },
        NOW,
      ),
    ).toBe('1 ciudad · sincronizadas en 48 h: 0 · con error: 0 · nunca se sincronizó');
  });

  it('aeropuertos y dónde corre cada tarea', () => {
    expect(airportsLine({ count: 8214 })).toBe('8.214 aeropuertos');
    expect(airportsLine({ count: 1 })).toBe('1 aeropuerto');
    expect(airportsLine({ count: 0 })).toContain('No hay aeropuertos cargados');
    expect(runnerLabel({ runner: 'api', workflow: null })).toBe('En el api');
    expect(runnerLabel({ runner: 'github', workflow: 'sync-airports.yml' })).toBe(
      'GitHub Actions · sync-airports.yml',
    );
  });

  it('la ruta, cuándo se actualizó y los errores', () => {
    expect(PLATFORM_SISTEMA).toBe('/admin/plataforma/sistema');
    expect(systemUpdatedLabel(ago(3 * MIN), NOW)).toBe('Actualizado hace 3 minutos');
    expect(systemErrorMessage(401)).toBe('Tu sesión venció. Vuelve a iniciar sesión.');
    expect(systemErrorMessage(403, 'Esta acción es sólo para el superadmin.')).toBe(
      'Esta acción es sólo para el superadmin.',
    );
    expect(systemErrorMessage(403)).toContain('superadmin');
    expect(systemErrorMessage(500, 'stack')).toBe(
      'No pudimos leer el estado de los procesos. Reintenta en unos segundos.',
    );
  });

  it('todo va en tú', () => {
    const copy = [
      ...sweepStatus(sweep({ stale: true, failures24h: 2, tenantsFailed: 3 }), NOW).details,
      sweepStatus(sweep({ stale: true }), NOW).headline,
      sweepStatus(sweep({ lastOkAt: null, lastRunAt: null, stale: true }), NOW).headline,
      airportsLine({ count: 0 }),
      systemErrorMessage(401),
      systemErrorMessage(403),
      systemErrorMessage(500),
    ].join(' ');
    expect(voseoIn(copy)).toEqual([]);
    expect(VOSEO_WORDS.length).toBeGreaterThan(0);
  });
});
