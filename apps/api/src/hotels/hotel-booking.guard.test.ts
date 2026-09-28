import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD (docs/tbo/09 PR-4.6): ninguna ruta puede reservar en TBO sin una orden detrás.
 *
 * El Book de TBO existe en tres capas: el ACL (`TboHotelsAdapter.book` / `bookReport`), el
 * envoltorio neutral (`TboHotelProviderAdapter.book` / `bookWithContext`) y la saga con órdenes
 * (`HotelBookingService`), que abre el intent con la referencia ANTES de llamar (D-TBO-07 A). Los
 * tests de la saga prueban por comportamiento que el Book sale después del intent; este guard
 * cubre lo que el comportamiento no ve: el camino que todavía no existe. Un `adapter.book(...)`
 * agregado mañana en un servicio cualquiera reservaría en TBO sin fila, sin referencia persistida y
 * sin forma de cumplir la recuperación obligatoria de p. 42.
 *
 * Por eso cada invocación de un Book en `apps/api/src` tiene que estar en esta lista, con su motivo.
 */

function raizDeFuentes(): string {
  for (const candidato of [
    resolvePath(process.cwd(), 'src'),
    resolvePath(process.cwd(), 'apps', 'api', 'src'),
  ]) {
    if (existsSync(join(candidato, 'hotels'))) return candidato;
  }
  throw new Error(`no se encontró apps/api/src desde ${process.cwd()}`);
}

const SRC = raizDeFuentes();

function fuentes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__fixtures__') out.push(...fuentes(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const ARCHIVOS = fuentes(SRC).map((full) => ({
  ruta: relative(SRC, full).split(sep).join('/'),
  fuente: readFileSync(full, 'utf8'),
}));

function quienesLlaman(patron: RegExp): string[] {
  return ARCHIVOS.filter((a) => patron.test(a.fuente))
    .map((a) => a.ruta)
    .sort();
}

/**
 * Toda invocación `.book(` de la API: cuántas hay en cada archivo y el motivo por el que no pueden
 * llegar a TBO sin orden. Se cuentan porque un permiso por archivo dejaría pasar un segundo
 * `.book(` en el mismo controller o en el mismo envoltorio.
 */
const BOOK_PERMITIDO: Readonly<
  Record<string, { readonly veces: number; readonly motivo: string }>
> = {
  'cars/cars.controller.ts': {
    veces: 1,
    motivo: 'autos: `CarsService.book`, otra vertical y otro puerto',
  },
  'hotels/hotels.controller.ts': {
    veces: 2,
    motivo: '`reservations.book` (Despegar, código fijo) y `bookings.book` (la saga con órdenes)',
  },
  'hotels/despegar-hotel-reservations.service.ts': {
    veces: 1,
    motivo:
      'el ACL de Despegar resuelto con `DESPEGAR_HOTELS_PROVIDER_CODE`, nunca con otro código',
  },
  'providers-despegar/despegar-hotel-provider.adapter.ts': {
    veces: 1,
    motivo: 'el envoltorio de Despegar sobre su ACL',
  },
  'providers-tbo/tbo-hotel-provider.adapter.ts': {
    veces: 1,
    motivo: 'el envoltorio de TBO delegando el puerto neutral en su ACL',
  },
};

describe('ninguna ruta reserva en TBO sin orden detrás', () => {
  it('el guard lee la fuente (anti-vacuidad)', () => {
    expect(ARCHIVOS.length).toBeGreaterThan(100);
    expect(ARCHIVOS.map((a) => a.ruta)).toContain('hotels/hotel-booking.service.ts');
  });

  it('`bookWithContext` sólo lo invoca la saga, que abre el intent antes', () => {
    expect(quienesLlaman(/\.bookWithContext\(/)).toEqual(['hotels/hotel-booking.service.ts']);
  });

  it('el Book del ACL de TBO sólo lo invoca su envoltorio, y el ACL sólo lo construye el factory', () => {
    expect(quienesLlaman(/\.bookReport\(/)).toEqual([
      'providers-tbo/tbo-hotel-provider.adapter.ts',
    ]);
    expect(quienesLlaman(/new TboHotelsAdapter\(/)).toEqual([
      'providers-tbo/tbo-hotels.factory.ts',
    ]);
  });

  it('cada `.book(` de la API está en la lista permitida, con su motivo', () => {
    const llaman = quienesLlaman(/\.book\(/);
    const fuera = llaman.filter((ruta) => BOOK_PERMITIDO[ruta] === undefined);

    expect(
      fuera,
      'un Book nuevo en la API: si es de hoteles, tiene que ir por `HotelBookingService`',
    ).toEqual([]);
    // Y la lista no guarda permisos de archivos que ya no reservan.
    expect(Object.keys(BOOK_PERMITIDO).sort()).toEqual(llaman);
  });

  it('ningún archivo permitido suma un `.book(` que no está contado', () => {
    const contadas = Object.fromEntries(
      ARCHIVOS.filter((a) => BOOK_PERMITIDO[a.ruta] !== undefined).map((a) => [
        a.ruta,
        a.fuente.match(/\.book\(/g)?.length ?? 0,
      ]),
    );
    const esperadas = Object.fromEntries(
      Object.entries(BOOK_PERMITIDO).map(([ruta, { veces }]) => [ruta, veces]),
    );

    expect(contadas).toEqual(esperadas);
  });

  it('el flujo de Despegar resuelve sólo el código de Despegar: con él no se llega a TBO', () => {
    const despegar = ARCHIVOS.find(
      (a) => a.ruta === 'hotels/despegar-hotel-reservations.service.ts',
    )?.fuente;

    expect(despegar).toMatch(/const CODE = DESPEGAR_HOTELS_PROVIDER_CODE;/);
    expect(despegar?.match(/registry\.byCode\([^)]*\)/g)).toEqual([
      'registry.byCode(tenantId, CODE)',
    ]);
  });

  it('TBO no es un proveedor de vuelos: la saga de `POST /orders` no lo puede resolver', () => {
    const vuelos = ARCHIVOS.find((a) => a.ruta === 'providers/providers.module.ts')?.fuente;

    expect(vuelos).toBeDefined();
    expect(vuelos).not.toMatch(/Tbo/);
  });

  it('la verificación de un Book incierto y el barrido sólo leen: nunca reservan (RF-21 CA-4)', () => {
    for (const ruta of [
      'hotels/hotel-booking-verification.ts',
      'hotels/hotel-booking-verification.service.ts',
      'orders/post-sale-sweeper.ts',
      'orders/post-sale.worker.ts',
    ]) {
      const fuente = ARCHIVOS.find((a) => a.ruta === ruta)?.fuente;
      expect(fuente, ruta).toBeDefined();
      expect(fuente, ruta).not.toMatch(/\.book(?:WithContext|Report)?\(/);
    }
  });

  it('el Book de la saga no pasa por la cola de post-venta, que reintenta (03 §4.4)', () => {
    const saga = ARCHIVOS.find((a) => a.ruta === 'hotels/hotel-booking.service.ts')?.fuente ?? '';

    expect(saga).not.toMatch(/post-sale-queue|PostSaleQueueService|bullmq/);
    expect(saga.match(/\.bookWithContext\(/g)).toHaveLength(1);
  });
});
