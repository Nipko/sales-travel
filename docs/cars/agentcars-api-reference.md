# AgentCars API v2 — Referencia de integración

> Fuente: docs/cars/ (páginas oficiales + colección Postman)
> Entorno inicial: **desarrollo**

---

## 1. Configuración base

| Ítem | Valor |
|------|-------|
| Base URL **dev** | `https://api.dev.agentcars.com/v2/sites` |
| Base URL **prod** | `https://api.agentcars.com/v2/sites` |
| Suggest URL | `https://suggest.agentcars.com/suggest/` |
| Autenticación | Query param `access-token` en cada request |
| Formato default | JSON |
| Formato alternativo | Agregar `_format=xml` al query |
| Idiomas | `en`, `es`, `ja`, `ko`, `pt`, `de`, `fr`, `it`, `ar` |

**Todas las peticiones necesitan:** `?access-token=<TOKEN>&source=<ISO2>`

---

## 2. Flujo completo (orden obligatorio)

```
[Suggest]          → autocomplete ubicaciones
     ↓
[FindOffices]      → verificar oficinas disponibles (opcional)
     ↓
[Rates]            → obtener tipos de tarifa válidos para origen/destino
     ↓
[GetMatrix]        → buscar autos disponibles con precios
     ↓
[GetSelection]     → seleccionar auto específico → genera uniqid (TTL: 15 min)
     ↓
[GetRateInformation] → detalle completo del precio seleccionado
     ↓
[Confirmation]     → confirmar reserva → retorna confirmationCode
     ↓
[MyReservation]    → recuperar voucher completo
     ↓
[Cancel]           → cancelar (si aplica)
[Release]          → activar reserva ON HOLD (si aplica)
[GetDailyReport]   → reporte consolidado diario
```

---

## 3. Endpoints detallados

### 3.1 Suggest — Autocomplete ubicaciones

```
GET https://suggest.agentcars.com/suggest/
```

**Params:**

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `query` | SÍ | Texto a buscar (ej: `"miami"`) |
| `lang` | NO | ISO idioma (ej: `es`) |

**Response fields:**

| Campo | Descripción |
|-------|-------------|
| `airport` | `true/false` — es aeropuerto |
| `cityLoc` | `true/false` — es ubicación ciudad |
| `countryCode` | Código país (ej: `US`) |
| `hasoffice` | Cantidad de oficinas cercanas |
| `iata` | Código IATA si aplica |
| `latitude` / `longitude` | Coordenadas |
| `timezone` | Ej: `America/New_York` |
| `value` | Nombre display: `NOMBRE, IATA, ESTADO, PAÍS` |

---

### 3.2 FindOffices — Buscar oficinas

```
GET /find-offices
```

**Params:**

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `distance` | SÍ | Distancia en millas |
| `source` | SÍ | País origen, código alpha-2 (ej: `CO`) |
| `lat` | SÍ* | Latitud (*si se envían coordenadas) |
| `lng` | SÍ* | Longitud (*si se envían coordenadas) |
| `cityCode` | SÍ** | Código ciudad ej: `MIA` (**si NO se envían coordenadas) |
| `companyCode` | NO | Filtrar por empresa específica |

**Response fields por oficina:**

| Campo | Descripción |
|-------|-------------|
| `office_code` | Código de oficina (6 letras, ej: `MIAE08`) |
| `company_code` / `company_name` | Empresa |
| `address` | Dirección |
| `city_name`, `state`, `country_code` | Ubicación |
| `lat`, `lng` | Coordenadas |
| `zip_code` | Código postal |
| `distance` | Distancia desde búsqueda |
| `schedule` | Objeto con días 1–7 (1=Lunes, 7=Domingo) |
| `schedule[n].opening` / `.close` | Horario en formato 24h |

---

### 3.3 Rates — Tipos de tarifa

```
GET /rates
```

**Params:**

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `country` | SÍ | Código país destino |
| `source` | SÍ | Código país origen |
| `language` | NO | ISO idioma |

**Uso del resultado:** los IDs retornados se usan como valor de `rateType` en GetMatrix/GetSelection.
También se puede usar `rateType=best` (tarifa más económica disponible).

---

### 3.4 GetMatrix — Buscar autos disponibles

```
GET /get-matrix
```

**Params:**

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `pickUpLocation` | SÍ | Código IATA aeropuerto (ej: `MIA`) O código oficina (ej: `MIAC04`) O `"City"` |
| `dropOffLocation` | SÍ | Igual que pickUp; usar `"City2"` si devolución en ciudad diferente |
| `pickUpDate` | SÍ | `yyyy-mm-dd` |
| `dropOffDate` | SÍ | `yyyy-mm-dd` |
| `pickUpHour` | SÍ | Militar HHMM (ej: `0800`, `1600`) |
| `dropOffHour` | SÍ | Militar HHMM |
| `rateType` | SÍ | `"best"` o ID de /rates |
| `country` | SÍ | Código país destino |
| `source` | SÍ | Código país origen |
| `lat` / `lng` | SÍ** | Coordenadas recogida (**requerido en búsqueda ciudad) |
| `latDropOff` / `lngDropOff` | SÍ** | Coordenadas devolución (**requerido si ciudad diferente) |
| `companyCode` | NO | Filtrar por empresa |
| `cdCode` | NO | Código de descuento |
| `pcCode` | NO | Código de promoción |
| `paymentType` | NO | `ppd` (pago ahora) o `pod` (pago en destino) |
| `language` | NO | ISO idioma |

**Tipos de ubicación:**
- **Aeropuerto:** código IATA 3 letras (`MIA`, `LAX`, `BOG`)
- **Oficina específica:** código 6 letras (`MIAE08`, `MIAC72`)
- **Ciudad (mismo punto):** `"City"` + `lat`/`lng`
- **Ciudad (puntos diferentes):** pickup=`"City"`, dropoff=`"City2"` + coordenadas ambos

**Response fields por auto:**

| Campo | Descripción |
|-------|-------------|
| `category` | Categoría del auto |
| `sippCode` | Código SIPP (ej: `ECAR`, `CCAR`) |
| `companyCode` / `companyName` | Empresa arrendadora |
| `rateAmount` | Precio |
| `currency` | Moneda (ej: `USD`, `COP`) |
| `paymentOption` | Tipo de pago |
| `carModel` | Modelo |
| `doors` | Puertas |
| `passengers` | Capacidad |
| `bags` | Maletas |
| `trans` | Transmisión |
| `air` | Aire acondicionado |
| `kmIncluded` | Kilómetros incluidos |
| `baseAprox` | Base aproximada |
| `taxAprox` | Impuestos aproximados |
| `convertedCurrency` | Moneda convertida |
| `convertedRateAmount` | Precio en moneda convertida |
| `ccrc` | Token interno (pasar en GetSelection) |

---

### 3.5 GetSelection — Seleccionar auto específico

```
GET /get-selection
```

**Params:** mismos que GetMatrix **+**

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `companyCode` | SÍ | Código empresa seleccionada |
| `sippCode` | SÍ | Código SIPP del auto seleccionado |
| `ccrc` | NO | Token del auto (viene de GetMatrix response) |
| `tp` | NO | Tipo de pago específico |
| `coupon` | NO | Cupón de descuento |

**Response key:**

| Campo | Descripción |
|-------|-------------|
| `uniqid` | ID de sesión — **válido 15 minutos** |
| (resto de campos de auto + desglose de precio) | |

> ⚠️ Si el `uniqid` expira, se debe llamar nuevamente a GetSelection.

---

### 3.6 GetRateInformation — Detalle de tarifa

```
GET /get-rate-information
```

**Params:**

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `uniqid` | SÍ | De GetSelection |
| `paymentType` | SÍ | `ppd` o `pod` |
| `rateType` | SÍ | Tipo de tarifa usado |

**Response fields clave:**

| Campo | Descripción |
|-------|-------------|
| `base` | Monto que el cliente paga ahora |
| `tax` | Monto a pagar en mostrador |
| (desglose de cargos adicionales) | |

> Para comisiones usar: `realBase` (comisionable) + `realTax` (no comisionable)

---

### 3.7 Confirmation — Confirmar reserva

```
POST /confirmation
Content-Type: multipart/form-data
```

**Body (form-data):**

| Parámetro | Requerido | Tipo | Descripción / Ejemplo |
|-----------|-----------|------|----------------------|
| `uniqid` | SÍ | string | De GetSelection (ej: `58e7a97b506d4`) |
| `paymentType` | SÍ | string | `ppd` o `pod` |
| `rateType` | SÍ | string | Índice de tarifa (ej: `3`) |
| `companyCode` | SÍ | string | Empresa (ej: `ZT`) |
| `sippCode` | SÍ | string | SIPP (ej: `CCAR`) |
| `pickUpLocation` | SÍ | string | Código IATA/oficina (ej: `LAX`) |
| `dropOffLocation` | SÍ | string | (ej: `LAX`) |
| `pickUpDate` | SÍ | string | `yyyy-mm-dd` |
| `dropOffDate` | SÍ | string | `yyyy-mm-dd` |
| `pickUpHour` | SÍ | string | HHMM (ej: `1200`) |
| `dropOffHour` | SÍ | string | HHMM |
| `pickUpAddress` | SÍ | string | Dirección completa o `NA` |
| `dropOffAddress` | SÍ | string | Dirección completa o `NA` |
| `firstName` | SÍ | string | Nombre del conductor |
| `lastName` | SÍ | string | Apellido del conductor |
| `age` | SÍ | int | `1`=Mayor 25 / `2`=21-24 / `3`=Menor 21 |
| `email` | SÍ | string | Email del cliente |
| `realBase` | SÍ | decimal | Base comisionable (ej: `118.00`) |
| `realTax` | SÍ | decimal | Impuestos no comisionables (ej: `20.00`) |
| `total` | SÍ | decimal | Total con impuestos |
| `currency` | SÍ | string | Moneda (ej: `USD`) |
| `ccrc` | NO | string | Token del auto (de GetMatrix/GetSelection) |
| `cdCode` | NO | string | Código descuento |
| `pcCode` | NO | string | Código promoción |
| `cbs` | NO | string | Silla niño 2-5 años: `"1"` / null |
| `cst` | NO | string | Silla bebé 0-2 años: `"1"` / null |
| `gps` | NO | string | GPS: `"1"` / null |
| `skyracks` | NO | string | Portaesquís: `"1"` / null |
| `flight_number` | NO | string | Número de vuelo (ej: `AA1234`) |
| `fFlyerNbr` | NO | string | Número viajero frecuente |
| `fFlyerCarrier` | NO | string | Aerolínea viajero frecuente |
| `fmember` | NO | string | Membresía (Avis, Hertz, National) |
| `on_hold` | NO | string | `"1"` para crear reserva ON HOLD |
| `language` | NO | string | ISO idioma respuesta |

**Response fields:**

| Campo | Descripción |
|-------|-------------|
| `confirmationCode` | Código de confirmación de la reserva |
| `sippCode` | SIPP del auto confirmado |
| `rateCode` | Código de tarifa |
| `status` | Estado: `confirmed`, `on_hold`, `on_request` |

---

### 3.8 Release — Activar reserva ON HOLD

```
POST /release-reservation
Content-Type: multipart/form-data
```

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `lastName` | SÍ | Apellido del conductor |
| `referenceCode` | SÍ | Código de referencia de la reserva |

**Response:** igual que confirmation (`confirmationCode`, `status` → `"activated"`)

> ⚠️ Reservas ON HOLD deben confirmarse al menos **48 horas antes** del pickup, o son auto-canceladas.

---

### 3.9 ON REQUEST — Reservas en espera

Cuando `status = "on_request"`:
- Reservas prepagadas se pueden cancelar sin cargo hasta 2 días antes del pickup
- Cancelaciones con menos de 2 días tienen penalización
- No-show en prepagadas: se retiene todo el valor del voucher

---

### 3.10 MyReservation — Consultar reserva

```
POST /my-reservation
Content-Type: multipart/form-data
```

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `lastName` | SÍ | Apellido del conductor |
| `confirmationCode` | SÍ | Código de la empresa arrendadora |
| `language` | NO | ISO idioma |

**Response:** información completa + nodo `voucherInformation`

> ⚠️ Obligatorio mostrar **toda** la información del nodo `voucherInformation` al cliente.

> `voucherNumber` aparece en reservas prepagadas (PPD).

---

### 3.11 Cancel — Cancelar reserva

```
POST /cancel
Content-Type: multipart/form-data
```

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `lastName` | SÍ | Apellido del conductor |
| `confirmationCode` | SÍ | Código de confirmación |

---

### 3.12 GetDailyReport — Reporte diario consolidado

```
GET /get-daily-report  (o equivalente)
```

**Response fields:**

| Campo | Descripción |
|-------|-------------|
| `confirmationCode` | Código de cada reserva |
| `pickUpDate` | Fecha recogida |
| `dropOffDate` | Fecha devolución |
| `date` | Fecha del reporte |
| `status` | Estado de la reserva |

---

## 4. DeepLink / Get URL — Generar URL de búsqueda

```
GET https://www.agentcars.com/subsite/{lang}/site/get-url/
```

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `pickUpLocation` | SÍ | IATA |
| `dropOffLocation` | SÍ | IATA |
| `pickUpDate` | NO | `yyyy-mm-dd` |
| `dropOffDate` | NO | `yyyy-mm-dd` |
| `pickUpHour` | NO | HHMM |
| `dropOffHour` | NO | HHMM |
| `source` | NO | País origen |
| `country` | NO | País destino |
| `paymentType` | NO | `ppd` / `pod` |
| `lang` | NO | ISO idioma |

**Response:** `{ "url": "https://..." }`

---

## 5. Reglas de negocio clave

| Regla | Detalle |
|-------|---------|
| `uniqid` TTL | **15 minutos** desde GetSelection; si expira → llamar GetSelection de nuevo |
| `rateType=best` | Siempre disponible = tarifa más económica |
| Formato horas | Militar HHMM: `0800`=8am, `1200`=12pm, `1600`=4pm |
| Formato fechas | `yyyy-mm-dd` |
| `age` valores | `1`=mayor 25 / `2`=21-24 años / `3`=menor 21 |
| Comisiones | `realBase` (comisionable) + `realTax` (no comisionable) |
| ON HOLD deadline | Confirmar mínimo **48h antes** del pickup |
| Voucher display | Mostrar **todo** el nodo `voucherInformation` al cliente |
| `voucherNumber` | Solo aparece en reservas PPD (prepagadas) |
| XML | Agregar `_format=xml` a cualquier endpoint |

---

## 6. Variables de entorno (Postman → `.env`)

```bash
# Dev
AGENTCARS_BASE_URL=https://api.dev.agentcars.com/v2/sites
AGENTCARS_SUGGEST_URL=https://suggest.agentcars.com/suggest
AGENTCARS_ACCESS_TOKEN=<token-dev>
AGENTCARS_SOURCE=CO        # país de origen del agente
AGENTCARS_COUNTRY=US       # país destino default

# Valores default para testing
AGENTCARS_PICKUP_LOCATION=MIA
AGENTCARS_DROPOFF_LOCATION=MIA
AGENTCARS_PICKUP_HOUR=1000
AGENTCARS_DROPOFF_HOUR=1000
AGENTCARS_RATE_TYPE=best
AGENTCARS_COMPANY_CODE=ZI
AGENTCARS_SIPP_CODE=ECAR
```

---

## 7. Orden de construcción del módulo (prioridad)

1. **Config + HttpClient** — base URL, auth interceptor, error handler
2. **SuggestService** — autocomplete (UX entrada)
3. **RatesService** — obtener tipos de tarifa disponibles
4. **GetMatrixService** — búsqueda de autos (endpoint principal)
5. **GetSelectionService** — selección + gestión de `uniqid`
6. **GetRateInformationService** — detalle de precio antes de confirmar
7. **ConfirmationService** — booking
8. **MyReservationService** — voucher post-booking
9. **CancelService** — cancelación
10. **FindOfficesService** — mapa de oficinas (opcional en fase 1)
11. **ReleaseService** — ON HOLD flow
12. **GetDailyReportService** — backoffice

---

## 8.bis Surface REST interno (CarsModule de nuestra API)

El módulo `apps/api/src/cars/` expone el flujo de AgentCars como REST propio (auth global, multi-tenant
BYOC). `source` (origen) lo completa el adapter desde la cuenta del tenant si no se envía; `country`
(destino) es **requerido** en search/rates/selection. Montos a `Money` canónico (`{amountMinor,currency}`).

| Método | Ruta | Body/Query | Adapter |
|--------|------|-----------|---------|
| GET  | `/cars/suggestions` | `?q=&lang=` | `suggest` |
| GET  | `/cars/offices` | `?distance=&(lat&lng│cityCode)&source?&companyCode?` | `findOffices` |
| GET  | `/cars/rates` | `?country=&source?&language?` | `getRates` |
| POST | `/cars/search` | matrix (country req.; City/City2 exige coords) | `getMatrix` |
| POST | `/cars/selection` | search + `companyCode,sippCode` | `getSelection` |
| GET  | `/cars/rate-detail` | `?uniqid=&paymentType=&rateType=` | `getRateDetail` |
| POST | `/cars/book` | confirmación (montos numéricos→Money) | `confirm` |
| POST | `/cars/reservation` | `{lastName,confirmationCode,language?}` | `myReservation` |
| POST | `/cars/reservations/cancel` | `{lastName,confirmationCode}` | `cancel` |
| POST | `/cars/reservations/release` | `{lastName,referenceCode}` | `release` |
| GET  | `/cars/daily-report` | `?date?&language?` | `getDailyReport` |

**Provider package:** `@sales-travel/agent-cars` (`providers/agent-cars/`). Factory BYOC + env:
`apps/api/src/providers-agent-cars/agent-cars.factory.ts`. El `source` autoritativo sale de
`AGENT_CARS_SOURCE` / `config.sourceCountry` de la cuenta.

---

## 8. Endpoints resumen (colección Postman)

| Endpoint | Método | Path |
|----------|--------|------|
| FindOffices | GET | `/v2/sites/find-offices` |
| Rates | GET | `/v2/sites/rates` |
| GetMatrix (aeropuerto) | GET | `/v2/sites/get-matrix` |
| GetMatrix (ciudad) | GET | `/v2/sites/get-matrix` |
| GetSelection | GET | `/v2/sites/get-selection` |
| GetRateInformation | GET | `/v2/sites/get-rate-information` |
| Confirmation | POST | `/v2/sites/confirmation` |
| Cancel | POST | `/v2/sites/cancel` |
| MyReservation | POST | `/v2/sites/my-reservation` |
| Release | POST | `/v2/sites/release-reservation` (verificar) |
| GetDailyReport | GET/POST | `/v2/sites/get-daily-report` (verificar) |
