# 13 — Validación del modelo de red: Planetour, sucursales, consolidadores y superadmin

**Versión:** 1.0
**Fecha:** 2026-09-28
**Rama:** `feat/network-model`, desde `main` 19c6e3f (lo que corre en producción)
**Propósito:** Dejar por escrito cuatro cosas: (1) la auditoría del modelo de red del 2026-09-28, resumida; (2) qué quedó arreglado en la primera tanda; (3) qué queda para la siguiente, con las decisiones abiertas; (4) el runbook para ponerlo en producción.

> El modelo firmado está en [12 §3.0](./12-modelo-consolidador-y-plan.md#30-modelo-de-red-validado-2026-09-28). Este documento es el expediente de cómo se validó y qué falta. Las decisiones D1–D7 de aquí son las de la auditoría, no las D1–D5 de junio de [12 §7](./12-modelo-consolidador-y-plan.md#7-riesgos-y-decisiones-abiertas).

---

## 1. Resumen

1. **La base estaba bien, el modelo no.** La jerarquía de 4 niveles, la herencia de credenciales (cuenta propia o la del ancestro más cercano), la cascada de márgenes y el aislamiento entre agencias hermanas funcionaban. Lo que faltaba era la estructura: Planetour figuraba como una agencia más, la red no se podía armar desde el panel, un admin podía darse roles por encima del suyo y el superadmin no existía en producción.
2. **La tanda 1 arregla la estructura.** Planetour pasa a ser la raíz `platform` y la base impone qué nodo puede colgar de cuál (D4 A). Existen las sucursales. El superadmin arma, mueve y suspende nodos desde _Gestión de Agencias_ (D6 A). Nadie puede asignar un rol igual o superior al propio, y `platform_admin` dejó de asignarse (D7 B). El superadmin no vende. `seed-superadmin` ya no rompe datos. Ver §3.
3. **La tanda 2 es la confidencialidad y el superadmin operativo.** Hoy una agencia ve el neto del proveedor (G-02) y los márgenes de sus ancestros (G-01), y administra su propia cartera. El superadmin no puede "entrar como" otro nodo (G-17), el reporte de comisiones es inventado (G-16) y nadie ve las oportunidades asignadas del CRM. Faltan tres decisiones: D2, D3 y D5. Ver §4.
4. **Nada de esto está desplegado.** El runbook de §5 lo lleva a producción en seis pasos. El último deja cargada la cuenta TBO en Planetour.

---

## 2. La auditoría del 2026-09-28, resumida

### 2.1 Cómo se hizo

- **Código:** se revisaron la base, la API y la web con evidencia `archivo:línea`, por eje (estructura, credenciales, precios, roles, operación). G-01 a G-05 pasaron una segunda revisión independiente; G-06, G-17, carteras, CRM, reportes y paquetes se reconfirmaron en el código; el resto se apoya en la evidencia del análisis por eje.
- **Datos de producción:** consultas de solo lectura en el VPS, como `postgres`, sin imprimir secretos.
- **Resultado:** ninguna brecha se refutó. Cuatro hipótesis se descartaron: que con Planetour como `agency` el superadmin no funcionara, que pasarlo a `platform` le impidiera vender, que la herencia de credenciales fallara y que las agencias hermanas se vieran entre sí. G-01 bajó de crítica a alta.

### 2.2 Estado de producción el día de la auditoría

| Qué              | Estado                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nodos            | Dos raíces de tipo `agency`: `platform` ("Planetour S.A.S") y `amazon-minimalist`. La migración 0011 dejó como `agency` a todo nodo que ya existía y nada lo cambió después.                                              |
| Memberships      | `platform` → `consolidator_admin` (el founder). `amazon-minimalist` → `tenant_admin`.                                                                                                                                     |
| Superadmin       | No hay.                                                                                                                                                                                                                   |
| Credenciales     | Una sola cuenta en la bóveda: Sabre de `platform`, de certificación. LATAM y AgentCars salen de variables del servidor.                                                                                                   |
| Precios y dinero | Sin reglas de margen y con las carteras en cero, así que las fugas de G-01 y G-02 todavía no exponían nada.                                                                                                               |
| Efectos          | TBO no se le ofrecía ni le funcionaba a Planetour (su factory sólo acepta cuentas de un nodo `platform` o `consolidator`). Amazon no heredaba nada de Planetour. Los hijos que creaba Planetour nacían como sub-agencias. |

### 2.3 Matriz actor × capacidad, antes y después de la tanda 1

| Actor / capacidad                                   | Antes   | Después de la tanda 1    | Qué falta                                                                              |
| --------------------------------------------------- | ------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Planetour vende a nombre propio                     | parcial | ✓ por sus sucursales     | TBO, cuando se cargue la cuenta (§5 paso 6).                                           |
| Planetour provee a su red                           | parcial | ✓                        | G-02: sus agencias ven el neto del proveedor.                                          |
| Consolidador con credenciales propias               | parcial | ✓ se crea desde el panel | D2: Planetour le suma su margen aunque venda con su propio contrato.                   |
| Agencia bajo Planetour o bajo un consolidador       | parcial | parcial                  | G-02 y G-01: ve el neto y los márgenes de sus ancestros. Carteras: administra la suya. |
| Aislamiento entre agencias                          | ✓       | ✓                        | —                                                                                      |
| Superadmin ve la red                                | parcial | parcial                  | G-17: no ve reservas, clientes, carteras ni reportes de otros nodos.                   |
| Superadmin ajusta la configuración de un nodo       | ✓       | ✓                        | —                                                                                      |
| Superadmin corrige la estructura                    | ✗       | ✓                        | Cambiar el tipo de un nodo sólo por API (`PATCH /admin/tenants/:id`), no desde la web. |
| Superadmin corrige la operación (carteras, cuentas) | ✗       | ✗                        | Carteras ajenas, desactivar una credencial sin volver a escribir su secreto.           |

### 2.4 Brechas y su estado

**Críticas**

| ID       | Brecha                                                                                                         | Estado  |
| -------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| G-02     | El neto del proveedor llega a la agencia (búsqueda, revalidación, PreBook y órdenes) y la tarjeta dice "neto". | Tanda 2 |
| Carteras | Cualquier admin registra depósitos, retiros y su propio cupo de crédito, sin aprobación del ancestro.          | Tanda 2 |

**Altas**

| ID   | Brecha                                                                                                     | Estado                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| G-03 | Planetour no es de tipo `platform`.                                                                        | Arreglada (0049)                                                   |
| G-04 | `seed-superadmin` roto: crea una `agency`, falla contra 0025 y renombraría "Planetour S.A.S".              | Arreglada                                                          |
| G-05 | Cualquier admin crea por API hijos `consolidator` o `platform`.                                            | Arreglada (API y trigger de 0050)                                  |
| G-06 | Un admin se da roles por encima del suyo.                                                                  | Arreglada                                                          |
| G-07 | _Gestión de Agencias_ crea agencias raíz sueltas.                                                          | Arreglada                                                          |
| G-08 | No hay pantalla para crear un consolidador.                                                                | Arreglada                                                          |
| G-09 | El superadmin no puede mover, cambiar de tipo ni suspender un nodo.                                        | Arreglada (0051 y endpoints); el cambio de tipo, sólo por API      |
| G-01 | El simulador de reglas (`POST /pricing/waterfall`) muestra los márgenes de los ancestros.                  | Tanda 2                                                            |
| G-17 | "Entrar como" otro nodo da 403, incluso al superadmin.                                                     | Tanda 2 (alcance según D5)                                         |
| G-16 | El reporte de comisiones tiene cifras fijas en el código y se exporta como real.                           | Tanda 2                                                            |
| CRM  | Las oportunidades asignadas no las ve nadie y asignar una falla (el servicio no informa el usuario a RLS). | Tanda 2                                                            |
| G-10 | La post-venta de vuelos usa la credencial vigente, no la de la venta.                                      | Después                                                            |
| G-15 | Las reglas de monto fijo no tienen moneda.                                                                 | Después                                                            |
| G-13 | No hay margen de venta directa distinto del de la red.                                                     | Después (con las sucursales, sólo lo necesitan los consolidadores) |
| G-14 | No hay override por agencia hija; el hijo puede borrar una regla puesta sobre él.                          | Después                                                            |

**Medias**

| Brecha                                                                                                       | Estado                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Crear una agencia con los datos del admin vacíos da 400.                                                     | Arreglada                            |
| Pasarse de 4 niveles da un 500 genérico.                                                                     | Arreglada (409 `TENANT_DEPTH_LIMIT`) |
| _Mi Red_ toma como raíz el primer nodo por orden alfabético.                                                 | Arreglada                            |
| _Gestión de Agencias_ es una lista plana, sin tipo ni padre.                                                 | Arreglada                            |
| Con 2 o más credenciales activas del mismo proveedor en un nodo, se usa una al azar.                         | Pendiente                            |
| El superadmin no puede desactivar ni borrar una credencial sin volver a escribir el secreto.                 | Pendiente                            |
| _Mi Red_ dice "sin credenciales" cuando el nodo usa las del servidor; el diagnóstico no informa ese origen.  | Pendiente                            |
| No hay vista global nodo × proveedor de credenciales.                                                        | Pendiente                            |
| La regla "TBO sólo para `platform` o `consolidator`" no se valida al guardar la cuenta por API.              | Pendiente                            |
| Paquetes calcula el margen sobre un neto que manda el navegador y sin el piso de precio de TBO.              | Pendiente                            |
| Pricing sin Zod, ignora `conditions`, sin comisión del vendedor, reglas sin editar ni pausar.                | Pendiente                            |
| Conciliación: el dueño de la credencial no ve las diferencias de las reservas de su red.                     | Pendiente                            |
| Los eventos de plataforma (sin tenant) no aparecen en la auditoría.                                          | Pendiente                            |
| La herencia depende de que las funciones sean de `postgres`.                                                 | Pendiente de verificar en el VPS     |
| El deploy acepta claves como variables en texto plano, y el sync de TBO usa un tercer juego de credenciales. | Pendiente                            |

---

## 3. Qué quedó arreglado en la tanda 1

Cinco commits en `feat/network-model`, más este documento. Cada uno trae sus tests; los de la base, la API y el seed corren también contra Postgres.

| Commit    | Qué                                                                                                                                                                                                                                                                                                                                                                                                                                         | Cierra                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `14b57a6` | **Base.** [0049](../../db/migrations/0049_platform_root.sql) promueve a `platform` la raíz con slug `platform` y lo audita. [0050](../../db/migrations/0050_tenant_hierarchy_rules.sql): una sola plataforma y sin padre, columna `is_branch` y trigger con la matriz D4 A. [0051](../../db/migrations/0051_move_tenant_subtree.sql): `move_tenant_subtree` (D6 A).                                                                         | G-03, G-05 (base), G-09 (base)                |
| `d56f3d0` | **API de nodos.** `POST /admin/tenants` deriva el tipo del padre, con Planetour como padre por defecto. `PATCH /admin/tenants/:id` cambia estado, sucursal y tipo. `POST /admin/tenants/:id/move` mueve un nodo. El rango se mide sobre el nodo destino y nadie da un rol igual o superior al propio. `platform_admin` no se asigna. Suspender un nodo corta el rol en su red.                                                              | G-05, G-06, G-07, G-09, D7 B, el 400 del alta |
| `32e0365` | **El superadmin no vende.** Las rutas marcadas con `@SalesOperation()` responden 403 `PLATFORM_ROLE_CANNOT_SELL` a los roles de plataforma, en cualquier nodo: búsquedas, PreBook, Book, crear órdenes, pagar/emitir, servicios, reshop, cotizaciones, paquetes, y el hold y la aprobación de reservas con cartera. Consultar y cancelar lo vendido sigue permitido. Un test recorre todas las rutas y falla si una venta queda sin marcar. | "El superadmin no puede vender"               |
| `a365fc6` | **[`seed-superadmin`](../../tools/seed-superadmin/README.md).** Promueve `platform` sin renombrarlo, pasa a `superadmin` la membership del correo indicado, no toca contraseñas de cuentas existentes y se niega ante cualquier estado dudoso. Idempotente y auditado.                                                                                                                                                                      | G-04                                          |
| `e822a60` | **Panel.** _Gestión de Agencias_ muestra el árbol con tipo, padre y estado, avisa de las raíces sueltas y permite crear, mover, suspender y marcar sucursales. _Mi Red_ toma como raíz la plataforma. El menú del superadmin no tiene venta. _Proveedores (GDS)_ y _Equipo_ abren en la raíz de la red.                                                                                                                                     | G-07, G-08, G-09 (web), medias de _Mi Red_    |

### 3.1 Reglas que quedan en la base

**Qué nodo cuelga de cuál (D4 A, [0050](../../db/migrations/0050_tenant_hierarchy_rules.sql)):**

| Padre          | Hijos permitidos                                    |
| -------------- | --------------------------------------------------- |
| (raíz)         | sólo `platform`, y una sola: Planetour              |
| `platform`     | `consolidator`, `agency` (las sucursales incluidas) |
| `consolidator` | `agency`                                            |
| `agency`       | `subagency`                                         |
| `subagency`    | nada: la red tiene como máximo 4 niveles            |

Una sucursal es una `agency` con `is_branch = true` y cuelga directamente de la plataforma. Lo que ya existía y no cumple la matriz (Amazon Minimalist) no se toca: 0050 lo avisa con un `WARNING` y se corrige moviéndolo.

**Mover un nodo (D6 A, [0051](../../db/migrations/0051_move_tenant_subtree.sql)):**

- Lo mueve sólo el superadmin, con todo su subárbol, y queda un evento `tenant.moved` con el actor.
- Lo histórico queda como está: las órdenes y los movimientos de cartera no se reescriben. Desde el cambio rigen las credenciales, las reglas y la marca del nuevo padre, porque se heredan leyendo el `path`.
- Se rechazan los ciclos, más de 4 niveles y lo que prohíbe la matriz.
- Se bloquea si el nodo o su subárbol tiene reservas **abiertas pagadas con cartera** (tienen su `BOOKING_HOLD` y no su `BOOKING_RELEASED`). También se bloquea si tiene reservas abiertas hechas con una cuenta de un ancestro que deja de serlo, porque su post-venta ya no encontraría la cuenta.
- **Abierta** es `pending`, o `confirmed`/`ticketed` hasta el día siguiente al fin del viaje: check-out del hotel, devolución del auto, o vuelta (si no hay, ida) del vuelo. Sin ninguna fecha legible, cuenta como abierta.

**Errores:** la base usa códigos propios y la API los traduce con motivo. STH01 (regla de la jerarquía) da 409 con el motivo en mayúsculas, por ejemplo `TENANT_ROOT_MUST_BE_PLATFORM` o `TENANT_DEPTH_LIMIT`; si el nodo o su padre no existen, 404 (`TENANT_NOT_FOUND`, `TENANT_PARENT_NOT_FOUND`). STH02 (movimiento bloqueado) da 409 `TENANT_MOVE_OPEN_WALLET_BOOKINGS` o `TENANT_MOVE_OPEN_INHERITED_BOOKINGS`. Un movimiento que la base no permite al usuario da 403 `TENANT_MOVE_FORBIDDEN`.

---

## 4. Qué queda para la tanda 2

### 4.1 Confidencialidad

Va antes de que una agencia externa venda con márgenes de Planetour o con un proveedor que consuma su crédito.

1. **G-02, el neto del proveedor.**
   - El total de la oferta pasa a ser el costo del nodo que la pide, y el desglose del proveedor no sale.
   - La oferta original se guarda en el servidor; revalidación y orden la leen de ahí, no del navegador.
   - "Neto" pasa a decir "costo".
   - Aplica a vuelos, hoteles, autos y el detalle de órdenes.
2. **G-01, el simulador de reglas.** Sólo para admins. Cada uno ve los pasos de su nodo hacia abajo; el superadmin ve todo.
3. **Carteras.** Depósito, retiro y cupo de crédito los ejecuta sólo el admin del ancestro que financia, o el superadmin, sobre el nodo destino. La agencia registra un depósito "pendiente" que el ancestro aprueba. Test: el admin de una agencia recibe 403 al tocar su cupo.

### 4.2 Superadmin operativo

1. **G-17, "entrar como".** El rol en un nodo hijo sale de la membership en el ancestro, cada acción queda auditada como "actuando como", y la web suma un selector de nodo. Actuar como una sucursal no le devuelve la venta al superadmin. Alcance según D5.
2. **G-16, reporte de comisiones.** Ya: rotularlo como ejemplo o quitarlo. Después: tabla `order_pricing_steps` con el margen de cada nivel por venta, y un reporte real por nodo y por red. Las reglas se versionan, no se borran.
3. **CRM.** `crm-opportunities.service.ts` y `crm-interactions.service.ts` pasan a `withRequestContext({ userId, tenantId })`, como `crm-tasks.service.ts`, con tests.

### 4.3 Decisiones que faltan

**D2. ¿Planetour cobra margen cuando un consolidador vende con su propio contrato? (G-12)**

- A. No: la cascada empieza en el dueño de la credencial.
- B. No sobre la tarifa, pero sí un fee de plataforma aparte y configurable, que arranca en 0.
- C. Como hoy: suma su margen en toda venta de su red.
- **Recomendación: B.** Hoy equivale a A y deja cobrar por el uso de la plataforma más adelante sin tocar código.

**D3. ¿Dónde viven las credenciales de Planetour? (G-11)**

- A. Todas en la bóveda, como cuentas del nodo Planetour: LATAM, Despegar y AgentCars, además de Sabre y TBO. Se apaga el respaldo de variables del servidor.
- B. Se mantienen las variables del servidor, pero sólo para nodos bajo Planetour, y en pantalla figuran como "credencial de plataforma".
- **Recomendación: A**, después de G-10. Tiene que ser la misma identidad LATAM para no romper la post-venta de lo ya vendido.

**D5. ¿Quién puede "entrar como" otro nodo? (G-17)**

- A. Sólo el superadmin, con registro en auditoría. El consolidador ve sólo resúmenes de su red.
- B. A, y además el consolidador ve en sólo lectura las reservas y carteras de su red.
- C. El consolidador también puede operar como sus agencias.
- **Recomendación: A ahora, y B** cuando exista el primer consolidador real.

### 4.4 Después de la tanda 2

- G-10 (post-venta de vuelos con la credencial de la venta), G-15 (moneda de las reglas fijas), G-13 (alcance de las reglas para consolidadores) y G-14 (override por agencia hija).
- Las medias pendientes de §2.4.
- **Alta pública.** Con `ALLOW_PUBLIC_SIGNUP=true`, `POST /auth/register` crea una agencia raíz y ahora la base la rechaza con 409. Está apagada por defecto. Hay que colgarla de la plataforma o quitarla.
- **Cambio de tipo desde la web.** La API lo permite (`PATCH /admin/tenants/:id` con `tenantType`, dentro de D4); el panel todavía no.
- **Cachés tras un movimiento.** La habilitación de proveedores se cachea 10 s por réplica: justo después de mover un nodo puede verse la herencia anterior durante ese lapso.

---

## 5. Runbook del VPS

Orden obligatorio. Cada paso dice cómo comprobar que salió bien. Los comandos se corren como `deploy` en el VPS, desde `/opt/sales-travel`, y ninguno imprime secretos.

**Antes de empezar:**

- El PR de `feat/network-model` tiene el CI en verde, incluidos los tests de integración contra Postgres real.
- Hay un backup reciente de la base ([`infrastructure/hostinger/README.md`](../../infrastructure/hostinger/README.md) §6, "Backup de Postgres").
- Entre el paso 2 y el paso 5 **Planetour no tiene quién venda**: la cuenta del founder pasa a superadmin y el superadmin no vende. Conviene hacer los pasos 2 a 5 seguidos.
- Desde este deploy el login pide enrolar MFA a todo usuario con un rol que lo exige (`tenant_admin` o superior) y que no lo tenga, en cualquiera de sus nodos. Antes no lo pedía nunca: la API corre como `app_user` y el login leía las memberships sin el contexto del usuario, así que la RLS no le dejaba ver ninguna. Avísale al admin de Amazon Minimalist que al entrar lo mandarán a _Configuración → Seguridad_ a enrolarse.

### Paso 1 — Deploy

1. El founder mergea el PR a `main`. El workflow **Deploy** construye las imágenes, aplica las migraciones 0049 a 0051 y hace el smoke test.
2. Comprueba que Planetour quedó como plataforma y que Amazon aparece como raíz suelta:

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT c.slug, c.tenant_type, c.is_branch, p.slug AS padre, tenant_hierarchy_rule(c.tenant_type, c.is_branch, p.tenant_type) AS regla FROM tenants c LEFT JOIN tenants p ON p.id = c.parent_tenant_id ORDER BY c.path"
   ```

   Esperado: `platform` con tipo `platform` y `regla` vacía; `amazon-minimalist` con tipo `agency`, sin padre y `regla = tenant_root_must_be_platform`. Es el mismo aviso que 0050 deja como `WARNING` en el log de `postgres` (`docker compose logs postgres | grep 'REVISAR (D4)'`); el contenedor `migrate` no lo imprime.

3. La promoción quedó auditada: un evento `tenant.type.changed` con `from = agency`, `to = platform` y `source = migration:0049_platform_root`.

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT occurred_at, event_type, payload FROM domain_events WHERE payload->>'source' = 'migration:0049_platform_root'"
   ```

Si el deploy falla en 0049 o 0050, el mensaje dice qué revisar (por ejemplo, otra plataforma o una plataforma con padre) y la migración se deshace entera.

### Paso 2 — `seed-superadmin` con tu correo

Pasa a `superadmin` la membership que tu cuenta tiene en Planetour (hoy `consolidator_admin`). No toca tu contraseña ni el nombre de Planetour. El comando completo, la salida esperada y cómo revertirlo están en [`infrastructure/hostinger/README.md` §7.1](../../infrastructure/hostinger/README.md#71-en-producción-con-tu-cuenta-actual). En resumen:

```bash
cd /opt/sales-travel
TAG=$(sed -n 's/^IMAGE_TAG=//p' .env)
export PGPASSWORD="$(grep -m1 '^POSTGRES_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
docker run --rm --network sales-travel_internal \
  -e PGHOST=postgres -e PGPORT=5432 -e PGUSER=postgres -e PGPASSWORD -e PGDATABASE=sales_travel \
  -e SUPERADMIN_TENANT_SLUG=platform \
  -e SUPERADMIN_EMAIL='<el correo con el que entras hoy>' \
  "ghcr.io/nipko/sales-travel-seed-superadmin:${TAG}"
unset PGPASSWORD
```

Esperado: `"ok": true`, `"tenant": "unchanged"` (0049 ya lo promovió), `"membership": "updated"` y `"previousRole": "consolidator_admin"`. Si `previousRole` es otro, el correo era de otra cuenta: detente y revierte como dice §7.1.

### Paso 3 — Volver a entrar

1. Cierra sesión en `https://app.planetour.cloud` y vuelve a entrar. La API ya lee el rol nuevo de la base en cada pedido, pero así el token queda emitido con `superadmin` y el login comprueba el MFA.
2. Si tu cuenta no tiene MFA, el login te pide activarlo: es obligatorio para el superadmin.
3. Comprueba:
   - el menú tiene _Gestión de Agencias_ y _Proveedores de la plataforma_;
   - no tiene _Buscar / Cotizar_, _Hoteles_, _Autos_ ni _Oficinas_;
   - _Gestión de Agencias_ muestra a Planetour como "Raíz de la red" y el aviso "Un nodo fuera de la red de Planetour S.A.S" con Amazon Minimalist.

### Paso 4 — Mover Amazon Minimalist bajo Planetour

1. En _Gestión de Agencias_, en el aviso de nodos fuera de la red, pulsa **Mover bajo Planetour S.A.S**: el diálogo abre con Planetour elegido. También se puede desde el menú de acciones de la fila de Amazon (el botón "⋯") → **Mover…**, eligiendo Planetour S.A.S.
2. El diálogo explica el efecto (D6 A): lo vendido queda como está y desde ahora rigen las credenciales, reglas y marca de Planetour. Pulsa **Mover**.
3. Comprueba:

   - la fila de Amazon dice "Cuelga de Planetour S.A.S" y el aviso desaparece;
   - la consulta del paso 1 ya no devuelve `regla` para `amazon-minimalist`;
   - hay un evento `tenant.moved` con tu usuario como actor:

     ```bash
     docker compose exec -T postgres psql -U postgres -d sales_travel -c \
       "SELECT e.occurred_at, u.email AS actor, e.payload FROM domain_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.event_type = 'tenant.moved' ORDER BY e.occurred_at DESC LIMIT 1"
     ```

Si el panel dice que el movimiento está bloqueado por reservas abiertas pagadas con cartera (`TENANT_MOVE_OPEN_WALLET_BOOKINGS`), espera a que cierren (el día siguiente al fin de cada viaje) y repite. Con las carteras en cero no debería pasar. No hay vuelta atrás a raíz: D4 A sólo admite a la plataforma como raíz, así que después Amazon sólo puede moverse bajo otro padre válido.

Lo que Amazon gana y lo que todavía no conviene darle:

- Hereda de Planetour sus cuentas heredables (hoy sólo puede ser la de Sabre de certificación, si está marcada heredable), sus reglas, su marca y sus ajustes de habilitación de proveedores. LATAM y AgentCars le siguen llegando, como hasta ahora, de las variables del servidor.
- Hasta la tanda 2, ve el neto del proveedor y administra su propia cartera. No cargues en Planetour reglas de margen que quieras ocultarle, y no le habilites TBO (paso 6).

### Paso 5 — Crear una sucursal y su vendedor

1. En _Gestión de Agencias_, pulsa **Nuevo nodo** y elige **Sucursal**. _Cuelga de_ ya viene con Planetour.
2. Completa nombre (por ejemplo "Planetour Bogotá Norte"), slug, país, moneda e idioma.
3. El **admin inicial** es opcional. Si lo pones, entra como `tenant_admin` de la sucursal: con contraseña se crea la cuenta; sin contraseña, o si el correo ya tiene cuenta, se le envía una invitación.
4. Pulsa **Crear sucursal**. La fila nueva lleva el badge "Sucursal" y dice "Cuelga de Planetour S.A.S".
5. Para el vendedor, ve a _Equipo (Usuarios)_, elige la sucursal en _Agencia_, pulsa **Invitar usuario**, pon su correo con rol **Vendedor** y envía. El vendedor acepta desde el correo y elige su contraseña.
6. Comprueba con la cuenta del vendedor que _Buscar / Cotizar_ funciona. Con tu cuenta de superadmin, esa pantalla (`/cotizaciones`) muestra el aviso de que el superadministrador no vende, y la API responde 403 `PLATFORM_ROLE_CANNOT_SELL`.

El vendedor tiene que ser **otra cuenta, con otro correo**. El superadmin no vende tampoco desde una sucursal donde además sea miembro: la regla mira a la persona, no al nodo.

### Paso 6 — Cargar la cuenta TBO en Planetour

Ahora Planetour es `platform` y puede ser dueño de una cuenta TBO. Sus sucursales la heredan (D-TBO-03 A: sin respaldo de variables del servidor).

1. Ve a _Proveedores (GDS)_. Abre en Planetour, la raíz de la red. Agrega **TBO Holidays** con usuario de API, contraseña, entorno y URL base, y déjala **heredable**.
2. Elige el estado (una cuenta TBO nueva arranca en Sandbox):
   - **Sandbox:** la cuenta queda guardada y cifrada, pero no resuelve ni habilita nada. Sirve mientras no haya credenciales de producción.
   - **Activo:** la cuenta resuelve para Planetour y su red. En producción, úsalo sólo con las credenciales _live_ que TBO entrega después de certificar ([docs/tbo/07 §2.8](../tbo/07-certificacion.md#28-fase-5--production-process-form-y-credenciales-live)), con el entorno **Producción**.
3. TBO es `opt-in`: una cuenta activa no alcanza, y nadie lo ve hasta que lo habilitas.
   - En _Proveedores de la plataforma_ → TBO Holidays, agrega una excepción **Habilitado** para cada sucursal, con motivo.
   - **No** lo habilites con _Todos los tenants_ ni en el nodo Planetour: se heredaría a toda la red, Amazon incluida. TBO reserva con `PaymentMode: Limit`, contra el crédito o saldo del titular de la cuenta (Planetour), y hasta la tanda 2 una agencia externa administra su propia cartera.
4. La búsqueda de TBO usa el catálogo local. Sin el sync, la sucursal no encuentra hoteles aunque TBO esté habilitado. El sync usa su propia cuenta de catálogo: los secrets y variables `TBO_SYNC_*` de GitHub Actions, que el workflow **Deploy** escribe en el `.env` del VPS (no se editan a mano en el VPS: el siguiente deploy los pisa). Ver [`tools/sync-tbo-hotel-inventory`](../../tools/sync-tbo-hotel-inventory/README.md).
5. Comprueba, con la cuenta en **Activo** y el catálogo sincronizado:
   - en _Proveedores (GDS)_ de la sucursal, TBO figura como heredado de Planetour;
   - con el vendedor de la sucursal, _Hoteles_ devuelve resultados de TBO;
   - con un usuario de Amazon, TBO no aparece.
