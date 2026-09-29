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
  (01:17-04:17 en Bogotá y Lima) y a mano con `workflow_dispatch`. Hace SSH al VPS, lee del `.env`
  que escribe el deploy las `TBO_SYNC_*` y `PROVIDER_CREDENTIALS_KEY`, y crea el contenedor en las
  redes `sales-travel_internal` (Postgres) y `sales-travel_edge` (TBO), con cada variable pasada por
  `-e` sin valor. Si hay cuenta de TBO lo decide el contenedor, no el script.
- **Presupuesto:** una corrida completa no cabe en una ejecución (05 §6.7). Cada una se detiene en
  `TBO_SYNC_MAX_CALLS` o `TBO_SYNC_MAX_MINUTES` y la siguiente reanuda por
  `hotel_provider_city.synced_at`. En el VPS hay además un tope duro de 50 minutos que corta con
  SIGTERM: la ciudad en curso termina o hace `ROLLBACK` y la corrida cierra "ok parcial".
- **Exclusión mutua:** `concurrency` del workflow, un contenedor con nombre fijo y el lock consultivo
  de Postgres. Un contenedor que siguió vivo tras perder su sesión SSH se detiene en orden al empezar
  la ejecución siguiente.

Códigos de salida: `0` sin credenciales (ni override ni cuenta en la bóveda), con
`TBO_SYNC_ENABLED=false`, con el lock tomado por otra corrida, y al terminar completa u "ok parcial"
(presupuesto, racha de `429`, SIGTERM). `1` si la configuración o la cuenta no sirven (también la de
la bóveda, o falta la clave para abrirla), si falla la base o si la corrida se cortó por una racha de
errores.

## De dónde sale la cuenta de TBO

**De la bóveda, no de GitHub Actions** (D-TBO-04, decisión del founder del 2026-09-29). La cuenta se
carga una sola vez desde el panel del superadmin, en Planetour (la raíz `platform` de la red):
_Proveedores (GDS)_ → **TBO Holidays**, con usuario, contraseña, entorno y URL base, en estado
**Activo** ([docs/platform/13](../../docs/platform/13-validacion-modelo-red.md) §5 paso 6). El api la
guarda cifrada en `provider_accounts` y el sync la lee de ahí:

1. **Override por entorno.** Si `TBO_SYNC_USERNAME` y `TBO_SYNC_PASSWORD` están los dos, mandan, con
   `TBO_SYNC_ENVIRONMENT` y `TBO_SYNC_BASE_URL`; la bóveda ni se lee. Es para el stack de certificación
   y para una prueba puntual. Con uno solo no hay override: se sigue con la bóveda y el log avisa con
   `tbo.sync.override_ignored` qué variable quedó sin usar.
2. **La cuenta `tbo-hotels` activa de la raíz `platform`.** Si hay una sola, ésa. Si hay varias, la de
   etiqueta `catalogo` (sin distinguir mayúsculas ni tildes) y si no, `default`, que es la que crea el
   panel. Otra combinación falla con `SyncVaultError` `ambiguous_accounts` y las etiquetas. Una cuenta
   en **Sandbox** o **Deshabilitada** no cuenta, igual que para el api.
3. **Ninguna:** sale con `0` y
   `reason: "TBO_SYNC_USERNAME, TBO_SYNC_PASSWORD not set and no active tbo-hotels account in the vault of '<slug>'"`.

La cuenta se abre como la abre el api: el blob con `PROVIDER_CREDENTIALS_KEY` (el mismo formato,
probado contra el módulo del api en `vault-crypto.contract.test.ts`), usuario y contraseña sólo del
blob, `environment` y `baseUrl` de `config`, y todo por `parseTboConfig` del ACL. Una cuenta que el api
rechazaría (entorno ausente, `http` en live, live sin URL) el sync también la rechaza, con salida `1` y
`campo:código`. Si cambia la cuenta en el panel, la corrida siguiente ya sale con la nueva: no hay que
desplegar.

El log dice de dónde salió la credencial y nunca la credencial: una línea `tbo.sync.credentials` con
`credentialSource` (`env` o `vault:<slug>/<etiqueta>`), `environment` y `accountRef` (la huella de la
cuenta, la misma que usa el api), y `credentialSource` otra vez en `tbo.sync.result`.

**El cupo.** La cuenta `default` de Planetour es la misma con la que vende su red, así que el sync
comparte con esas búsquedas el QPS de TBO (el limitador es por proceso: el del sync no ve al del api).
Por eso corre de madrugada y a 1 req/s (D-TBO-12). Si hace falta separarlo, se carga en Planetour una
segunda cuenta de TBO con etiqueta `catalogo`, **no heredable** (así la red no la hereda para vender:
a las sucursales `resolve_provider_account` les sigue devolviendo la `default`), y el sync la prefiere
sin más. Para el propio nodo Planetour las dos serían cuentas propias y esa función no elige entre
ellas por etiqueta: sirve mientras Planetour no venda desde la raíz. Hoy el panel
crea siempre la etiqueta `default`: una cuenta `catalogo` se crea por la API (`label` en el cuerpo de
`POST /api/provider-accounts`, con sesión de superadmin).

| Variable                   | Dónde                                                | Uso                                                                 |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `PROVIDER_CREDENTIALS_KEY` | Secret que ya existe (la clave de la bóveda del api) | El workflow la lee del `.env` del VPS y la pasa con `-e`, sin valor |
| `TBO_SYNC_USERNAME`        | Opcional: secret o variable                          | Override: usuario de TBO. **No hace falta cargarlo**                |
| `TBO_SYNC_PASSWORD`        | Opcional: sólo secret                                | Override: su contraseña                                             |

`PROVIDER_CREDENTIALS_KEY` no rota sola: el api no admite una clave anterior, así que cambiarla deja
ilegibles las cuentas guardadas para los dos, y el sync falla con `undecryptable` hasta que se vuelvan
a cargar desde el panel.

Si se usa el override en producción: el deploy escribe el `.env` con un heredoc sin comillas y cada
`TBO_SYNC_*` entre comillas simples, así que la contraseña no puede llevar `'`, `$`, `` ` `` ni `\` (el
heredoc expande los tres últimos y la comilla cierra el valor). Después de crear o cambiar un secret
hay que correr el workflow `Deploy`, que es el que reescribe el `.env` del VPS. La cuenta de la bóveda
no tiene ninguna de esas restricciones.

## Variables de GitHub Actions (opcionales)

Vacía = el valor por defecto de `src/env.ts`, que las valida con Zod al arrancar.

| Variable                          | Por defecto                  | Uso                                                                      |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `TBO_SYNC_ENABLED`                | `true`                       | Kill-switch: `false` sale con `0` aunque lo demás esté mal               |
| `TBO_SYNC_ENVIRONMENT`            | `test`                       | `test` o `live`. Sólo con el override: la bóveda trae el de su cuenta    |
| `TBO_SYNC_BASE_URL`               | la de test del ACL           | Obligatoria en `live`. Sólo con el override                              |
| `TBO_SYNC_COUNTRIES`              | `CO,PE,BR,US,MX,DO,AR,CL,ES` | Lista cerrada de D-TBO-12 A, ISO2                                        |
| `TBO_SYNC_CITIES`                 | vacía = todas                | `CityCode` de esos países a los que se limitan E3 y E4 (máximo 50)       |
| `TBO_SYNC_STAGES`                 | `E1,E2,E3,E4,E5,E6`          | Etapas que corren; `E2A` (ciudades del mundo) sólo si se la nombra       |
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
| `TBO_SYNC_EMPTY_REFRESH_DAYS`     | `30`                         | Cada cuánto se refresca una ciudad que dio 0 hoteles ("No Hotels Found") |
| `TBO_SYNC_DEMAND_WINDOW_DAYS`     | `14`                         | Ventana de `search_logs` que define la demanda                           |
| `TBO_SYNC_CONTENT_SCOPE`          | `demand`                     | `demand` o `all`: a qué hoteles les toca HotelDetails (E4)               |
| `TBO_SYNC_LANGS`                  | `ES,PT,EN`                   | Idiomas de los hoteles con demanda                                       |
| `TBO_SYNC_LANGS_REGULAR`          | `ES,PT`                      | Idiomas del resto, sólo con `all`                                        |
| `TBO_SYNC_DETAILS_BATCH`          | `10`                         | Códigos por llamada a HotelDetails, máximo 13 (Q-62)                     |
| `TBO_SYNC_CONTENT_REFRESH_DAYS`   | `30`                         | Edad a partir de la cual se vuelve a pedir el contenido                  |
| `TBO_SYNC_LOG_LEVEL`              | `info`                       | `debug`, `info`, `warn` o `error`                                        |

`workflow_dispatch` acepta además `countries`, `stages` y `max_calls` para una sola ejecución, sin
tocar las variables. Sólo letras, dígitos y comas.

### Cobertura global: E2A, las ciudades de todos los países

E2A baja `CountryList` y un `CityList` por cada país de TBO que todavía no tiene ciudades guardadas y
que no refresca E2 (los de la corrida, cuando la corrida incluye E2 o E3): ~250 llamadas la primera
vez; después, sólo los países nuevos. Deja las ciudades en `hotel_provider_city` **sin hoteles**
(`hotel_count` en `NULL`): el autocompletado del API las sugiere como "se cargan al buscar" y, la
primera vez que alguien busca una, el API trae sus `HotelCodes` con un `TBOHotelCodeList` (1-5 s) y
la guarda. Es opt-in, corre al final de la corrida (no le quita presupuesto a E3 ni a E4) y tiene un
tope propio de 300 países por corrida. Para correrla, `workflow_dispatch` con `stages=E1,E2A` y
`max_calls=300`.

### Demanda y precarga

La demanda de una ciudad (qué refrescar primero en E3 y qué contenido bajar en E4) son las búsquedas
de los últimos `TBO_SYNC_DEMAND_WINDOW_DAYS` días que la nombran: las de un destino de la plataforma
traducido por el mapa de destinos aceptado, **y** las de una ciudad del catálogo local elegida en el
autocompletado propio (`search_logs.criteria.destinationProvider` + `destinationCityCode`), que antes
no contaban. Una ciudad buscada de un país fuera de `TBO_SYNC_COUNTRIES` (la que cargó el API bajo
demanda) también entra en E3 y E4 mientras tenga búsquedas; sin búsquedas, no.

`TBO_SYNC_CITIES` es para una corrida acotada, no para la operación diaria: con la lista, E3 y E4 sólo
tocan esas ciudades (con la cadencia y el orden de siempre) y las demás del país quedan pendientes. E2
sigue pidiendo la lista de ciudades por país. Un código que no está en `hotel_provider_city` para esos
países no falla: sale en el log como `tbo.sync.cities_unknown`.

## Stack de certificación

La base del stack de certificación (`sales_travel_cert`) no la toca este workflow: el catálogo se baja
desde el job `deploy-cert` de `.github/workflows/deploy.yml`, con la cuenta de **test** del stack y una
lista cerrada de países y ciudades. El comando y las comprobaciones están en
[`infrastructure/hostinger/README.md`](../../infrastructure/hostinger/README.md) §9.4.

Ese job sigue usando el **override**: `render-cert-env.mjs` escribe `TBO_SYNC_USERNAME` y
`TBO_SYNC_PASSWORD` en `catalog.env` desde `CERT_TBO_USERNAME` y `CERT_TBO_PASSWORD`, la misma cuenta
de test que el seed cifra en la bóveda del stack. Por la bóveda el sync no llegaría a ella: el seed la
guarda en el consolidador `tbo-cert`, no en la raíz `platform` que lee el sync, y `catalog.env` no
lleva `PROVIDER_CREDENTIALS_KEY`. Si algún día se quisiera el mismo camino que en producción, habría
que cargar en la raíz del stack una cuenta de test activa (mejor `catalogo`, no heredable), pasarle
la clave al contenedor y quitar las dos variables de `catalog.env`.

## Primera corrida con la cuenta de test (salida de PR-3.5)

1. Cargar la cuenta de TBO en Planetour desde el panel, en **Activo**
   ([docs/platform/13](../../docs/platform/13-validacion-modelo-red.md) §5 paso 6). No hace falta
   ningún secret ni desplegar.
2. `Run workflow` con `countries=CO` y `max_calls=200`. El log tiene una línea
   `tbo.sync.credentials` con `credentialSource: "vault:platform/default"` y termina con una línea
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

Una ciudad sin hoteles no es un fallo: TBO la contesta con `Status.Code` 500 "No Hotels Found", el ACL
la entrega como lista vacía en una sola llamada si llegó en menos de 4.500 ms
(`TBO_SLOW_NO_HOTELS_FOUND_MS`) y la ciudad queda con `hotel_count = 0` y su `synced_at`, sin volver a
pedirse hasta `TBO_SYNC_EMPTY_REFRESH_DAYS`. Las líneas de E3 y de `tbo.sync.result` la cuentan en
`citiesEmpty`, aparte de `citiesFailed`, y cada una deja una línea `info`
`tbo.static.city_without_hotels` con la ciudad y lo que tardó la llamada. Si el "No Hotels Found"
tarda 4.500 ms o más, es el plazo interno de TBO vencido: el ACL lo reintenta como un `500` (líneas
`warn` `tbo.http.error` con `reason: "slow_no_hotels_found"`) y, si no se recupera, la ciudad cuenta
en `citiesFailed` y se vuelve a pedir en la próxima corrida
([docs/tbo/01](../../docs/tbo/01-autenticacion-conectividad-y-errores.md) §8.5).
