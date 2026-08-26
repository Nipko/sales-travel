---
titulo: Sabre — procedencia de las fuentes
fecha: 2026-08-25
estado: canonico
---

# Procedencia de las fuentes (citar SIEMPRE desde aquí)

Todo documento de `docs/sabre/` cita sus fuentes por referencia a este archivo. **No repetir rutas ni conteos en los front-matter.**

## 1. Colección Postman de Sabre — fuente primaria de _requests_

| Dato                                                         | Valor                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Archivo                                                      | `sabre/Booking Management API v2026.04.postman_collection.json`                                                    |
| SHA-256 fuente original (primeros 16)                        | `ffa47f6d2b58d9ec`                                                                                                 |
| SHA-256 copia versionada y saneada (primeros 16)             | `0a0fd3c905ccde12`                                                                                                 |
| Requests totales                                             | **1.077**                                                                                                          |
| Endpoints REST distintos                                     | 24                                                                                                                 |
| Requests SOAP/LLS (`{{soap_endpoint}}` / `{{lls_endpoint}}`) | **243**                                                                                                            |
| Respuestas guardadas **con cuerpo**                          | **4**, de 16.479 bytes cada una (todas `/v1/orders/view`, en `ModifyBooking`)                                      |
| Entorno                                                      | `sabre/BM API TEST CERT - EPR.postman_environment.json` — 425 variables, **sin credenciales embebidas por diseño** |

> **NO confundir** con `EXTERNAL_AGENCY.postman_collection.json` en la raíz del repo: esa es la colección de **LATAM NDC** (160 requests, endpoints `sandbox.api.latam.com/ndc/v192/*`), no tiene nada que ver con Sabre.

## 2. Contratos oficiales OpenAPI — fuente primaria de _respuestas_

Descargados de `developer.sabre.com` el 2026-08-25, sin autenticación, vía
`https://developer.sabre.com/api/v1/products/<slug>/_attachments/spec.yml`.

| Producto                         | Slug                                             | Formato                       | Cubre                                                                   |
| -------------------------------- | ------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| Booking Management v1.33         | `rest-api/booking-management-api/v1`             | Swagger 2.0, 270 definiciones | create/get/modify/cancelBooking, fulfill/void/refund/checkFlightTickets |
| Bargain Finder Max v5            | `rest-api/bargain-finder-max/v5`                 | OpenAPI 3.0                   | `/v5/offers/shop` + 3 ejemplos completos de respuesta                   |
| Bargain Finder Max v4            | `rest-api/bargain-finder-max/v4`                 | OpenAPI 3.0                   | `/v4/offers/shop`                                                       |
| Bargain Finder Max v3            | `rest-api/bargain-finder-max/v3`                 | Swagger 2.0                   | `/v3/offers/shop`                                                       |
| Offer Price NDC v1               | `rest-api/offer-price-ndc/v1`                    | OpenAPI 3.0                   | `/v1/offers/price`                                                      |
| Get Seats 3.0 (agency / airline) | `rest-api/get-seats-agency/3.0`, `…-airline/3.0` | OpenAPI 3.0                   | mapas de asiento                                                        |
| Get Ancillaries **Agency** 2.3   | `rest-api/get-ancillaries-agency/2.3`            | OpenAPI 3.0                   | `/v2/offers/getAncillaries` — **es el que usa la colección**            |
| Get Ancillaries **Airline** 3.0  | `rest-api/get-ancillaries-airline/3.0`           | OpenAPI 3.0, 1,0 MB           | `/v3/offers/getAncillaries/{byReservationPayload,byPnrLocator}`         |
| Manage Ancillary 1.1             | `rest-api/manage-ancillary/1.1`                  | OpenAPI 3.0                   | `/v1/ancillaries` add/remove/exchange                                   |
| Stateless Ancillaries 1.0        | `rest-api/stateless-ancillaries-api/1.0`         | Swagger 2.0                   | `/v1/dc/ancillaries` shop/add/remove                                    |
| Get Hotel Avail v5.0 / v4 / v3   | `rest-api/get-hotel-avail/v5.0`, `/v4`, `/v3`    | OpenAPI 3.0 / Swagger 2.0     | `/v5/get/hotelavail` — v5.0 es la versión que usa la colección          |
| Get Hotel Details v2             | `rest-api/get-hotel-details/v2`                  | Swagger 2.0                   | `/v2.0.0/get/hoteldetails`                                              |
| Hotel Price Check v5 / v4        | `rest-api/hotel-price-check/v5`, `/v4`           | OpenAPI 3.0                   | revalidación hotel                                                      |
| Get Vehicle Availability v2 / v1 | `rest-api/get-vehicle-availability/v2`, `/v1`    | OpenAPI 3.0                   | disponibilidad autos                                                    |
| Flight Reshop 1.0                | `rest-api/flight-reshop-api/1.0`                 | OpenAPI 3.0                   | reemisión / cambio                                                      |
| FlightCheck v1                   | `rest-api/flightcheck-api/v1`                    | OpenAPI 3.0                   | validación de itinerario                                                |

> **Cifras canónicas — cualquier documento que diga otra cosa está mal:** > **21 contratos** (3,9 MB) y **81 páginas** de documentación oficial (guías de uso, ejemplos y **listas de errores y warnings por endpoint**), convertidas a texto.
> Verificable con `ls -1 specs/*.yml | wc -l` y `find specs/help -name '*.txt' | wc -l`.

**No falta ningún spec.** Los 21 contratos cubren todos los endpoints REST que usa la colección.

### Sabor _agency_ vs _airline_, y deriva de versión

Sabre publica dos sabores del mismo producto de _merchandising_ — uno para agencias y otro para aerolíneas — con **rutas y versiones distintas**. No son deriva de versión: son productos diferentes. Nosotros somos agencia.

| Endpoint                | Versión en la colección     | Contrato que le corresponde                   | ¿Coinciden?                                                                                                   |
| ----------------------- | --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Ancillaries             | `/v2/offers/getAncillaries` | Get Ancillaries **Agency** 2.3 → `/v2/offers` | **Sí.** El `/v3/offers` es el sabor _airline_, otro producto.                                                 |
| Disponibilidad hotelera | `/v5/get/hotelavail`        | Get Hotel Avail v5.0 → `/v5/get/hotelavail`   | **Sí.**                                                                                                       |
| Mapas de asiento        | `/v1/offers/getseats`       | Get Seats **Agency** 3.0 → `/v3/offers`       | **No.** Deriva real: la colección va dos versiones por detrás. Ver `03-offers-price-asientos-ancillaries.md`. |

La única deriva real es la de asientos. Hay que decidir contra qué versión se implementa **antes** de escribir el builder.

## 3. Dónde está todo

Los specs y la documentación oficial usados por el análisis quedaron congelados dentro del repo:

```
docs/sabre/evidence/specs/
├── *.yml                       # 21 contratos OpenAPI (3,9 MB)
└── help/<producto>/*           # páginas oficiales, errores y metadata de catálogo
```

La colección permanece en `sabre/` con una única sanitización de seguridad: 23 ocurrencias de un
`<ClientSecret>` fijo en ejemplos SOAP se sustituyeron por `{{soap_client_secret}}`. El hash original se conserva
arriba para trazabilidad. Los conteos críticos se reproducen sin imprimir valores sensibles con
`node tools/sabre/audit-postman.mjs`. Las credenciales reales se guardan fuera de Git y se inyectan mediante
`ProviderCredentialsService`; el environment versionado debe seguir vacío.

## 4. Convención de marcado

| Marca               | Significa                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **VERIFICADO**      | Sale de un body/header/script real de la colección, o de un spec oficial. Cita la ruta del request o el archivo + línea del spec. |
| **VERIFICADO-SPEC** | Sale del contrato OpenAPI oficial, no de la colección.                                                                            |
| **[INFERIDO]**      | Deducción por convención NDC/OTA o por nombre de variable. Hay que confirmarlo contra el sandbox.                                 |
| **DESCONOCIDO**     | No está en ninguna fuente disponible. Solo se resuelve con acceso al sandbox CERT.                                                |

## Preguntas abiertas

1. **¿Contra qué versión de Get Seats se implementa** — la `/v1/offers/getseats` de la colección o la `/v3/offers` del contrato vigente?
2. **No existe contrato OpenAPI del carril SOAP/LLS.** Los 243 requests SOAP de la colección son la única fuente para esa parte, y no hay forma de verificarlos contra un contrato.

## Riesgos

1. **El contrato miente por omisión sobre los errores.** 14 de los 21 specs declaran únicamente `200`, y Sabre puede devolver errores de negocio dentro del cuerpo de éxito. Generar el cliente HTTP por codegen desde estos `.yml` sin un clasificador de envelope produce un cliente **ciego a los fallos**. No generar la política de errores desde estos contratos.
2. **Las citas `archivo.yml:línea` se rompen si Sabre republica un spec.** Los documentos tienen ~185 citas de ese tipo. Al fijar la versión hay que congelar también el archivo, no solo el número de versión.
3. **La colección de Postman y los contratos no siempre concuerdan** (asientos). Implementar leyendo solo la colección lleva a construir contra una versión retirada.
