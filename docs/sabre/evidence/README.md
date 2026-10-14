# Evidencia técnica de Sabre

Este directorio congela las fuentes técnicas usadas para reconciliar el análisis de `docs/sabre/` el
25 de agosto de 2026.

- `specs/`: 21 contratos OpenAPI/YAML y 81 capturas de páginas oficiales de Sabre Developer Portal.
- Procedencia: <https://developer.sabre.com/rest-api/booking-management-api/v1/index.html> y páginas enlazadas del
  catálogo oficial.
- La colección Postman analizada está en `sabre/`; sus métricas se reproducen con
  `node tools/sabre/audit-postman.mjs`. La copia versionada reemplaza 23 valores fijos de ejemplo
  `<ClientSecret>` por `{{soap_client_secret}}`; `docs/sabre/00-fuentes.md` conserva ambos hashes.
- No se almacenan EPR, PCC, passwords, tokens ni claves operativas en esta evidencia.

Las fuentes se conservan como evidencia, incluso cuando contienen ejemplos sintéticos del proveedor. El archivo
`get-hotel-avail-v5.0.yml` incluye un ejemplo YAML malformado en el material descargado; no debe utilizarse para
generar cliente sin normalización previa.

## Arnés de certificación contra CERT (SAB-11)

`apps/api/src/providers-sabre/cert-run/` corre escenarios reales contra Sabre CERT **con la cuenta de la bóveda**
(`provider_accounts`, descifrada con `PROVIDER_CREDENTIALS_KEY` dentro del proceso) y por las mismas puertas que
producción: el adapter que arma `SabreProviderFactory`, con la política de emisión de la cuenta. No crea órdenes, no
retiene carteras y no manda correos. Lo que encuentra se resume en
[`../12-hallazgos-sandbox.md`](../12-hallazgos-sandbox.md).

### Cómo se corre

En el VPS, dentro del contenedor de la API (la imagen ya trae el arnés compilado en `dist/`). Primero el plan, que
no toca ni la base ni la red:

```bash
cd /opt/sales-travel
docker compose --env-file .env exec -T api \
  node dist/providers-sabre/cert-run/sabre-cert-run.js --plan --scenarios sab-12
```

Después la corrida, con el tenant desde el que se resuelve la cuenta CERT (el dueño de la cuenta o un nodo que la
hereda):

```bash
docker compose --env-file .env exec -T api \
  node dist/providers-sabre/cert-run/sabre-cert-run.js --owner-tenant <uuid> --scenarios sab-12

# Emitir, anular, reembolsar o cobrar un EMD exige pedirlo:
docker compose --env-file .env exec -T api \
  node dist/providers-sabre/cert-run/sabre-cert-run.js --owner-tenant <uuid> --scenarios sab-13 --allow-money
```

Fuera del contenedor, desde un checkout con acceso a la base y la clave de la bóveda en el entorno (`PGHOST`,
`PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PROVIDER_CREDENTIALS_KEY`):

```bash
pnpm --filter @sales-travel/api build
pnpm --filter @sales-travel/api exec node dist/providers-sabre/cert-run/sabre-cert-run.js \
  --owner-tenant <uuid> --scenarios sab-12
```

Sin SSH, el workflow `Sabre CERT run` (`.github/workflows/sabre-cert-run.yml`) hace lo mismo y sube la carpeta como
artifact por 7 días. Sin `owner_tenant`, usa la variable del repositorio `SABRE_CERT_TENANT_ID`. Dispararlo es
una acción con efecto: se pide permiso en cada corrida.

```bash
gh workflow run sabre-cert-run.yml -f scenarios=sab-12
gh workflow run sabre-cert-run.yml -f scenarios=sab-13 -f allow_money=true
```

| Opción                 | Qué hace                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| `--scenarios`          | Escenarios o atajos por paquete, separados por comas (tabla de abajo)          |
| `--routes`             | Rutas de búsqueda. Default `BOG-LIM,LIM-GRU,BOG-MIA` (CO, PE, BR)              |
| `--book-route`         | Ruta de las reservas. Default: la primera de `--routes`                        |
| `--pax`                | `1ADT` (default), `2ADT1CHD`, `1ADT1INF`… con pasajeros de prueba a la vista   |
| `--days`               | Salida dentro de N días (default 30); `--return-days N` para ida y vuelta      |
| `--allow-money`        | Permite los escenarios que mueven dinero en CERT                               |
| `--account <uuid>`     | Exige que la cuenta resuelta sea ésa                                           |
| `--out`, `--run-id`    | Carpeta de la evidencia: `<out>/<runId>`, default `/tmp/sabre-cert-run/<fecha>` |

| Escenario           | Atajo  | Qué certifica                                                          | PNR | Dinero |
| ------------------- | ------ | ---------------------------------------------------------------------- | --- | ------ |
| `auth`              | sab-12 | Token de la cuenta y su vida real (P-08)                               | 0   | no     |
| `shop`              | sab-12 | Búsqueda por ruta, con el conteo por carril de contenido               | 0   | no     |
| `book-cancel`       | sab-12 | shop → flightCheck → createBooking → getBooking → cancel → getBooking  | 1   | no     |
| `book-issue-void`   | sab-13 | Emisión con la forma de pago de la cuenta (D1), checkFlightTickets, VOID | 1 | sí     |
| `seatmap`           | sab-21 | Get Seats ATPCO antes de reservar                                      | 0   | no     |
| `book-with-seat`    | sab-21 | Reserva con un asiento sin cargo y cancelación                         | 1   | no     |
| `ancillaries`       | sab-21 | Una maleta con precio, emisión con EMD y VOID                          | 1   | sí     |
| `shop-ndc`          | sab-22 | Búsqueda con NDC pedido sólo para la corrida (captura para el mapper)  | 0   | no     |
| `book-issue-refund` | sab-24 | Emisión, estimado de checkFlightTickets y REFUND (sigue apagado en producto, D9) | 1 | sí |

### Las puertas

- **Sólo CERT, por el host.** No basta con que la cuenta declare `environment: cert`: el host REST y el SOAP ya
  resueltos tienen que ser exactamente los de CERT (`https://api.cert.platform.sabre.com` y
  `https://webservices.cert.platform.sabre.com`), y la plataforma tiene que tratar la cuenta como de pruebas. Si no,
  sale con `3` y `NO SE CORRE` sin una sola llamada.
- **El transporte vuelve a mirar.** El `fetch` del proceso del arnés bloquea cualquier URL que no sea CERT antes de
  salir, aunque algo se saltara la primera puerta.
- **Dinero sólo con `--allow-money`,** y cada paso que lo mueve se imprime con `[DINERO]` —PNR, pasajeros, forma de
  pago, importe del EMD o estimado del reembolso— **antes** de llamar.
- **Como mucho 3 PNR por corrida,** con pasajeros `TEST/PASAJERO UNO…`, documentos `TEST…` y contacto
  `cert-run@example.com`.
- **Limpia al terminar cada escenario,** aunque falle a mitad: cancela lo reservado y anula lo emitido. Lo que no
  pudo cerrar sale en `summary.json` → `leftovers` con el motivo, y la corrida termina con `2`.
- **`SABRE_OPERATIONS` del proceso** son exactamente las que el plan necesita (`--plan` las muestra). Es otro proceso:
  la API que está corriendo sigue con las suyas.

Salida: `0` todo bien · `1` un escenario falló · `2` quedó algo sin limpiar (cerrarlo en Sabre Red y anotarlo en
[12 §5](../12-hallazgos-sandbox.md#5-pnr-que-quedaron-vivos)) · `3` la corrida se negó a correr.

### Qué queda en la carpeta y cómo se trae

`<out>/<runId>/` tiene un archivo por paso (`01-auth-token.json`, `02-shop-shop-bog-lim.json`…) con la request y la
respuesta de cada llamada, su duración, su `Conversation-ID` y el resultado del paso; `summary.json` con la cuenta
(sin credenciales), el plan, los PNR y su estado final; y `summary.md` con las filas para
[`12-hallazgos-sandbox.md`](../12-hallazgos-sandbox.md).

La redacción va en tres capas: por clave y por forma con la política del ACL (`redactDocument`: credenciales, PCC,
PII de pasajero y texto libre del proveedor), el token nunca (del cuerpo de `/v2/auth/token` sólo quedan
`token_type` y `expires_in`, y las cabeceras salen de una lista blanca sin `Authorization`), y una última pasada que
busca literales la credencial de la cuenta, el `secret` derivado y cada token recibido. Si esa última pasada tapa
algo, `summary.json` lo cuenta en `evidence.secretsScrubbed` y no se versiona hasta entender por qué.

El `/tmp` del contenedor se pierde con el siguiente despliegue: se copia al terminar.

```bash
cd /opt/sales-travel
docker compose --env-file .env cp api:/tmp/sabre-cert-run/<runId> /tmp/sabre-cert-run-<runId>
docker compose --env-file .env exec -T api rm -rf /tmp/sabre-cert-run/<runId>
# y desde la máquina local:
scp -r <usuario>@<vps>:/tmp/sabre-cert-run-<runId> docs/sabre/evidence/cert/<AAAA-MM-DD>-<runId>
```
