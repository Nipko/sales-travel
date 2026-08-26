# tools/sabre

Utilidades de la integración de Sabre. Ninguna forma parte del runtime: son herramientas de análisis y de
validación contra el sandbox de certificación.

| Script              | Qué hace                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-postman.mjs` | Recalcula los conteos que citan los documentos de `docs/sabre/` sobre la colección Postman. Sirve para verificar que un documento no inventa cifras. |
| `cert-probe.mjs`    | Ejecuta la **Fase 0** contra el sandbox CERT: autenticación, entitlements, captura de shop, aporte incremental, latencia y capturas negativas.       |

## cert-probe.mjs

Implementa los pasos de [`docs/sabre/11-plan-implementacion.md`](../../docs/sabre/11-plan-implementacion.md) §4.2
que **no crean reservas**. Reservar y emitir quedan deliberadamente fuera: dependen de la decisión D1 (con qué
forma de pago se reserva) y generan PNR reales aunque sea en certificación.

### Antes de ejecutarlo

```bash
cp .env.sabre.example .env.sabre
# rellena SABRE_EPR, SABRE_PASSWORD y SABRE_PCC
```

`.env.sabre` está en `.gitignore`. **El `secret` no se pone a mano** — lo deriva el script con el esquema de doble
base64 de Sabre, y nunca se imprime ni se guarda: es reversible, así que equivale al password en claro.

### Uso

```bash
node tools/sabre/cert-probe.mjs auth
```

| Comando        | Paso del plan | Qué responde                                                                                                                                |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`         | —             | Que las credenciales sirven, y el `expires_in` real del token (**P-08**)                                                                    |
| `entitlements` | §4.2 paso 1   | Qué familias de API sirve nuestro PCC (**P-06**), y si `getseats`/`getAncillaries` nacen en la versión de la colección o en la del contrato |
| `shop`         | §4.2 paso 4   | Los 7 fixtures reales de `/v5/offers/shop` que faltaban                                                                                     |
| `value`        | §4.2 paso 2   | El aporte incremental, entrada de la compuerta Go/No-Go (**P-04**)                                                                          |
| `latency`      | §4.2 paso 7   | p50/p95 de `50ITINS` vs `200ITINS`, para RNF-01                                                                                             |
| `errors`       | §4.2 paso 6   | Las capturas negativas, única defensa real contra R-04                                                                                      |
| `all`          | —             | Todo lo anterior en orden                                                                                                                   |

Empieza siempre por `auth` y `entitlements`: un `403 ERR.2SG.SEC.NOT_AUTHORIZED` puede recortar el alcance antes
de que se escriba una línea de adapter.

### Qué produce

Capturas en `docs/sabre/evidence/captures/`, con la PII de pasajero redactada antes de escribir a disco —
`getBooking` hace eco de la request entera, así que sin eso los fixtures no se pueden versionar. El
`access_token` nunca se guarda.

El entregable que decide **no son los JSON** sino `docs/sabre/12-hallazgos-sandbox.md`, que hay que escribir a
partir de ellos y que debe cerrar con una recomendación Go / No-Go **con su número**.

### Por qué clasifica las respuestas en vez de mirar `response.ok`

Sabre transporta fallos de negocio dentro de HTTP `200`, y 14 de los 21 contratos oficiales declaran únicamente
`200` ([`12-cierre-auditoria.md`](../../docs/sabre/12-cierre-auditoria.md) §3.1). Un cliente que mire el código
HTTP da reservas fallidas por confirmadas. La función `classify()` de este script es el borrador de la regla de
éxito que el ACL tendrá que implementar de verdad, e incluye el caso más traicionero: un `200` con
`category: UNAUTHORIZED` dentro, que es un entitlement parcial y que el vendedor vería como datos vacíos.
