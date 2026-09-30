# 13 — Validación del modelo de red: Planetour, sucursales, consolidadores y superadmin

**Versión:** 1.2
**Fecha:** 2026-09-28 · **Actualizado:** 2026-09-29 (carteras por moneda: [§4.1](#41-confidencialidad) punto 3 y [§5](#5-runbook-del-vps) pasos 7 a 9; rediseño de hoteles: §5 pasos 10 a 13)
**Ramas:** tanda 1 en `feat/network-model`, desde `main` 19c6e3f, mergeada con #6 (`fb25713`). Carteras por moneda en `feat/wallets-per-currency`, desde `main` 5de126d. Rediseño de hoteles en `feat/hotels-redesign`, encima de las carteras.
**Propósito:** Dejar por escrito cuatro cosas: (1) la auditoría del modelo de red del 2026-09-28, resumida; (2) qué quedó arreglado en la primera tanda; (3) qué queda para la siguiente, con las decisiones abiertas; (4) el runbook para ponerlo en producción.

> El modelo firmado está en [12 §3.0](./12-modelo-consolidador-y-plan.md#30-modelo-de-red-validado-2026-09-28). Este documento es el expediente de cómo se validó y qué falta. Las decisiones D1–D7 de aquí son las de la auditoría, no las D1–D5 de junio de [12 §7](./12-modelo-consolidador-y-plan.md#7-riesgos-y-decisiones-abiertas).

---

## 1. Resumen

1. **La base estaba bien, el modelo no.** La jerarquía de 4 niveles, la herencia de credenciales (cuenta propia o la del ancestro más cercano), la cascada de márgenes y el aislamiento entre agencias hermanas funcionaban. Lo que faltaba era la estructura: Planetour figuraba como una agencia más, la red no se podía armar desde el panel, un admin podía darse roles por encima del suyo y el superadmin no existía en producción.
2. **La tanda 1 arregla la estructura.** Planetour pasa a ser la raíz `platform` y la base impone qué nodo puede colgar de cuál (D4 A). Existen las sucursales. El superadmin arma, mueve y suspende nodos desde _Gestión de Agencias_ (D6 A). Nadie puede asignar un rol igual o superior al propio, y `platform_admin` dejó de asignarse (D7 B). El superadmin no vende. `seed-superadmin` ya no rompe datos. Ver §3.
3. **La tanda 2 es la confidencialidad y el superadmin operativo.** Hoy una agencia ve el neto del proveedor (G-02) y los márgenes de sus ancestros (G-01). El superadmin no puede "entrar como" otro nodo (G-17), el reporte de comisiones es inventado (G-16) y nadie ve las oportunidades asignadas del CRM. Faltan tres decisiones: D2, D3 y D5. Ver §4.
4. **Las carteras ya están resueltas (2026-09-29).** Eran la otra brecha crítica. El founder eligió la opción A: la cartera de cada agencia la establece quien la financia, con una cartera por moneda y su cupo. La agencia sólo ve sus carteras e informa depósitos, y una reserva se retiene en la cartera de la moneda de la tarifa. Ver §4.1 punto 3.
5. **Despliegue.** La tanda 1 salió a producción con el merge de #6 (`fb25713`); sus pasos son los 1 a 6 del runbook de §5, y el último deja cargada la cuenta TBO en Planetour. Las carteras siguen sin desplegar en `feat/wallets-per-currency`. Los pasos 7 a 9 las llevan a producción, le dan a una sucursal una cartera en USD con cupo y prueban una reserva de TBO en test. El rediseño de hoteles (`feat/hotels-redesign`: fotos, cobertura global de ciudades y tarifas no reembolsables) va encima: los pasos 10 a 13 lo despliegan, precargan las ciudades de todos los países y verifican las fotos y el permiso de no reembolsables.

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
| Agencia bajo Planetour o bajo un consolidador       | parcial | parcial                  | G-02 y G-01: ve el neto y los márgenes de sus ancestros. Carteras: resuelto (§4.1).    |
| Aislamiento entre agencias                          | ✓       | ✓                        | —                                                                                      |
| Superadmin ve la red                                | parcial | parcial                  | G-17: no ve reservas, clientes ni reportes de otros nodos. Las carteras, sí (§4.1).    |
| Superadmin ajusta la configuración de un nodo       | ✓       | ✓                        | —                                                                                      |
| Superadmin corrige la estructura                    | ✗       | ✓                        | Cambiar el tipo de un nodo sólo por API (`PATCH /admin/tenants/:id`), no desde la web. |
| Superadmin corrige la operación (carteras, cuentas) | ✗       | ✗                        | Desactivar una credencial sin volver a escribir su secreto. Carteras: resuelto (§4.1). |

### 2.4 Brechas y su estado

**Críticas**

| ID       | Brecha                                                                                                         | Estado                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| G-02     | El neto del proveedor llega a la agencia (búsqueda, revalidación, PreBook y órdenes) y la tarjeta dice "neto". | Tanda 2                                                                           |
| Carteras | Cualquier admin registra depósitos, retiros y su propio cupo de crédito, sin aprobación del ancestro.          | Resuelta en `feat/wallets-per-currency` (0052, 0053), sin desplegar. §4.1 punto 3 |

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

### 4.0 Estado al 2026-09-29

| Tema                                     | Estado                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Carteras (crítica)                       | ✅ Resuelta en `feat/wallets-per-currency`, sin desplegar: §4.1 punto 3 y §5 pasos 7 a 9. |
| G-02, el neto del proveedor (crítica)    | Pendiente, y es lo que sigue: §4.1 punto 1.                                               |
| G-01, el simulador de reglas             | Pendiente: §4.1 punto 2.                                                                  |
| G-17, "entrar como"                      | Pendiente, con el alcance que fije D5: §4.2 punto 1.                                      |
| G-16, el reporte de comisiones           | Pendiente: §4.2 punto 2.                                                                  |
| CRM, oportunidades asignadas             | Pendiente: §4.2 punto 3.                                                                  |
| Decisiones D2, D3 y D5                   | Abiertas: §4.3.                                                                           |
| Lo que las carteras dejaron para después | Conciliación del saldo, recarga real y limpieza de datos viejos: §4.4.                    |
| Rediseño de hoteles                      | En `feat/hotels-redesign`, sin desplegar: §5 pasos 10 a 13.                               |

### 4.1 Confidencialidad

Va antes de que una agencia externa venda con márgenes de Planetour o con un proveedor que consuma su crédito.

1. **G-02, el neto del proveedor.**
   - El total de la oferta pasa a ser el costo del nodo que la pide, y el desglose del proveedor no sale.
   - La oferta original se guarda en el servidor; revalidación y orden la leen de ahí, no del navegador.
   - "Neto" pasa a decir "costo".
   - Aplica a vuelos, hoteles, autos y el detalle de órdenes.
2. **G-01, el simulador de reglas.** Sólo para admins. Cada uno ve los pasos de su nodo hacia abajo; el superadmin ve todo.
3. **Carteras. Resuelta el 2026-09-29** con la opción A del founder: la cartera de cada agencia la establece **quien la financia**. Son cuatro commits en `feat/wallets-per-currency`: `6ad61d7` (base), `ce9181e` (API), `16dc410` (retención) y `43d9d34` (web). Todavía no está desplegada (§5 pasos 7 a 9).
   - **Quién financia a quién.** Es el ancestro más cercano de tipo plataforma, consolidador o agencia (`tenant_financier_id`, [0052](../../db/migrations/0052_wallets_per_currency.sql)). A las agencias, sucursales y consolidadores que cuelgan de Planetour los financia Planetour, y eso lo opera su superadmin. A las agencias de un consolidador las financia el consolidador (sus `consolidator_admin`, `tenant_admin`, `agency_admin` o `admin`), y a las sub-agencias, su agencia. El superadmin puede con cualquier nodo, la raíz incluida, y es el único que gestiona la de Planetour. Fuera de ese caso nadie gestiona la cartera de su propio nodo, y un ancestro que está por encima del que financia tampoco: el consolidador no toca la de una sub-agencia de su agencia (`can_finance_tenant`).
   - **Una cartera por moneda.** `agency_portfolios` pasa a ser única por tenant y moneda. Las filas que había quedan como la cartera de su moneda, y la moneda y el nodo de una cartera ya no cambian. Sólo se habilitan monedas ISO 4217 con dos decimales, porque `Money` asume centavos.
   - **Qué hace quien financia.** Habilita monedas con su cupo inicial, fija el cupo, suspende o reactiva una cartera, y registra depósitos y ajustes con signo. Cada cambio pide motivo (Zod) y deja su `domain_event` en la misma transacción: `portfolio.created`, `portfolio.credit_limit.changed`, `portfolio.status.changed`, `portfolio.deposit.recorded` y `portfolio.adjustment.recorded`. Los depósitos y los ajustes llevan `Idempotency-Key`. En la web, el superadmin lo hace desde _Gestión de Agencias_ → nodo → _Carteras_ y el consolidador o la agencia, desde _Mi Red_ → agencia → _Carteras_. El API es `/tenants/:tenantId/portfolios`.
   - **Qué hace la agencia.** En _Cartera B2B_ ve sus carteras por moneda, sus movimientos y sus informes. Un admin de la agencia puede **informar un depósito**, que queda pendiente y no suma saldo hasta que quien la financia lo aprueba (se acredita un `DEPOSIT_PAYMENT` en la misma transacción) o lo rechaza con motivo. Esos pasos los audita la base (`portfolio.deposit_report.submitted`, `approved` y `rejected`). `POST /portfolios/deposit`, `POST /portfolios/withdraw` y `PATCH /portfolios/credit-limit` responden 403 `PORTFOLIO_FINANCIER_REQUIRED` con el motivo.
   - **La base lo impone.** Si quien escribe no es quien financia al nodo, el cupo, el estado, los depósitos y los ajustes los rechaza un trigger. No frena a un rol que se salta la RLS, como las migraciones, los seeds y el `psql` del operador. Sale un 42501 con la regla `portfolio_financier_required` (o `portfolio_entry_author` y `deposit_report_resolver`, si se firma a nombre de otro usuario), que la API devuelve como 403. Las demás reglas (moneda inmutable, un informe se resuelve una sola vez) salen como STW01 y la API las devuelve como 409 con motivo. Además, el libro de movimientos es de sólo agregar para `app_user`, y la aplicación no borra carteras. Los tests corren como `app_user` (`wallets-rls`, `wallet-financing` y `holds-per-currency`), incluido el que pedía la auditoría: el admin de una agencia no puede tocar su cupo.
   - **La retención.** Cualquier reserva que retiene cartera (el hotel antes del Book, y un vuelo o un auto confirmados por `POST /portfolios/hold-booking`) lo hace en la cartera de la agencia en la moneda de la tarifa. El tope es el saldo más el cupo, y no se convierte. Sin cartera en esa moneda, 409 `PORTFOLIO_CURRENCY_NOT_ENABLED` ("La agencia no tiene cartera en USD: pedile a quien te financia que la habilite"), sin abrir una cartera implícita. Con la cartera suspendida sale `PORTFOLIO_INACTIVE`, y sin saldo ni cupo, `PORTFOLIO_FUNDS_INSUFFICIENT`. En hoteles los tres rechazos llegan antes de llamar al proveedor, y el PreBook y la búsqueda avisan antes de cargar huéspedes. La API ya no crea una cartera COP con cupo 0 la primera vez que alguien la mira.
   - **El crédito interno de 0007.** [0053](../../db/migrations/0053_tenant_credit_limit_to_wallets.sql) pasa `tenants.credit_limit` al cupo de la cartera en la moneda por defecto del nodo, y la API deja de leerlo. Queda un solo tope por cartera, que fija quien financia.
   - Lo que quedó para después está en §4.4.

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
- Las carteras ya no dependen de D5: el consolidador ve y gestiona las de sus agencias porque es quien las financia (§4.1 punto 3). D5 decide el resto: reservas, clientes y reportes.

### 4.4 Después de la tanda 2

- G-10 (post-venta de vuelos con la credencial de la venta), G-15 (moneda de las reglas fijas), G-13 (alcance de las reglas para consolidadores) y G-14 (override por agencia hija).
- Las medias pendientes de §2.4.
- **Lo que las carteras dejaron para después:**
  - **Conciliación del saldo contra el libro.** `balance_minor` no está atado a la suma de `portfolio_transactions`. Hoy sólo lo mueven las retenciones y liberaciones de la API, pero la base no frena un `UPDATE` directo del saldo como `app_user`. Cerrarlo pide el invariante "saldo = suma del libro", que los datos y los tests de hoy no cumplen. Es el P0 de [12 §4.3](./12-modelo-consolidador-y-plan.md#43-pagos-y-fondos).
  - **Recarga real y extractos.** Un depósito lo verifica a mano quien financia, contra su banco, y no hay pasarela ni estado de cuenta descargable.
  - **Dos aprobaciones a la vez.** El servicio bloquea el informe antes de acreditar, así que la segunda aprobación encuentra el informe resuelto y responde 409 `DEPOSIT_REPORT_NOT_PENDING`. Falta un test con dos sesiones contra el Postgres del CI; el doble local (PGlite) tiene una sola.
  - **Carteras vacías.** La base todavía deja que una agencia abra una cartera sin cupo ni saldo, porque la API las abría así, en COP, hasta este cambio. Como ya no las abre, una migración puede prohibirlo.
  - **`tenants.credit_limit`.** Queda fuera de uso desde 0053, pero con su dato. Se puede borrar en una migración posterior.
  - **Monedas sin dos decimales** (CLP, JPY, KWD…). No se habilitan hasta que `Money` lleve el exponente ISO 4217.
- **Alta pública.** Con `ALLOW_PUBLIC_SIGNUP=true`, `POST /auth/register` crea una agencia raíz y ahora la base la rechaza con 409. Está apagada por defecto. Hay que colgarla de la plataforma o quitarla.
- **Cambio de tipo desde la web.** La API lo permite (`PATCH /admin/tenants/:id` con `tenantType`, dentro de D4); el panel todavía no.
- **Cachés tras un movimiento.** La habilitación de proveedores se cachea 10 s por réplica: justo después de mover un nodo puede verse la herencia anterior durante ese lapso.

---

## 5. Runbook del VPS

Orden obligatorio. Cada paso dice cómo comprobar que salió bien. Los comandos se corren como `deploy` en el VPS, desde `/opt/sales-travel`, y ninguno imprime secretos.

Los pasos 1 a 6 son la tanda 1 (`feat/network-model`, desplegada con #6). Los pasos 7 a 9 son las carteras por moneda (`feat/wallets-per-currency`) y suponen hechos los anteriores: Planetour como `platform`, tu cuenta como superadmin, una sucursal con su vendedor y la cuenta TBO cargada en Planetour. Los pasos 10 a 13 son el rediseño de hoteles (`feat/hotels-redesign`) y suponen desplegadas las carteras: el permiso de no reembolsables de 0055 usa quién financia a quién, que es de 0052.

**Antes de empezar (pasos 1 a 6):**

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
- Hasta la tanda 2 ve el neto del proveedor (G-02), y hasta el paso 7 administra su propia cartera. No cargues en Planetour reglas de margen que quieras ocultarle, y no le habilites TBO (paso 6).
- **Sabre de certificación.** Sabre se llama siempre (política `always`). Si la cuenta de Planetour está `active` y es heredable, desde el movimiento cada búsqueda de vuelos de Amazon sale también a Sabre CERT, con tarifas y PNR de prueba, igual que ya pasa en Planetour y pasará en sus sucursales. Antes de mover, revísala: `SELECT status, is_inheritable, config->>'environment' AS entorno FROM provider_accounts WHERE provider_code = 'sabre'`. Si no quieres eso para Amazon, en _Proveedores de la plataforma_ → Sabre agrega una excepción **Deshabilitado** para Amazon Minimalist, con motivo, antes de pulsar **Mover**.

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
   - **No** lo habilites con _Todos los tenants_ ni en el nodo Planetour: se heredaría a toda la red, Amazon incluida. TBO reserva con `PaymentMode: Limit`, contra el crédito o saldo del titular de la cuenta (Planetour). Hasta el paso 7, una agencia externa administra su propia cartera y se puede dar el cupo que quiera. Desde el paso 7 el cupo lo fija Planetour, pero G-02 (el neto del proveedor) sigue abierto.
4. La búsqueda de TBO usa el catálogo local. Sin el sync, la sucursal no encuentra hoteles aunque TBO esté habilitado. El sync usa **esta misma cuenta de Planetour**: la lee de la bóveda con `PROVIDER_CREDENTIALS_KEY`, la clave que ya usa el api (D-TBO-04, decisión del 2026-09-29). **No hace falta cargar `TBO_SYNC_USERNAME` ni `TBO_SYNC_PASSWORD` en GitHub Actions** ni desplegar: con la cuenta en **Activo**, la corrida siguiente del workflow _Sync TBO Hotel Inventory_ (cada hora de 06:17 a 09:17 UTC, o a mano con _Run workflow_) sale con ella, y su log dice `credentialSource: "vault:platform/default"`. Con la cuenta en Sandbox el sync no corre y lo dice (`no active tbo-hotels account in the vault of 'platform'`). Las `TBO_SYNC_*` de usuario y contraseña quedan sólo como override (el stack de certificación): si alguna vez se cargaron en GitHub, bórralas y corre **Deploy**, porque mientras estén mandan sobre la bóveda y el log dice `credentialSource: "env"`. Ver [`tools/sync-tbo-hotel-inventory`](../../tools/sync-tbo-hotel-inventory/README.md).
5. Comprueba, con la cuenta en **Activo** y el catálogo sincronizado:
   - en _Proveedores (GDS)_ de la sucursal, TBO figura como heredado de Planetour;
   - con el vendedor de la sucursal, _Hoteles_ devuelve resultados de TBO;
   - con un usuario de Amazon, TBO no aparece.

### Paso 7 — Deploy de las carteras por moneda (0052 y 0053)

**Antes de mergear:**

- El PR de `feat/wallets-per-currency` tiene el CI en verde, incluidos los tests de integración que corren como `app_user` contra Postgres real (`wallets-rls`, `wallet-financing` y `holds-per-currency`).
- Hay un backup reciente de la base, como en el paso 1.
- Guarda cómo están hoy las carteras y el crédito interno, para compararlos después:

  ```bash
  docker compose exec -T postgres psql -U postgres -d sales_travel -c \
    "SELECT t.slug, t.tenant_type, t.is_branch, t.default_currency, t.credit_limit, ap.currency, ap.credit_limit_minor, ap.balance_minor, ap.status FROM tenants t LEFT JOIN agency_portfolios ap ON ap.tenant_id = t.id ORDER BY t.path, ap.currency"
  ```

  Esperado: las carteras que existan están en `COP` con cupo y saldo 0, y `credit_limit` es 0 en todos los nodos, así que 0053 no cambia nada. Si algún nodo tiene `credit_limit` mayor que 0, 0053 lo pasa al cupo de su cartera en `default_currency`, y si no tiene cartera en esa moneda, la abre.

**Qué cambia al desplegar:**

- La agencia ya no se fija el cupo ni se registra depósitos o retiros. _Cartera B2B_ muestra sus carteras y movimientos, sin depósito, retiro ni cupo, y ofrece **Informar depósito** a sus admins. Las rutas viejas responden 403 `PORTFOLIO_FINANCIER_REQUIRED`.
- La API ya no abre una cartera COP la primera vez que alguien mira _Cartera B2B_. Un nodo que nunca la abrió no tiene carteras y lo ve así ("Tu agencia todavía no tiene carteras"): hasta que quien lo financia le habilite una moneda, no reserva hoteles. Con las carteras en 0/0 tampoco podía antes.
- Un hotel se retiene en la cartera de la moneda de la tarifa. Vuelos y autos no cambian en la web, que no les retiene cartera: sólo lo hace `POST /portfolios/hold-booking`, y ahora con la misma regla.
- 0052 cambia las restricciones de `agency_portfolios` con un lock exclusivo breve. Una retención que llegue en ese momento espera a que termine.
- Entre el fin de 0052 y el arranque del api nuevo, el api viejo sigue atendiendo unos segundos. En ese lapso puede responder error al abrir por primera vez la cartera de un nodo, porque su `ON CONFLICT (tenant_id)` ya no tiene índice, o al registrar un depósito, porque la guarda de 0052 lo rechaza. La transacción se deshace y no deja nada a medias.

**Deploy y comprobación:**

1. El founder mergea el PR a `main`. El workflow **Deploy** construye las imágenes, aplica 0052 y 0053 y hace el smoke test. Cada migración corre en su transacción: si 0052 encuentra carteras con moneda, cupo o estado inválidos, falla y se deshace entera, y el `HINT` trae la consulta para encontrarlas.
2. Repite la consulta de arriba. Esperado: las mismas carteras, con el mismo cupo, saldo y estado, porque 0052 no crea ni borra ninguna. Sólo cambia si algún nodo tenía `credit_limit`.
3. Revisa los avisos de 0053 en el log de `postgres` (el contenedor `migrate` no los imprime):

   ```bash
   docker compose logs postgres | grep 'REVISAR: '
   ```

   Esperado: nada. "tiene un cupo de … que no fijó quien la financia" es un cupo que se había puesto la propia agencia: se conserva, y lo revisas en su _Carteras_ (paso 8) para confirmarlo o bajarlo con motivo. "su moneda por defecto (…) no es válida" es un crédito interno que no se pudo pasar: corrige la moneda del nodo y fija el cupo desde el panel.

4. Lo que movió 0053 quedó auditado, con actor vacío y la migración como origen:

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT occurred_at, event_type, tenant_id, payload FROM domain_events WHERE payload->>'source' = 'migration:0053_tenant_credit_limit_to_wallets'"
   ```

   Esperado: ninguna fila si todos los `credit_limit` eran 0.

5. Con un admin de Amazon Minimalist (o de otra agencia), _Cartera B2B_ ya no ofrece depositar, retirar ni cambiar el cupo. Si tiene cartera, ofrece **Informar depósito**.

### Paso 8 — Cartera en USD con cupo para una sucursal

TBO cotiza en la moneda de la cuenta, USD en la de test, y la retención no convierte: sin una cartera en USD, la sucursal no reserva TBO. A una sucursal la financia Planetour, así que se la da el superadmin.

1. Con tu cuenta de superadmin, ve a _Gestión de Agencias_ y en la fila de la sucursal pulsa **Carteras**.
2. Pulsa **Habilitar moneda** y completa:

   - **Moneda:** USD, que aparece entre las frecuentes;
   - **Cupo inicial (USD):** lo que la sucursal puede deber a Planetour en USD, en unidades mayores. Para la prueba del paso 9 alcanza con cubrir una noche, por ejemplo `1000`;
   - **Motivo:** por ejemplo "Reservas TBO de prueba en la sucursal".

   Pulsa **Habilitar USD**. Si la sucursal ya tenía una cartera COP en 0/0, déjala: es otra cartera y no estorba.

3. Comprueba:

   - la tarjeta USD muestra saldo 0, un cupo de 1.000 USD y el estado _Activa_;
   - el cambio quedó auditado con tu usuario y tu motivo:

     ```bash
     docker compose exec -T postgres psql -U postgres -d sales_travel -c \
       "SELECT e.occurred_at, u.email AS actor, t.slug, e.event_type, e.payload FROM domain_events e JOIN tenants t ON t.id = e.tenant_id LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.event_type LIKE 'portfolio.%' ORDER BY e.occurred_at DESC LIMIT 5"
     ```

     Esperado: `portfolio.created` con el slug de la sucursal y un `payload` con `"currency": "USD"`, `"creditLimitMinor": 100000`, tu motivo y `"source": "api"`;

   - con un usuario de la sucursal, _Cartera B2B_ muestra la cartera USD con su cupo y sin botones de depósito, retiro ni cupo.

**Cupo o depósito.** Con cupo, la sucursal reserva a crédito y su saldo queda en negativo por lo que retiene. Si prefieres que opere sólo con saldo, deja el cupo en 0 y registra un **Depósito** (con motivo) en la tarjeta USD. Una cartera no se borra: para cerrarla, pulsa **Suspender** o baja el **Cupo** a 0, y queda con su historial.

### Paso 9 — Reserva TBO de prueba en la sucursal

Se reserva de verdad contra el entorno de **test** de TBO, con la cuenta de Planetour. No es plata real y no es la certificación: los casos de certificación corren en su propio stack ([`infrastructure/hostinger/README.md` §9](../../infrastructure/hostinger/README.md#9-stack-de-certificación-de-tbo)), que siembra su cartera con [`seed-tbo-cert-tenant`](../../tools/seed-tbo-cert-tenant/README.md).

**Antes de empezar:**

- La cuenta TBO de Planetour está en **Activo** con el entorno **Test (certificación)**. Es la excepción al paso 6, que pide Activo sólo con la cuenta live: mientras esté así, todo lo que se reserve con TBO va al entorno de test.
- En _Proveedores de la plataforma_ → TBO Holidays, la sucursal tiene TBO **Habilitado**. Si además está habilitado con _Todos los tenants_, cualquier agencia a la que le des una cartera en USD reservaría contra el entorno de test.
- El catálogo de TBO ya está sincronizado para el país del destino (paso 6.4).
- La sucursal tiene email y teléfono de soporte en formato internacional (por ejemplo `+57 300 123 4567`) en _Mi Agencia_ → Marca, propios o heredados de Planetour. Es el contacto que viaja a TBO; sin él, el Book responde `AGENCY_CONTACT_MISSING`.

**La prueba:**

1. Entra con el **vendedor** de la sucursal (el superadmin no vende) y abre _Hoteles_. Elige un destino del catálogo, fechas con al menos unas semanas de anticipación, la ocupación, la nacionalidad y la moneda **USD**. Bajo el selector de moneda no tiene que aparecer "Tu agencia no tiene cartera en USD".
2. Busca, abre un hotel de TBO y elige una habitación con **cancelación gratuita**, para cancelarla sin cargo al final.
3. En el checkout, el PreBook no tiene que mostrar el aviso de la cartera. Carga huéspedes de prueba y pulsa **Confirmar reserva**. La reserva queda confirmada (si TBO tarda, pasa unos segundos por "Verificando con el proveedor…") y aparece en _Mis Reservas_.
4. Comprueba la retención. En _Cartera B2B_ de la sucursal, la cartera USD muestra la retención de la reserva, y la COP no se movió. Por consola:

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT pt.created_at, ap.currency, pt.transaction_type, pt.amount_minor, ap.balance_minor AS saldo_actual FROM portfolio_transactions pt JOIN agency_portfolios ap ON ap.id = pt.portfolio_id JOIN tenants t ON t.id = ap.tenant_id WHERE t.slug = '<slug de la sucursal>' ORDER BY pt.created_at DESC LIMIT 5"
   ```

   Esperado: un `BOOKING_HOLD` en `USD` con `amount_minor` negativo (menos el precio de venta, en centavos) y `saldo_actual` en ese mismo valor.

5. Cancela. En _Mis Reservas_ abre la reserva y pulsa **Cancelar reserva**. Cuando quede cancelada, la consulta anterior muestra un `BOOKING_RELEASED` por el mismo monto en positivo y el saldo vuelve a 0. Si la cancelación queda "en curso", la retención se mantiene hasta que se verifique: es lo esperado (D-TBO-25).
6. Opcional, el rechazo. En _Carteras_ de la sucursal, **Suspender** la cartera USD con motivo y repite con el vendedor los puntos 1 a 3 de esta prueba. Bajo el selector de moneda aparece "La cartera USD de tu agencia está suspendida". El checkout avisa que no se puede retener y no deja cargar huéspedes, y el Book no sale a TBO. Después pulsa **Reactivar**, también con motivo.

**Al terminar.** Mientras la cuenta de Planetour sea la de test, una reserva de TBO confirmada no es una habitación real. Si la sucursal ya atiende clientes, en _Proveedores de la plataforma_ → TBO Holidays pasa su ajuste de **Habilitado** a **Heredar** (TBO es `opt-in` y, sin habilitarlo en Planetour ni para todos, queda apagado) o a **Deshabilitado**, hasta cargar la cuenta live (paso 6.2). La cartera USD puede quedar como está.

**Si algo no sale:**

| Síntoma                                                                          | Qué revisar                                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| La búsqueda en USD no trae hoteles de TBO                                        | TBO habilitado para la sucursal, cuenta en Activo y catálogo sincronizado (paso 6).                |
| "La agencia no tiene cartera en USD: pedile a quien te financia que la habilite" | El paso 8 no quedó hecho en esa sucursal.                                                          |
| "no tiene saldo ni cupo suficiente para esta reserva"                            | Sube el **Cupo** de la cartera USD, o registra un **Depósito**, o elige una habitación más barata. |
| "La cartera en USD de la agencia está suspendida"                                | **Reactivar** en la tarjeta USD.                                                                   |
| "Falta el contacto de soporte de la agencia" (`AGENCY_CONTACT_MISSING`)          | Email y teléfono internacional en _Mi Agencia_ → Marca de la sucursal o de Planetour.              |

### Paso 10 — Deploy del rediseño de hoteles (0054 y 0055)

Lo que sale con `feat/hotels-redesign`, todo detrás del mismo deploy:

- **Resultados de hoteles nuevos:** barra de la búsqueda, filtros, orden, vista "Mapa" como lista con enlace a Google Maps y tarjeta con foto. Las fotos se traen en segundo plano y pasan por un proxy propio del panel (`/api/hotels/images/…`). El diseño y sus límites están en [docs/tbo/05 §8.6](../tbo/05-contenido-estatico-e-inventario.md#86-cobertura-global-ciudades-que-se-cargan-al-buscar-y-fotos-bajo-demanda-aplicado-2026-09-29).
- **[0054](../../db/migrations/0054_hotel_catalog_on_demand.sql):** dos funciones `SECURITY DEFINER` con las que el api completa el catálogo bajo demanda (el contenido de los hoteles y los hoteles de una ciudad nueva). No toca datos.
- **[0055](../../db/migrations/0055_non_refundable_rates_permission.sql):** la tabla `tenant_booking_permissions`, vacía. Sin filas, todos los nodos pueden reservar tarifas no reembolsables, ahora con la confirmación obligatoria del checkout ([docs/tbo/03 §2.13](../tbo/03-prebook-y-book.md#213-tarifas-no-reembolsables-aplicado-2026-09-29)).
- **Qué cambia para quien vende:** una tarifa no reembolsable pide marcar una casilla con el monto antes de reservar. Un cliente de la API que reserve sin `nonRefundableAcknowledged` recibe 400 `NON_REFUNDABLE_NOT_ACKNOWLEDGED` y no sale nada a TBO.

**Antes de mergear:** el PR de `feat/hotels-redesign` tiene el CI en verde, incluida `booking-permissions.integration.test.ts`, que corre como `app_user`. Los pasos 7 a 9 están hechos y hay un backup reciente de la base, como en el paso 1.

**Deploy y comprobación:**

1. El founder mergea el PR a `main`. El workflow **Deploy** construye las imágenes (también la del sync de TBO, que trae la etapa E2A), aplica 0054 y 0055 y hace el smoke test.
2. Comprueba que las funciones existen, que el api puede usarlas y que el permiso está vacío:

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT p.proname, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user FROM pg_proc p WHERE p.proname IN ('hotel_catalog_store_contents', 'hotel_catalog_import_city', 'non_refundable_rates_block') ORDER BY 1"
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT count(*) AS permisos FROM tenant_booking_permissions"
   ```

   Esperado: las tres funciones con `app_user` en `t`, y `permisos` en 0.

3. Con el vendedor de la sucursal, _Hoteles_ busca como antes y la pantalla de resultados es la nueva.

### Paso 11 — Precargar las ciudades de todos los países (E2A)

Hoy el buscador sólo sugiere las ciudades de los países que el sync recorre (`TBO_SYNC_COUNTRIES`, y con hoteles sólo CO). La etapa E2A baja la lista de ciudades de TODOS los países de TBO, sin sus hoteles. Desde ese momento el autocompletado las sugiere y, la primera vez que alguien busca una, el api trae sus hoteles con una llamada a TBO (1 a 5 s) y los guarda. Es opt-in: la corrida programada no la incluye y no hace falta tocar `TBO_SYNC_STAGES` en el VPS. Detalle en [`tools/sync-tbo-hotel-inventory`](../../tools/sync-tbo-hotel-inventory/README.md#cobertura-global-e2a-las-ciudades-de-todos-los-países).

**Antes de empezar:**

- El paso 10 está desplegado: la imagen del sync con E2A sale con ese deploy.
- La cuenta TBO de Planetour está en **Activo** (paso 6). El sync la lee de la bóveda y comparte su cupo con la venta, así que conviene correrla fuera del horario de venta. Si coincide con la corrida programada (cada hora de 06:17 a 09:17 UTC), el workflow la pone en cola y espera a que termine la otra.
- Cuesta unas 250 llamadas a 1 por segundo: `CountryList` y un `CityList` por país. Tiene un tope propio de 300 países por corrida.

**La corrida:**

1. En GitHub → _Actions_ → **Sync TBO Hotel Inventory** → **Run workflow**, rama `main`, con:
   - **stages:** `E1,E2A`;
   - **max_calls:** `300`;
   - **countries:** vacío.
2. En el log del job, busca estas líneas:
   - `tbo.sync.credentials` con `credentialSource: "vault:platform/default"`;
   - `tbo.sync.stage` con `"stage": "E2A"`, que cuenta `countriesInTbo`, `countriesRequested`, `countriesFailed`, `countriesPending` y `citiesUpserted`;
   - `tbo.sync.result` con `ok: true`, `e2a: "done"`, `worldCitiesUpserted` y `worldCountriesPending`.
3. Si `worldCountriesPending` es mayor que 0 o hubo `countriesFailed`, repite el mismo **Run workflow**: sólo pide los países que siguen sin ciudades, y un país que ya las tiene cuesta cero llamadas.
4. Comprueba en la base:

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT count(DISTINCT country_code) AS paises, count(*) AS ciudades, count(*) FILTER (WHERE hotel_count IS NULL) AS se_cargan_al_buscar, count(*) FILTER (WHERE hotel_count > 0) AS con_hoteles, count(*) FILTER (WHERE hotel_count = 0) AS sin_hoteles FROM hotel_provider_city WHERE provider_code = 'tbo-hotels'"
   ```

   Esperado: `paises` cerca de `countriesInTbo` del log y la mayoría de las ciudades en `se_cargan_al_buscar`. Las de Colombia siguen con sus hoteles (`con_hoteles`), y `sin_hoteles` son las que TBO ya contestó vacías, que no se sugieren.

5. Prueba una ciudad nueva. Con el vendedor de la sucursal, en _Hoteles_ escribe una ciudad de un país que no tenía hoteles cargados (por ejemplo `Quito` o `Paris`), elígela y busca. La primera búsqueda tarda unos segundos más y trae hoteles de TBO. Sólo sirve si la sucursal sugiere desde el catálogo local; si la ciudad no aparece en el autocompletado, mira la última fila de la tabla del paso 12. En el log del api:

   ```bash
   docker compose logs --since 15m api | grep 'hotels.catalog.ciudad_'
   ```

   Esperado: `hotels.catalog.ciudad_cargada provider=tbo-hotels city=<código> outcome=loaded hotels=<n> unreadable=<n>`. La segunda búsqueda de esa ciudad ya no llama a TBO para cargarla, y la próxima corrida del sync la refresca mientras tenga búsquedas, aunque su país no esté en `TBO_SYNC_COUNTRIES`.

**Cuándo repetirla.** Sólo si TBO suma países: E2A no vuelve a pedir la lista de un país que ya tiene ciudades. Las de los países de `TBO_SYNC_COUNTRIES` las refresca E2 en cada corrida programada; las del resto del mundo quedan como las bajó la primera corrida.

### Paso 12 — Verificar las fotos

Las fotos de los resultados no esperan al sync. La búsqueda trae la foto que el catálogo ya tiene; para las que faltan, la pantalla pide el contenido en segundo plano, el api lo trae de `HotelDetails` (lotes de 10, con la cuenta de la agencia), lo guarda en `hotel_content` y la foto aparece. El navegador nunca le pide nada al host de TBO: todo pasa por el proxy del panel.

1. **En la pantalla.** Con el vendedor de la sucursal, busca en Bogotá (moneda USD). Los resultados salen enseguida. Las tarjetas sin foto muestran un marcador y, en unos segundos, las fotos aparecen. Si TBO no tiene fotos de un hotel, la tarjeta dice "Sin foto". Abre un hotel: la ficha muestra la galería o, mientras la trae, "Buscando las fotos del hotel…"; las tarifas no esperan.
2. **En el navegador (opcional).** En las herramientas de desarrollo, pestaña _Red_:
   - `content/batch` responde 201 con `items` en `ready`, `pending` o `none`. Si algo queda `pending`, trae `retryAfterMs` y la pantalla vuelve a preguntar, hasta 3 veces por hotel;
   - las fotos salen de `/_next/image?url=%2Fapi%2Fhotels%2Fimages%2F…` como `image/webp`;
   - no hay pedidos a `tbotechnology.in` ni a `tboholidays.com`.
3. **En la base.** Lo que se trajo quedó guardado:

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT source, lang, count(*) AS hoteles, count(*) FILTER (WHERE images->>0 IS NOT NULL) AS con_fotos, max(fetched_at) AS ultima FROM hotel_content WHERE provider_code = 'tbo-hotels' GROUP BY source, lang ORDER BY source, lang"
   ```

   Esperado: filas `details` en el idioma de la búsqueda (`es`), con `ultima` de hace minutos y `con_fotos` creciendo con cada búsqueda. Las `listing` en `en` son el texto de `TBOHotelCodeList`, del sync o de una ciudad cargada al buscar, y no traen fotos.

4. **El proxy, desde el VPS.** Toma una foto guardada y pídela por el proxy y por el optimizador de imágenes:

   ```bash
   URL=$(docker compose exec -T postgres psql -U postgres -d sales_travel -Atc \
     "SELECT images->>0 FROM hotel_content WHERE provider_code = 'tbo-hotels' AND images->>0 IS NOT NULL LIMIT 1")
   KEY=$(printf '%s' "$URL" | base64 -w0 | tr '+/' '-_' | tr -d '=')
   curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "https://app.planetour.cloud/api/hotels/images/$KEY"
   curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "https://app.planetour.cloud/_next/image?url=%2Fapi%2Fhotels%2Fimages%2F$KEY&w=384&q=70"
   ```

   Esperado: `200 image/jpeg` (o el formato de la foto) y `200 image/webp`. Con una URL de otro dominio el proxy responde 404: no es un proxy abierto.

5. **La precarga, al día siguiente.** Las ciudades buscadas entran en la demanda del sync (últimos 14 días), así que la corrida programada baja su contenido en E4 aunque nadie abra las fotos. En el log del workflow, `tbo.sync.result` trae `contentsWritten` mayor que 0. La cobertura por ciudad:

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT c.name, count(*) AS activos, count(hc.hotel_id) AS con_ficha_es FROM hotel_inventory i JOIN hotel_provider_city c ON c.provider_code = i.provider_code AND c.provider_city_code = i.provider_city_code LEFT JOIN hotel_content hc ON hc.provider_code = i.provider_code AND hc.hotel_id = i.hotel_id AND hc.lang = 'es' AND hc.source = 'details' WHERE i.provider_code = 'tbo-hotels' AND i.active AND c.country_code = 'CO' GROUP BY c.name ORDER BY activos DESC LIMIT 10"
   ```

   Esperado: `con_ficha_es` subiendo en las ciudades que se buscan.

**Si algo no sale:**

| Síntoma                                                                     | Qué revisar                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Todas las tarjetas terminan en "Sin foto"                                   | `docker compose logs --since 15m api \| grep hotels.content_batch`. `lote_fallo` con `error=` es TBO lento o caído: el lote se recuerda 2 min y se vuelve a pedir. `guardar_fallo` es la base: revisa que 0054 esté aplicada (paso 10). Sin ninguna línea: el circuito de la cuenta está abierto o TBO está apagado (esos casos no dejan línea), o esos hoteles ya tienen su ficha y TBO no tiene fotos de ellos. |
| Algunas tarjetas quedan en "Sin foto" y la foto sale al repetir la búsqueda | La pantalla pregunta 3 veces por hotel. Si el cupo de fondo de la cuenta está ocupado (por ejemplo, por el sync corriendo a la vez), el api sigue trayendo las fotos y las guarda, y la próxima vista las muestra. No bloquea la búsqueda.                                                                                                                                                                        |
| La foto está en la base pero el proxy responde 404                          | El dominio de la URL no es de TBO (`tbotechnology.in`, `tboholidays.com`), o TBO ya no sirve esa foto: no respondió 200 en 8 s, pesa más de 5 MB o no es una imagen. Un fallo se recuerda 5 min. Si TBO cambió de host, se agrega en `TBO_IMAGE_HOST_SUFFIXES` del ACL y en `HOTEL_IMAGE_HOST_SUFFIXES` del panel, que son espejo.                                                                                |
| El proxy responde 503                                                       | Más de 32 descargas a la vez. Es pasajero: la próxima vista la trae.                                                                                                                                                                                                                                                                                                                                              |
| Una ciudad nueva dice "No pudimos traer los hoteles de esa ciudad"          | En el log del api, `hotels.catalog.ciudad_no_cargada` con `error=`: TBO no contestó en 15 s o el circuito está abierto; reintenta en unos minutos. `hotels.catalog.ciudad_no_guardada` es la base: revisa que 0054 esté aplicada (paso 10).                                                                                                                                                                       |
| Una ciudad nueva dice "Esa ciudad no tiene hoteles disponibles por ahora"   | TBO la contestó vacía: queda con `hotel_count = 0` y deja de sugerirse.                                                                                                                                                                                                                                                                                                                                           |
| Una ciudad del mundo no aparece en el autocompletado                        | La agencia sugiere desde Despegar, porque tiene un proveedor activo del espacio de ids de la plataforma, y entonces el catálogo local no sugiere ([docs/tbo/05 §8.5](../tbo/05-contenido-estatico-e-inventario.md#85-sugerencias-desde-el-catálogo-local-aplicado-2026-09-27)). Si no es eso, falta el paso 11 o la ciudad tiene `hotel_count = 0`.                                                               |

### Paso 13 — Tarifas no reembolsables y su permiso

1. **La venta.** Con el vendedor de la sucursal, en los resultados las tarifas no reembolsables llevan la etiqueta "No reembolsable" en color de advertencia, y el filtro "Solo reembolsables" las saca. Elige una: el paso 1 del checkout muestra el aviso "Tarifa no reembolsable" con el 100 % en USD. En el paso 2, sin marcar la casilla "Entiendo que esta tarifa no es reembolsable…", **Confirmar reserva** no sale y la casilla muestra el error. No hace falta reservarla.
2. **El bloqueo.** Con tu cuenta de superadmin, en _Gestión de Agencias_ pulsa **Carteras** en la fila de la sucursal. En "Puede reservar tarifas no reembolsables", pulsa el interruptor y **Bloquear**, con motivo. Con el vendedor, repite la búsqueda: esas tarifas dicen "No disponible para tu agencia" y no se ofrecen. Por API, el PreBook y el Book responden 403 `NON_REFUNDABLE_BLOCKED`.
3. **La auditoría:**

   ```bash
   docker compose exec -T postgres psql -U postgres -d sales_travel -c \
     "SELECT e.occurred_at, u.email AS actor, t.slug, e.event_type, e.payload FROM domain_events e JOIN tenants t ON t.id = e.tenant_id LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.event_type IN ('booking.permissions.non_refundable_rates.changed', 'HotelNonRefundableAcknowledged') ORDER BY e.occurred_at DESC LIMIT 5"
   ```

   Esperado: `booking.permissions.non_refundable_rates.changed` con el slug de la sucursal, tu usuario y un `payload` con `"from": "allowed"`, `"to": "blocked"`, tu motivo y `"source": "api"`. Si alguien reservó una no reembolsable, también `HotelNonRefundableAcknowledged` con el vendedor como actor y el 100 % en `penaltyMinor`.

4. Vuelve a **Permitir** con motivo, salvo que quieras dejar a la sucursal sin no reembolsables. El bloqueo de un nodo rige para todo lo que cuelga de él, y un nivel de arriba bloqueado no se destraba desde abajo.
