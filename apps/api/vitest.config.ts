import { defineConfig } from 'vitest/config';

/**
 * Configuración de tests de `apps/api`.
 *
 * Hasta ahora no existía ninguna: `vitest run` corría con los valores por defecto y los
 * umbrales de cobertura que exige `CLAUDE.md` ("> 70 % en dominio, > 50 % global") no se
 * aplicaban en ningún sitio. Un PR podía borrar la mitad de los tests y CI seguía verde.
 *
 * `coverage.enabled` va en `true` a propósito: CI ejecuta `pnpm test` -> `turbo run test`
 * -> `vitest run` (`.github/workflows/ci.yml:115`). Si la cobertura sólo se calculara con
 * `--coverage`, los umbrales de abajo serían decorativos. Con esto, bajar la cobertura
 * ROMPE el build, que es el único mecanismo que impide que la red de seguridad se pudra.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',

      // Sólo código fuente de la API. Los scripts sueltos de la raíz del paquete
      // (`search-logs.js`, `test-db-connection.js`) son herramientas de diagnóstico manual.
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        // Los `*.module.ts` de Nest son declaración de DI pura: no tienen ninguna rama que
        // un test pueda ejercitar, y contarlos sólo diluye la medida.
        '**/*.module.ts',
        'src/main.ts',
      ],

      /**
       * Los umbrales son un TRINQUETE, no la meta.
       *
       * `CLAUDE.md` pide > 50 % global y > 70 % en dominio. La API está hoy en ~15 % global
       * (medido, no estimado). Poner 50 % aquí dejaría `main` en rojo desde el primer
       * commit y el equipo aprendería a ignorar el rojo, que es peor que no tener umbral.
       * Así que el número global es el suelo REAL de hoy: sirve para que la cobertura no
       * pueda bajar, y se sube en cada PR que añada tests hasta llegar al 50 %.
       *
       * `src/search/**` sí lleva un umbral de dominio: es el código que genera todos los
       * ingresos y el que este PR acaba de cubrir. Ver `docs/sabre/11-plan-implementacion.md`
       * §3.1.
       *
       * OJO: los ficheros que casan con un glob NO cuentan para el umbral global (así lo
       * define Vitest), por eso el global de abajo mide la API *sin* `src/search`.
       */
      thresholds: {
        lines: 13,
        statements: 13,
        functions: 38,
        branches: 62,

        // Medido hoy: 85,9 % líneas, y el mismo número SIN Postgres —la unidad de
        // `search-telemetry.service.ts` no necesita base de datos, sólo su test de
        // integración—, así que el trinquete no depende de que el runner tenga PG.
        // Lo que falta para el 100 % es `search.controller.ts`, que necesita levantar Nest.
        'src/search/**': {
          lines: 84,
          statements: 84,
          functions: 78,
          branches: 88,
        },
      },
    },
  },
});
