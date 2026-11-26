# Ambiente de pruebas — Mac mini (`pruebas.planetour.cloud`)

Stack completo de Sales-Travel para pruebas con **proveedores reales en sus sandboxes**, separado de
producción (otra máquina, otra base, otras claves). Sirve para dos cosas:

1. **Pruebas manuales** en `https://pruebas.planetour.cloud`, detrás de Cloudflare Access.
2. **Pruebas automatizadas** (Playwright, `apps/web-b2b/e2e`) que corren en la misma Mac contra
   `127.0.0.1`, sin pasar por Cloudflare.

```
navegador ── Cloudflare Access ── túnel (cloudflared) ── web-b2b ── api ── postgres / redis
                                                                     └──── sandboxes de proveedores
Playwright (en la Mac) ── 127.0.0.1:3201 (panel) / :4201 (api) / :5532 (postgres)
Mailpit ── 127.0.0.1:8025 (todo el correo del ambiente; nunca sale a un cliente)
```

## 1. Dónde vive

- Máquina: Mac mini `inipkos-mac-mini` (Tailscale), usuario `inipko`. Docker = Colima
  (6 CPU, 10 GiB, 100 GiB).
- Código: `~/sales-travel-pruebas` (clon del repo). Secretos: `infrastructure/pruebas/.env`
  (permisos 600, fuera de git), generados por `./pruebas.sh init` y **propios de este ambiente**.
- Imágenes construidas en la Mac (arm64): `sales-travel-pruebas/{api,web-b2b,migrate}:local`.

## 2. Operación

```bash
cd ~/sales-travel-pruebas/infrastructure/pruebas
./pruebas.sh init           # una vez: crea .env con secretos nuevos
./pruebas.sh up             # construye y levanta (y el túnel, si está configurado)
./pruebas.sh status         # estado y health
./pruebas.sh logs api       # logs de un servicio
./pruebas.sh e2e            # suite Playwright completa contra este stack, con las ventas @real
./pruebas.sh e2e --project=setup --project=desktop -g @real   # sólo las ventas con sandboxes
./pruebas.sh e2e --project=desktop e2e/tests/f1-login.e2e.ts   # una parte
./pruebas.sh down           # apaga (conserva la base)
./pruebas.sh reset-db       # apaga y BORRA base y Redis
```

Actualizar el código: traer la rama nueva (`git pull` o bundle) y `./pruebas.sh up` (reconstruye).

## 3. Acceso web: túnel + Cloudflare Access

1. `./pruebas.sh tunnel-setup`: instala `cloudflared`, pide **una vez** abrir una URL para autorizar la
   zona `planetour.cloud` (lo hace el founder, en su navegador), crea el túnel `sales-travel-pruebas`, el
   CNAME `pruebas` y levanta el servicio `tunnel`.
2. **Cloudflare Access** (lo hace el founder en el dashboard, Zero Trust → Access → Applications):
   _Self-hosted_, dominio `pruebas.planetour.cloud`, política _Allow_ con los correos autorizados,
   login por código de un solo uso al correo. Sin esta política el panel queda expuesto a internet con
   los usuarios de prueba sembrados.

   Estado al 2026-11-25: zona `planetour.cloud` en la cuenta de Cloudflare `Amazonluxuryhotellet`
   (team `gecko-server`); aplicación `pruebas` con la política `pruebas-correos-autorizados` (Allow,
   regla _Emails_). Para dar acceso a alguien más se agrega su correo en esa política.

## 4. Login de prueba y MFA

El MFA **no se apaga** en este ambiente: es el mismo código que producción y un interruptor para
apagarlo podría encenderse por error allá. El login automático sale del arnés E2E:

- El seed (`apps/web-b2b/e2e/env/seed.sql`) crea la red de prueba y los usuarios `@e2e.test` con
  secretos TOTP conocidos; el helper genera los códigos de 6 dígitos y guarda la sesión de cada rol en
  `e2e/.auth`, así que ninguna prueba escribe códigos a mano.
- Para pruebas manuales, el paso de MFA ofrece «Recordar este equipo por 30 días».

## 5. Proveedores (sólo sandbox)

- **Globales** (en `.env`): LATAM (`LATAM_*`, sandbox), Despegar (`DESPEGAR_*`, `api-dev`), AgentCars
  (`AGENT_CARS_*`, `api.dev`). Vacío = sin credencial global.
- **Por agencia (BYOC)**: Sabre CERT y TBO test se cargan desde el panel, en la bóveda de **esta** base
  (cifrada con `PROVIDER_CREDENTIALS_KEY` de este `.env`).
- `SABRE_OPERATIONS` enciende emisión/void/refund/etc. sólo para certificarlas en CERT.
- Nunca poner aquí credenciales o URLs de producción.
- Las ventas `@real` (F10, F12, F14, F17 y F27; ver `apps/web-b2b/e2e/README.md`) reservan y cancelan en
  Sabre CERT y dejan al consolidador y a la agencia A con carteras COP y USD de prueba y contacto de soporte.
  Estado al 2026-11-26: AgentCars rechaza la IP de la Mac hasta que la registren, el sandbox de LATAM cotiza
  en BRL y la cuenta de test de TBO sólo trae tarifas de paquete con aéreo (`docs/tbo/10` Q-31).

## 6. Diferencias con producción

|             | Producción (VPS Hostinger)   | Pruebas (Mac mini)                                |
| ----------- | ---------------------------- | ------------------------------------------------- |
| Imágenes    | ghcr.io, amd64, de CI        | construidas en la Mac, arm64                      |
| Entrada     | Caddy + Cloudflare proxied   | túnel Cloudflare + Access                         |
| Correo      | SMTP real                    | Mailpit local                                     |
| Proveedores | credenciales de la operación | sólo sandboxes                                    |
| Datos       | reales                       | red de prueba `@e2e.test` + lo que se cree a mano |
