# seed-tbo-cert-tenant

Siembra el tenant de certificación de TBO en la base del stack de certificación
([`docs/tbo/07`](../../docs/tbo/07-certificacion.md) §7.3 y §7.4; [`09`](../../docs/tbo/09-plan-implementacion.md)
PR-7.2). El stack, el despliegue y los registros DNS están en
[`infrastructure/hostinger/README.md`](../../infrastructure/hostinger/README.md) §9.

## Qué deja en la base

| Qué                 | Cómo                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant `tbo-cert`   | Consolidador raíz, sin hijos, nombre neutro. El factory de TBO sólo opera cuentas de plataforma o de consolidador (D-TBO-03 A).                                                                             |
| Usuario `vendedor`  | Rol `vendedor`: busca, reserva y cancela **sin MFA** (07 §7.4). Correo verificado; el stack no envía correo.                                                                                                |
| Cuenta `tbo-hotels` | `active`, no heredable, `environment: test`. Usuario y contraseña cifrados con la clave del stack, leídos del entorno del contenedor. Sólo acepta el host de test de TBO: este stack nunca guarda una live. |
| Cartera             | En `CERT_CURRENCY`, recargada hasta `CERT_WALLET_BALANCE` con un `DEPOSIT_PAYMENT` del seed (nunca PAN, D1).                                                                                                |
| Regla de markup     | `hotels`, porcentaje `CERT_HOTEL_MARKUP_PERCENT`. Margen bajo a propósito: el tester ve el precio de venta y el piso del `RecommendedSellingRate` actuando (CK-09).                                         |
| Clientes del CRM    | Cuatro ficticios (correo `example.com`, sin teléfono), de cuatro nacionalidades, con el documento cifrado como lo guarda el api.                                                                            |

Es **idempotente** y corre en cada despliegue del stack: no duplica clientes ni depósitos, no rota una contraseña que
no cambió (rotarla cierra las sesiones abiertas) y deja como está lo que ya coincide.

## Se niega a sembrar cuando

- la base no se llama `sales_travel_cert` (así no escribe la cuenta de test en producción por error), o el rol no es
  superusuario;
- hay cuentas de **otros proveedores** en cualquier tenant de la base (RC-07);
- el slug `tbo-cert` es de un tenant que no es un consolidador raíz, o tiene hijos;
- el correo del vendedor es de un usuario de otra red (no le cambia la contraseña);
- hay otra cuenta de TBO `active` en el tenant, o la actual ya tiene órdenes y cambió su usuario o su URL (se quedarían
  sin post-venta);
- la cuenta guardada no se descifra con `PROVIDER_CREDENTIALS_KEY` (la clave del stack cambió);
- la cartera cambia de moneda y ya tiene movimientos de reservas.

Sale con `1` y una línea JSON con el motivo. Nunca imprime un valor de credencial.

## Variables

Las escribe `infrastructure/hostinger/render-cert-env.mjs` en `seed.env`; el job `deploy-cert` las toma de los secrets y
variables `CERT_*` de GitHub del mismo nombre.

| Variable                                 | Obligatoria | Por defecto                             |
| ---------------------------------------- | ----------- | --------------------------------------- |
| `PGHOST`, `PGUSER`, `PGPASSWORD`         | Sí          | Las del stack (`postgres`)              |
| `PGPORT`, `PGDATABASE`                   | No          | `5432`, `sales_travel_cert`             |
| `PROVIDER_CREDENTIALS_KEY`               | Sí          | La del api del stack                    |
| `CERT_TBO_USERNAME`, `CERT_TBO_PASSWORD` | Sí          | —                                       |
| `CERT_TBO_BASE_URL`                      | No          | La de test del ACL                      |
| `CERT_VENDEDOR_PASSWORD`                 | Sí          | — (12 caracteres, 72 bytes)             |
| `CERT_VENDEDOR_EMAIL`                    | No          | `tbo.tester@planetour.cloud`            |
| `CERT_VENDEDOR_NAME`                     | No          | `TBO Tester`                            |
| `CERT_VENDEDOR_STATUS`                   | No          | `active` (`suspended` tras el sign-off) |
| `CERT_TENANT_NAME`                       | No          | `Sales-Travel Certification`            |
| `CERT_COUNTRY`                           | No          | `CO`                                    |
| `CERT_CURRENCY`                          | No          | `USD`                                   |
| `CERT_WALLET_BALANCE`                    | No          | `50000` (unidades mayores)              |
| `CERT_HOTEL_MARKUP_PERCENT`              | No          | `5`                                     |

`CERT_CURRENCY` tiene que ser la moneda de perfil de la cuenta de test de TBO, la que imprime `tools/tbo` `check`
([Q-82](../../docs/tbo/10-preguntas-para-tbo.md#q-82)): la retención de la cartera rechaza una reserva en otra moneda.

## Correrlo a mano

Lo normal es el job `deploy-cert`. A mano, en el VPS, con un `seed.env` en el formato de `docker run --env-file` (una
línea `NOMBRE=valor`, sin comillas):

```bash
cd /opt/sales-travel-cert
docker run --rm --network sales-travel-cert_internal --env-file seed.env \
  ghcr.io/nipko/sales-travel-seed-tbo-cert-tenant:<tag>
rm -f seed.env
```

## Tests

`pnpm --filter @sales-travel/seed-tbo-cert-tenant test`. `seed.integration.test.ts` corre contra Postgres cuando hay
`PGHOST`/`PGUSER`/`PGPASSWORD` (el CI) y se salta sin ellas. `crypto.contract.test.ts` cifra con este paquete y descifra
con los módulos de `apps/api`. `stack-contract.test.ts` es la prueba de RC-07 sobre el render del `.env`, el compose, el
Caddyfile y el job.
