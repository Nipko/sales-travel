# 18 · Arquitectura de búsqueda: pocas llamadas al proveedor

> Decisión del founder del 2026-11-11. La mayoría de las búsquedas no terminan en venta: cada
> llamada al proveedor que no hace falta es costo (Sabre cobra por consulta), latencia y
> look-to-book en contra. La regla es **pagar la llamada cuando el vendedor muestra interés**.

## 1. Lo que había (medido en código y en producción)

| Pieza                                       | Estado                                                       | Llamadas al proveedor            |
| ------------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| Filtros y orden                             | En el navegador, sobre lo ya traído                          | 0                                |
| Caché de búsqueda                           | Memoria del proceso, 90 s; se pierde en cada deploy          | —                                |
| Cuota por agencia                           | `search_quota_per_hour` (0035)                               | freno, no ahorro                 |
| Escalera de marcas de Sabre (docs/sabre/15) | 1 base + hasta 6 aerolíneas × 2 rondas, **en cada búsqueda** | **hasta 13**                     |
| Ida y vuelta: elegir la ida                 | Anchored Search + otra escalera                              | **hasta 13 más** por ida elegida |

El costo estaba en la escalera: se pagaba antes de saber si el vendedor iba a abrir una sola
tarjeta.

## 2. Decisión

### Fase 1 (esta entrega)

1. **Marcas por demanda.** La búsqueda (y la de vueltas) hace sólo la llamada base. Las otras
   marcas de un vuelo (LIGHT → FLEX…) se piden al abrir «Ver tarifas» de ESE vuelo: una ronda
   acotada a su aerolínea (`VendorPref=Only`) excluyendo las marcas ya vistas, hasta 2 rondas.
   Endpoint `POST /api/search/flights/fares`; port opcional `FlightMoreFaresPort`.
   La escalera completa sigue disponible por cuenta con `shopOptions.brandLadder: 'eager'`.
2. **Caché en Redis** (ya aprovisionado para BullMQ) detrás de `CachePort`: sobrevive deploys,
   la comparten las réplicas. TTL **10 min** para la búsqueda y para «más tarifas». Es seguro
   alargarlo porque el precio se revalida con el proveedor al elegir la tarifa (Flight Check /
   `offer-price`) antes de reservar. Si Redis no responde, cae a la memoria del proceso.
3. **Llamada única (single-flight).** Dos búsquedas idénticas a la vez —dos vendedores, un doble
   clic— esperan la misma respuesta en vez de salir dos veces al proveedor.

### Fase 2

4. **Búsqueda como sesión** (`searchId` en Redis): cotizar por referencia (`searchId` +
   `offerId`) en vez de mandar la oferta entera desde el navegador.
5. **Resultados por proveedor a medida que llegan** (stream), sin esperar al más lento.
6. Vueltas de ida y vuelta: primero las de la búsqueda (0 llamadas); las ancladas en segundo plano.

### Fase 3

7. Panel de look-to-book por agencia y proveedor sobre `search_logs`.
8. Presupuesto de llamadas por proveedor que apaga lo opcional si se dispara.

## 3. Filtros

Siempre en el navegador, nunca una llamada nueva: panel lateral en escritorio, hoja inferior en
el teléfono. Escalas, aerolíneas, equipaje, horario de salida y llegada por tramo, duración
máxima, aeropuertos (búsqueda por ciudad) y precio, cada opción con su conteo y su precio desde.

## 4. Lo que NO se hace

- Filtrar llamando al proveedor.
- Precalentar rutas populares: sería pagar búsquedas que nadie pidió.
- Cachear resultados degradados (un proveedor caído o ausente): congelaría la ausencia.

## 5. Calendario de precios ±3 días (2026-11-11)

Como el de los sitios de venta, pero **sin llamar al proveedor**: cada búsqueda guarda en
`search_logs` el precio de venta más bajo por proveedor en la moneda de la agencia (0094), y
`POST /search/flights/price-calendar` devuelve el mínimo por día de salida de lo que **esa agencia**
buscó en las últimas 72 h, con los mismos pasajeros, cabina, ruta y (en ida y vuelta) la misma
cantidad de noches. Lo lee la función `flight_price_calendar()` (SECURITY DEFINER, sólo agregados
de la agencia pedida), porque la lectura de `search_logs` está acotada a quien administra la red.

La pantalla los rotula como estimados; el día buscado muestra el precio real de la búsqueda y
elegir otro día lanza la búsqueda de verdad. No hay calendario para multidestino. Con poco uso, los
días vecinos salen sin precio («Ver»): el calendario se llena solo a medida que la agencia busca.
