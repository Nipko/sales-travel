import { expect, test } from '@playwright/test';
import { como, type Api } from './support/cliente';

/**
 * Tanda 20 (docs/qa/01 §5 AUT): AUT-08, lo que la API rechaza en Oficinas y en el reporte diario
 * antes de llamar a AgentCars (distancia, ubicación, país, coordenadas y fecha).
 */

interface ErrorApi {
  message: string;
  fields?: { field: string; message: string }[];
}

let api: Api;

test.beforeAll(async () => {
  api = await como('vendedorA');
});

const oficinas = (qs: string) => api.get<ErrorApi>(`/cars/offices?${qs}`);
const motivos = (r: { body: ErrorApi }) => (r.body.fields ?? []).map((f) => f.message).join(' | ');

test('AUT-08 oficinas: distancia, ubicación, país y coordenadas → 400 con su motivo', async () => {
  for (const d of ['0', '-5', 'muchas']) {
    const r = await oficinas(`distance=${d}&cityCode=BOG`);
    expect(r.status, `distance=${d}`).toBe(400);
  }

  const sinLugar = await oficinas('distance=25');
  expect(sinLugar.status).toBe(400);
  expect(motivos(sinLugar)).toContain('Indica coordenadas (lat y lng) o un cityCode.');

  const vacias = await oficinas('distance=25&lat=&lng=');
  expect(vacias.status, 'lat/lng vacías no son 0,0').toBe(400);
  expect(motivos(vacias)).toContain('Indica coordenadas');

  const lat = await oficinas('distance=25&lat=91&lng=0');
  expect(lat.status).toBe(400);
  expect(motivos(lat)).toContain('la latitud va entre -90 y 90');

  const lng = await oficinas('distance=25&lat=4.7&lng=-181');
  expect(lng.status).toBe(400);
  expect(motivos(lng)).toContain('la longitud va entre -180 y 180');

  const pais = await oficinas('distance=25&cityCode=BOG&source=COL');
  expect(pais.status).toBe(400);
  expect(pais.body.fields?.[0]?.field).toBe('source');
});

test('AUT-08 reporte diario: la fecha va AAAA-MM-DD', async () => {
  for (const f of ['27-11-2026', '2026/11/27', 'hoy']) {
    const r = await api.get<ErrorApi>(`/cars/daily-report?date=${encodeURIComponent(f)}`);
    expect(r.status, `date=${f}`).toBe(400);
    expect(motivos(r)).toContain('fecha esperada YYYY-MM-DD');
  }
});
