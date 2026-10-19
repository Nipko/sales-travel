# Tarifas por tipo de pasajero (adulto, niño, infante)

**Estado:** validado en CERT el 2026-10-19 (búsqueda y Flight Check); reserva pendiente de H-07.
**Pedido del founder:** validar en Sabre las tarifas de adulto, niño e infante, y corregir lo que
falte.

---

## 1. Cómo se pide

BFM v5 REST no tiene campo de edad: el tipo de pasajero va en el **código**
(`TravelerInfoSummary.AirTravelerAvail[].PassengerTypeQuantity[].Code`, `v5.yml:7727-7750`, máximo 9).
Hoy mandamos `ADT`, `CNN` (niño genérico) e `INF` (infante en brazos)
(`providers/sabre/src/shop/request.builder.ts`, `SABRE_PTC`).

## 2. Sonda en CERT (2026-10-19, BOG-MIA ida y vuelta a 30+7 días, 2 ADT + 1 niño + 1 infante)

Sólo búsqueda y Flight Check, sin reservas ni dinero. Primera oferta (LATAM, `KLEESCO1`):

| Variante              | Adulto (c/u) | Niño                                     | Infante                  | Total    |
| --------------------- | ------------ | ---------------------------------------- | ------------------------ | -------- |
| `ADT` + `CNN` + `INF` | 648,89       | 497,69 (`KLEESCO1CH`)                    | 165,79 (`KLEESCO1IN`)    | 1.961,26 |
| `ADT` + `C08` + `INF` | 648,89       | **540,49** (8 años: +42,80 de impuestos) | 165,79                   | 2.004,06 |
| `ADT` + `CNN` + `INS` | 648,89       | 497,69                                   | **497,69** (con asiento) | 2.293,16 |

Además:

- La respuesta trae **7 itinerarios con precio y un `[Error] MIP/PROCESS: NO COMBINABLE FARES
FOR CLASS USED`** en `groupedItineraryResponse.messages[]`, en el mismo 200: Sabre cotiza las
  combinaciones que tienen tarifa de niño e infante y avisa del resto. Con un adulto solo, la misma
  ruta da 44-50 itinerarios y ningún error.
- El equipaje cambia por tipo: el infante lleva 1 pieza facturada donde el adulto lleva 2.
- **Flight Check** con los mismos pasajeros: la primera oferta revalida con el mismo total y el
  mismo desglose por tipo, y devuelve **un componente de tarifa por tipo de pasajero** sobre los
  mismos vuelos (`KLEESCO1`, `KLEESCO1CH`, `KLEESCO1IN`). La segunda oferta (interline
  `VLNA3PMI`/`IN90`) la rechaza con un error de negocio: no todo lo que BFM cotiza para niños pasa la
  revalidación.

## 3. Lo que estaba roto y se corrigió

1. **La búsqueda de Sabre caía entera con niños o infantes.** El clasificador de sobres trataba el
   `MIP/PROCESS` de `messages[]` como fallo de la operación y tiraba los 7 itinerarios válidos.
   Ahora `/v5/offers/shop` es un desenlace parcial declarado (`SABRE_PARTIAL_OUTCOME_CONTRACTS`,
   evidencia `PRICED_ITINERARIES` en `providers/sabre/src/errors.ts`), con tres condiciones: todo el
   fallo vive en `groupedItineraryResponse.messages[]`, cada fallo es de negocio y trae `type` del
   proveedor, y hay al menos un itinerario con `pricingInformation`. Sin itinerarios —el rechazo
   del upsell de marcas— sigue siendo un error, y la degradación de marcas no cambia. El adapter lo
   deja en el log como `sabre.shop.degradado` con `partialOutcome`.
2. **La reserva iba a cotizar al niño con la tarifa de adulto.** `specificFares` (createBooking) no
   lleva tipo de pasajero, y con un componente por tipo se fijaba el primer fare basis (el de
   adulto) para todos. Ahora el fare basis sólo se fija si cada vuelo tiene uno solo; la marca
   (`brandedFares`), que es la misma para todos los pasajeros, se fija siempre
   (`atpcoPricingFor`, `sabre-order-create.adapter.ts`).
3. **El vendedor no veía cuánto cuesta cada pasajero.** `fareBreakdown` llegaba bien mapeado y
   ninguna pantalla lo usaba. La tarjeta de tarifa muestra ahora «Precio por pasajero» (adulto,
   niño, infante) con el markup repartido en proporción al neto y el redondeo en un adulto, para
   que la suma cuadre al centavo (`salePerPax`, `apps/web-b2b/src/lib/sale-breakdown.ts`).

## 4. Decisiones de producto pendientes

- **Edad de cada niño.** Con `CNN` Sabre cotiza un niño genérico; con la edad (`C02`…`C11`) el precio
  puede cambiar (en la sonda, +42,80 USD por impuestos a los 8 años). Los sitios de venta piden la
  edad de cada niño al buscar. Implicaría un selector de edad por niño en el campo de pasajeros y
  mandar `Cnn` con la edad.
- **Infante con asiento (`INS`).** Hoy sólo existe «infante en brazos» (`INF`). Con asiento cotiza
  como un niño. Sería una opción por infante en el campo de pasajeros.
- **Reserva con niños e infantes en CERT**: pendiente de que Sabre resuelva H-07
  (`12-hallazgos-sandbox.md`).
