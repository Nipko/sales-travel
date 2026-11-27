# Fixtures LATAM NDC

XML **sintéticos**. Siguen la FORMA de los ejemplos oficiales del portal de LATAM
(`latamxp-sandboxdirectconnect.apigee.io`: `/ndc/air-shopping-v2`, `/ndc/price-offer-v2`,
`/ndc/order-retrieve`, `/ndc/order-change-pay-later`, `/ndc/order-void`, `/ndc/order-cancel`), pero
con valores inventados: rutas, ids, montos y tiquetes.

No son copias, porque la documentación es de socio y este repo es público. Cuando haya respuestas
reales del sandbox, se agregan aquí **redactadas**, sin nombres, documentos, correos ni teléfonos.

Ver `docs/latam-ndc/01-estado-y-plan.md`.

## `real/`: respuestas reales del sandbox (LAT-08)

Grabadas con `tools/latam/capture.mjs` desde el ambiente de pruebas de la Mac: una venta completa
sin pago, GRU → GIG con 1 adulto en BRL (búsqueda, revalidación, reserva BNPL, relectura y
cancelación), más un rechazo real de la creación (`90-…`). Redactadas al grabar: sin credenciales ni
datos de la agencia, y el pasajero, el correo y el teléfono reemplazados. La búsqueda va comprimida
(`.xml.gz`, 153 ofertas). Las lee `src/real-fixtures.test.ts`.

Para volver a grabarlas: ver el encabezado de `tools/latam/capture.mjs`. Sólo corre contra el
sandbox.
