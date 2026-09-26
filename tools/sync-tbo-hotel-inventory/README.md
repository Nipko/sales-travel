# sync-tbo-hotel-inventory

Sync del catálogo de hoteles de TBO a Postgres: países, ciudades, hoteles, contenido y el mapa de
destinos (etapas E0-E6 de [docs/tbo/05](../../docs/tbo/05-contenido-estatico-e-inventario.md) §6;
[08](../../docs/tbo/08-requisitos-maestro.md) RF-30 a RF-34). Sin catálogo local no hay búsqueda TBO:
Search sólo acepta `HotelCodes`.

Es otra herramienta, otra imagen y otro workflow que el sync de Despegar (D-TBO-12 A). Escribe sólo
tablas globales de catálogo, nunca hace `DELETE` y no emite eventos de dominio: es dato de
referencia, no un cambio de negocio (05 §6.6).

## Cómo corre

- **Imagen:** `ghcr.io/nipko/sales-travel-sync-tbo-hotel-inventory:{sha,latest}`, construida en cada
  push a `main` por la matriz de `.github/workflows/deploy.yml`.
- **Disparo:** `.github/workflows/sync-tbo-hotel-inventory.yml`, cada hora de 06:17 a 09:17 UTC
  (01:17-04:17 en Bogotá y Lima) y a mano con `workflow_dispatch`. Hace SSH al VPS, lee el `.env`
  que escribe el deploy y crea el contenedor en las redes `sales-travel_internal` (Postgres) y
  `sales-travel_edge` (TBO), con cada variable pasada por `-e`.
- **Presupuesto:** una corrida completa no cabe en una ejecución (05 §6.7). Cada una se detiene en
  `TBO_SYNC_MAX_CALLS` o `TBO_SYNC_MAX_MINUTES` y la siguiente reanuda por
  `hotel_provider_city.synced_at`. En el VPS hay además un tope duro de 50 minutos que corta con
  SIGTERM: la ciudad en curso termina o hace `ROLLBACK` y la corrida cierra "ok parcial".
- **Exclusión mutua:** `concurrency` del workflow, un contenedor con nombre fijo y el lock consultivo
  de Postgres. Un contenedor que siguió vivo tras perder su sesión SSH se detiene en orden al empezar
  la ejecución siguiente.

Códigos de salida: `0` sin credenciales, con `TBO_SYNC_ENABLED=false`, con el lock tomado por otra
corrida, y al terminar completa u "ok parcial" (presupuesto, racha de `429`, SIGTERM). `1` si la
configuración o la cuenta no sirven, si falla la base o si la corrida se cortó por una racha de errores.

## Secrets de GitHub Actions

La cuenta es **de catálogo, de plataforma y dedicada al sync** (D-TBO-04 A), nunca la de ventas del
consolidador: si el sync le comiera el QPS, las búsquedas reales recibirían `429`. Se pide a TBO
([Q-93](../../docs/tbo/10-preguntas-para-tbo.md#q-93)); la de test, junto con las credenciales de
certificación ([Q-92](../../docs/tbo/10-preguntas-para-tbo.md#q-92)). **Todavía no están creados:**
mientras falten, el workflow sale con `0` sin descargar la imagen.

| Secret              | Qué poner                                                                         |
| ------------------- | --------------------------------------------------------------------------------- |
| `TBO_SYNC_USERNAME` | Usuario de la cuenta de catálogo (también se acepta como variable, como Despegar) |
| `TBO_SYNC_PASSWORD` | Su contraseña. Sólo como secret                                                   |

El deploy escribe el `.env` con un heredoc sin comillas, cada `TBO_SYNC_*` entre comillas simples, y
los tres workflows de sync lo leen con `source`. La contraseña, como cualquier `TBO_SYNC_*`, no puede
llevar `'`, `$`, `` ` `` ni `\`: el heredoc expande los tres últimos y la comilla cierra el valor.
Espacios, `"`, `#` y `;&|<>()` sí pueden ir. Si TBO entrega una contraseña con alguno de esos cuatro,
hay que pedir otra: un `.env` que no se puede leer deja en rojo también el sync de Despegar y el de
aeropuertos.

Después de crear o cambiar un secret hay que correr el workflow `Deploy`: es el que reescribe el
`.env` del VPS.

## Variables de GitHub Actions (opcionales)

Vacía = el valor por defecto de `src/env.ts`, que las valida con Zod al arrancar.

| Variable                          | Por defecto                  | Uso                                                                      |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `TBO_SYNC_ENABLED`                | `true`                       | Kill-switch: `false` sale con `0` aunque lo demás esté mal               |
| `TBO_SYNC_ENVIRONMENT`            | `test`                       | `test` o `live`                                                          |
| `TBO_SYNC_BASE_URL`               | la de test del ACL           | Obligatoria en `live`                                                    |
| `TBO_SYNC_COUNTRIES`              | `CO,PE,BR,US,MX,DO,AR,CL,ES` | Lista cerrada de D-TBO-12 A, ISO2                                        |
| `TBO_SYNC_STAGES`                 | `E1,E2,E3,E4,E5,E6`          | Etapas que corren                                                        |
| `TBO_SYNC_MAX_CALLS`              | `2500`                       | Llamadas a TBO por corrida                                               |
| `TBO_SYNC_MAX_MINUTES`            | `45`                         | Duración por corrida; por encima de 50 la corta el tope del VPS          |
| `TBO_SYNC_RPS`                    | `1`                          | Peticiones por segundo, una conexión (Q-10)                              |
| `TBO_SYNC_SWEEP_MAX_DROP`         | `0.5`                        | Caída máxima de hoteles de una ciudad antes de sospechar de la respuesta |
| `TBO_SYNC_MAX_CONSECUTIVE_429`    | `3`                          | `429` seguidos que cortan la corrida como "ok parcial"                   |
| `TBO_SYNC_MAX_CONSECUTIVE_ERRORS` | `10`                         | Errores seguidos que la cortan con `1`                                   |
| `TBO_SYNC_DETAILED_RESPONSE`      | `true`                       | `IsDetailedResponse` de TBOHotelCodeList (Q-63)                          |
| `TBO_SYNC_CODELIST_TIMEOUT_MS`    | `180000`                     | Timeout de `hotelcodelist` (E5)                                          |
| `TBO_SYNC_DEMAND_REFRESH_HOURS`   | `20`                         | Cada cuánto se refresca una ciudad con demanda                           |
| `TBO_SYNC_REFRESH_DAYS`           | `7`                          | Cada cuánto se refresca el resto                                         |
| `TBO_SYNC_EMPTY_REFRESH_DAYS`     | `30`                         | Cada cuánto se refresca una ciudad que dio 0 hoteles                     |
| `TBO_SYNC_DEMAND_WINDOW_DAYS`     | `14`                         | Ventana de `search_logs` que define la demanda                           |
| `TBO_SYNC_CONTENT_SCOPE`          | `demand`                     | `demand` o `all`: a qué hoteles les toca HotelDetails (E4)               |
| `TBO_SYNC_LANGS`                  | `ES,PT,EN`                   | Idiomas de los hoteles con demanda                                       |
| `TBO_SYNC_LANGS_REGULAR`          | `ES,PT`                      | Idiomas del resto, sólo con `all`                                        |
| `TBO_SYNC_DETAILS_BATCH`          | `10`                         | Códigos por llamada a HotelDetails, máximo 13 (Q-62)                     |
| `TBO_SYNC_CONTENT_REFRESH_DAYS`   | `30`                         | Edad a partir de la cual se vuelve a pedir el contenido                  |
| `TBO_SYNC_LOG_LEVEL`              | `info`                       | `debug`, `info`, `warn` o `error`                                        |

`workflow_dispatch` acepta además `countries`, `stages` y `max_calls` para una sola ejecución, sin
tocar las variables. Sólo letras, dígitos y comas.

## Primera corrida con la cuenta de test (salida de PR-3.5)

1. Cargar los dos secrets y correr `Deploy`.
2. `Run workflow` con `countries=CO` y `max_calls=200`. El log termina con una línea
   `tbo.sync.result` con `ok: true` y `outcome: "partial"` si el presupuesto no alcanzó.
3. Comprobar en el VPS
   (`docker compose exec -T postgres psql -U postgres -d sales_travel`):

   ```sql
   -- Hoteles TBO activos por país.
   SELECT country_code, count(*) FILTER (WHERE active) AS activos, count(*) AS total
     FROM hotel_inventory WHERE provider_code = 'tbo-hotels' GROUP BY 1 ORDER BY 1;

   -- Ciudades recorridas, con centroide, y las que faltan.
   SELECT count(*) FILTER (WHERE synced_at IS NOT NULL)      AS recorridas,
          count(*) FILTER (WHERE centroid_lat IS NOT NULL)   AS con_centroide,
          count(*) FILTER (WHERE synced_at IS NULL)          AS pendientes
     FROM hotel_provider_city WHERE provider_code = 'tbo-hotels';
   ```

4. Repetir el paso 2: `pendientes` baja y las ciudades ya recorridas conservan su `synced_at`, es
   decir, la corrida siguió donde quedó la anterior.
