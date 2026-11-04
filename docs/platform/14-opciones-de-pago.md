# Gobierno de proveedores y formas de pago, con perfiles

> Estado: **implementado** (2026-11-04). Decisiones del founder:
>
> - Los perfiles se propagan: quedan enlazados.
> - Un nodo sin perfil ni reglas hereda de su padre.
> - Se siembra «Configuración vigente» para no cortar ventas.
> - La tarjeta digitada de LATAM queda en el catálogo, apagada salvo que el superadmin la encienda.
>
> Dónde está cada pieza:
>
> - Migraciones: `db/migrations/0089` y `0090`.
> - API: `apps/api/src/governance/`.
> - Panel: Plataforma → Gobierno, la sección de Gobierno en Agencias → [nodo] y el selector de perfil en el alta de un nodo.
> - Pago: diálogo de Reservas con las formas habilitadas y el enlace de pago de LATAM.
>
> Al dar de alta un nodo, el panel preselecciona el perfil marcado como predeterminado. Si un admin de red crea la agencia, esta hereda.
>
> Pedido original del founder:
>
> - Un gobierno completo de los proveedores y sus formas de pago.
> - Todo habilitado **explícitamente** por el superadmin.
> - Perfiles predeterminados (crear, modificar, o no usar ninguno y configurar a mano) para no
>   configurar una agencia nueva proveedor por proveedor.
>
> Primer consumidor: el enlace de pago de LATAM NDC (`docs/latam-ndc/01-estado-y-plan.md`, P2-0).

## 1. Reglas

1. **Nada se vende ni se cobra si el superadmin no lo encendió.** Vale para proveedores y para formas de pago. Desaparece el «encendido por defecto» actual: hoy LATAM, Sabre y Despegar quedan prendidos si nadie dice nada (`callPolicy: 'always'`, `apps/api/src/providers/provider.types.ts:589-594`).
2. **Una forma de pago cuelga de su proveedor.** Encender «LATAM: enlace de pago» con LATAM apagado no habilita nada.
3. **Solo el superadmin escribe.** Consolidadores y agencias leen su configuración efectiva y su origen, pero no la cambian. Las credenciales BYOC siguen siendo de cada nodo: el gobierno dice qué se puede usar, la bóveda dice con qué cuenta.
4. **Todo cambio queda auditado** en `domain_events`, con antes, después y alcance.

## 2. Qué se gobierna: el catálogo

El catálogo vive en código (`packages/domain/src/governance/catalog.ts`), así que un proveedor o una forma de pago nueva entra con un PR y nace **apagada**.

| Proveedor            | Formas de pago que gobierna                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `latam-ndc` (vuelos) | `payment_link` (enlace de LATAM, SAQ-A) · `cash` (agencia/BSP) · `gov` · `card` (tarjeta digitada: PAN y CVV por nuestro servidor, **fuera de SAQ-A**) |
| `sabre` (vuelos)     | Forma de pago de emisión: `cash` · `on_account` · `invoice`                                                                                            |
| `despegar-hotels`    | `card_token` (tarjeta tokenizada en checkout alojado, sin UI hoy)                                                                                      |
| `tbo-hotels`         | No tiene forma de pago elegible: cupo `Limit` + cartera de la red. Se gobierna solo el proveedor.                                                      |
| `agent-cars` (autos) | `prepaid` · `pay_at_destination`                                                                                                                       |

La **cartera de la red** no es una forma de pago elegible: es cómo se liquida con el proveedor, y sigue como está.

## 3. Modelo

### 3.1 Perfiles

```text
governance_profiles        (id, name, description, is_default_for_new_nodes, archived_at, …)
governance_profile_items   (profile_id, provider_code, payment_method NULL, enabled)
                           -- payment_method NULL = la fila del proveedor
```

- **Perfil** es un conjunto nombrado de reglas, por ejemplo:
  - «Agencia Colombia estándar»: LATAM + enlace de pago, Sabre + efectivo, TBO.
  - «Solo hoteles».
- El superadmin los **crea, edita, duplica y archiva**.
- Un perfil puede marcarse como **predeterminado para nodos nuevos**.

### 3.2 Asignación a un nodo

```text
tenant_governance   (tenant_id PK, profile_id NULL, updated_by, …)
governance_rules    (tenant_id NULL = plataforma, provider_code, payment_method NULL, enabled, reason, …)
```

Cada nodo tiene, opcionalmente:

- **un perfil** asignado;
- **reglas a mano** que pisan el perfil, sea para completar o para excepciones.

Sin perfil y sin reglas, el nodo **hereda** de su padre.

### 3.3 Resolución (el fold es TypeScript puro y testeable)

Para un tenant y un elemento (proveedor o proveedor + forma de pago):

1. Se recorre del nodo hacia la raíz y gana el **más cercano** que diga algo. En cada nodo, la regla a mano gana sobre el perfil.
2. Si ningún nodo dice nada, aplica la regla **global** de la plataforma.
3. Si tampoco hay global: **apagado**.
4. Una forma de pago efectiva exige además su **proveedor** efectivo encendido.
5. El **kill-switch** de operaciones (`provider_kill_switches`) sigue por encima de todo.

Se reutiliza el patrón de `provider_enablement` (0048): una función SQL `governance_chain(tenant)` devuelve las filas crudas de la cadena con su profundidad, y el fold decide.

### 3.4 Nodos nuevos

- El **superadmin** que crea el nodo elige perfil en el alta («Perfil: Agencia Colombia estándar / Ninguno, a mano / Heredar del padre»).
- Un **admin de red** que crea una agencia no elige perfil: la agencia **hereda del padre**. Si el consolidador está gobernado, la agencia nace gobernada igual. Si existe un perfil predeterminado para nodos nuevos, se asigna.

## 4. Dónde se hace cumplir (siempre en la API)

| Punto                                     | Qué se valida                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Búsqueda (vuelos, hoteles, autos)         | Proveedor efectivo encendido. Reemplaza la decisión actual de `PlatformProviderFlags`. |
| Revalidar y reservar                      | Proveedor encendido (ya pasa por `byCodeForOffer`).                                    |
| `POST /orders/:id/pay`                    | Forma de pago encendida. El body pasa a ser una unión con `method`.                    |
| `POST /orders/:id/payment-link` (nuevo)   | `latam-ndc` + `payment_link`.                                                          |
| Emisión Sabre                             | La forma de pago de la cuenta está encendida para el nodo.                             |
| Autos                                     | `prepaid` / `pay_at_destination`.                                                      |
| `GET /orders/:id/payment-options` (nuevo) | Lo que la orden admite **y** está encendido: es lo único que muestra la UI.            |

## 5. Panel superadmin

- **Plataforma → Gobierno → Perfiles:** lista, crear, editar (una matriz de proveedores × formas de pago con interruptores), duplicar, archivar y marcar predeterminado. Muestra cuántos nodos usan cada perfil.
- **Plataforma → Gobierno → Global:** las reglas que valen para toda la plataforma.
- **Plataforma → Tenants → [nodo] → Gobierno:**
  - el perfil asignado;
  - las reglas a mano;
  - la **matriz efectiva** con el origen de cada celda (a mano, perfil X, heredado de Y, global, apagado).
- **Alta de nodo:** el selector de perfil.
- Las agencias ven su matriz efectiva en solo lectura.

## 6. Transición sin cortar producción

- La migración crea el perfil **«Configuración vigente»**, con lo que hoy está encendido de hecho:
  - LATAM, Sabre y Despegar, por su `callPolicy: always`;
  - TBO, solo donde hoy hay fila `provider_enablement` encendida;
  - las formas de pago que hoy se usan: LATAM `card`, Sabre la de cada cuenta y autos ambas.
- Ese perfil se **asigna a la plataforma** (global), de modo que el día del deploy nada cambia.
- Las filas actuales de `provider_enablement` se convierten en reglas a mano de su nodo.
- Desde ese momento, el superadmin apaga o cambia lo que quiera. Ningún proveedor ni forma de pago nuevo se enciende solo.

## 7. Enlace de pago LATAM

1. **Generar el enlace.** En una reserva LATAM sin pagar, el botón «Enviar enlace de pago» llama a `/ndc/v192/order/change/send/payment/link` con el `OrderID` y el correo del pagador (por defecto el contacto de la reserva, editable).
2. **Registrar el envío.** Queda en el log de operaciones como `payment_link_sent` (a quién, cuándo y Track-Id) y en `domain_events`.
3. **Detectar el pago.** La orden sigue `confirmed` hasta que LATAM la cierre. La relectura la pasa a `ticketed` cuando LATAM responde `CLOSED`.
4. **Avisar del vencimiento.** El plazo de pago (`PaymentTimeLimitDateTime`) se muestra y alerta con lo que ya existe.

## 8. Estimación

| Pieza                                                                                              | Est.    |
| -------------------------------------------------------------------------------------------------- | ------- |
| Catálogo, migración (perfiles, reglas, cadena, seed «Configuración vigente»), fold, servicio y API | 2–3 d   |
| Cumplimiento en búsqueda, pago, emisión y autos (reemplaza `PlatformProviderFlags`)                | 1.5–2 d |
| Panel superadmin (perfiles, global, nodo, alta)                                                    | 2–3 d   |
| Enlace de pago LATAM (ACL, API, UI de reservas)                                                    | 1–1.5 d |
| Tests: fold, aislamiento entre tenants, rutas clasificadas                                         | 1 d     |

Total: **≈ 7.5–10.5 días**. Se entrega por partes, cada una desplegable sin cortar ventas gracias al perfil «Configuración vigente».
