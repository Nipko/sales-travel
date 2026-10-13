import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSystemJobs, type SystemJobs } from '../../../../../../lib/platform-system';
import { runningSweep, systemJobsPayload } from '../../../../../../lib/platform-system.fixture';
import { voseoIn } from '../../../../../../lib/voseo';
import { SystemConsole } from './system-console';
import { SystemJobs as SystemJobsPanel, SystemJobsContent } from './system-jobs';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');

function jobs(overrides: Record<string, unknown> = {}): SystemJobs {
  const parsed = parseSystemJobs(systemJobsPayload(overrides));
  if (parsed === undefined) throw new Error('el fixture no se pudo leer');
  return parsed;
}

function render(j: SystemJobs): string {
  return renderToStaticMarkup(createElement(SystemJobsContent, { jobs: j, now: NOW }));
}

/** El texto visible (y el de lectores de pantalla), sin etiquetas. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

describe('Sistema en su primer pintado', () => {
  const html = renderToStaticMarkup(createElement(SystemConsole));

  it('título, subtítulo y la pestaña Procesos, con los procesos anunciando que cargan', () => {
    expect(html).toContain('<h1');
    expect(textOf(html)).toContain('Sistema');
    expect(textOf(html)).toContain(
      'Lo que corre solo: barridos, conciliaciones y sincronizaciones.',
    );
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Procesos</);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-busy="true"');
    expect(textOf(html)).toContain('Cargando los procesos…');
    expect(textOf(html)).toContain('Actualizar');
  });

  it('el panel solo también arranca cargando, con Actualizar deshabilitado', () => {
    const panel = renderToStaticMarkup(createElement(SystemJobsPanel));
    expect(panel).toMatch(/<button[^>]*disabled=""[^>]*>.*Actualizar/s);
  });

  it('va en tú', () => {
    expect(voseoIn(textOf(html))).toEqual([]);
  });
});

describe('SystemJobsContent', () => {
  it('el barrido corriendo: la última correcta y cada cuánto corre', () => {
    const text = textOf(render(jobs()));
    expect(text).toContain('Barrido de post-venta');
    expect(text).toContain('Corriendo');
    expect(text).toContain('Última ejecución correcta hace 5 minutos · corre cada 15 minutos');
    expect(text).toContain('96 ejecuciones en 24 h · la última tardó 8 s');
    expect(text).not.toContain('revisa el contenedor');
  });

  it('el barrido detenido: desde cuándo y qué revisar, y las ejecuciones con error', () => {
    const text = textOf(
      render(
        jobs({
          postSaleSweep: runningSweep({
            lastRunAt: '2026-10-13T11:58:00.000Z',
            lastOk: false,
            lastOkAt: '2026-10-13T10:00:00.000Z',
            stale: true,
            failures24h: 8,
          }),
        }),
      ),
    );
    expect(text).toContain('Detenido');
    expect(text).toContain('No corre hace 2 horas: revisa el contenedor del api.');
    expect(text).toContain('8 ejecuciones con error en 24 h');
  });

  it('la conciliación diaria: una tabla con proveedor, última corrida, estado y diferencias críticas', () => {
    const html = render(
      jobs({
        reconciliation: {
          sinceDays: 7,
          byProvider: [
            {
              providerCode: 'tbo-hotels',
              runs: 7,
              failedRuns: 1,
              lastFinishedAt: '2026-10-13T04:31:00.000Z',
              lastStatus: 'completed',
              criticalItems: 2,
              warningItems: 0,
              stale: false,
            },
            {
              providerCode: 'agent-cars',
              runs: 0,
              failedRuns: 0,
              lastFinishedAt: '2026-10-10T04:31:00.000Z',
              lastStatus: 'failed',
              criticalItems: 0,
              warningItems: 0,
              stale: true,
            },
          ],
        },
      }),
    );
    const text = textOf(html);
    expect(html).toContain('<table');
    for (const header of ['Proveedor', 'Última corrida', 'Estado', 'Diferencias críticas']) {
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${header}</th>`));
    }
    expect(text).toContain('Conciliación diaria');
    expect(text).toContain('TBO Holidays');
    expect(text).toContain('7 corridas en 7 días · 1 fallida');
    expect(text).toContain('hace 7 horas');
    expect(text).toContain('Correcta');
    expect(text).toContain('AgentCars');
    expect(text).toContain('hace 3 días');
    expect(text).toContain('Falló');
    expect(text).toContain('Atrasada');
    expect(html).toContain('dateTime="2026-10-13T04:31:00.000Z"');
  });

  it('sin conciliaciones, lo dice', () => {
    const text = textOf(render(jobs({ reconciliation: { sinceDays: 7, byProvider: [] } })));
    expect(text).toContain('Ningún proveedor concilió todavía.');
  });

  it('cada catálogo de hoteles en su tarjeta, y los aeropuertos', () => {
    const text = textOf(render(jobs()));
    expect(text).toContain('Catálogo de hoteles · TBO Holidays');
    expect(text).toContain(
      '1.200 ciudades · sincronizadas en 48 h: 1.180 · con error: 3 · última hace 2 horas',
    );
    expect(text).toContain('Al día');
    expect(text).toContain('Aeropuertos');
    expect(text).toContain('8.214 aeropuertos');

    const stale = textOf(
      render(
        jobs({
          catalogs: [
            {
              providerCode: 'tbo-hotels',
              cities: 10,
              syncedLast48h: 0,
              failedCities: 0,
              lastSyncedAt: '2026-10-10T09:17:00.000Z',
              stale: true,
            },
          ],
          airports: { count: 0 },
        }),
      ),
    );
    expect(stale).toContain('Atrasado');
    expect(stale).toContain('No hay aeropuertos cargados');
    expect(textOf(render(jobs({ catalogs: [] })))).toContain(
      'Ningún proveedor sincroniza su catálogo por ciudad todavía.',
    );
  });

  it('la programación: cada tarea, cuándo y dónde corre', () => {
    const html = render(jobs());
    const text = textOf(html);
    expect(text).toContain('Programación');
    expect(text).toContain('Catálogo de hoteles de TBO');
    expect(text).toContain('Cada hora de 06:17 a 09:17 UTC (01:17 a 04:17 en Bogotá).');
    expect(text).toContain('GitHub Actions · sync-tbo-hotel-inventory.yml');
    expect(html).toContain('<code class="font-mono">17 6-9 * * *</code>');
    expect(text).toContain('En el api');
  });

  it('cada tarjeta con su encabezado, y todo en tú', () => {
    const html = render(
      jobs({ postSaleSweep: runningSweep({ stale: true, failures24h: 1, tenantsFailed: 2 }) }),
    );
    expect(html.match(/<section aria-labelledby="sistema-[^"]+"/g)?.length).toBe(5);
    expect(voseoIn(textOf(html))).toEqual([]);
  });
});
