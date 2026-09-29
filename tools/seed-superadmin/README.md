# seed-superadmin

Deja al superadmin en la plataforma. La plataforma es Planetour: el tenant de tipo `platform`, raíz única de la red
(D4 A, migraciones 0049 y 0050). El superadmin ve y ajusta toda la red y **no vende** (Planetour vende con sus
sucursales). Es one-shot e idempotente y se corre a mano en el VPS. El comando exacto está en
[`infrastructure/hostinger/README.md`](../../infrastructure/hostinger/README.md) §7.

## Qué hace

Todo en una transacción: o queda todo, o nada.

| Qué                                                | Cómo                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant `SUPERADMIN_TENANT_SLUG`: ya es `platform`  | Lo usa tal cual.                                                                                                                                                                                                                                                                               |
| Tenant `SUPERADMIN_TENANT_SLUG`: raíz de otro tipo | Lo promueve a `platform`: sólo cambia `tenant_type`, como 0049. El nombre, el estado, la marca y las cuentas quedan como están. Así queda Planetour si 0049 no lo hizo.                                                                                                                        |
| Tenant `SUPERADMIN_TENANT_SLUG`: no existe         | Lo crea como `platform` con `SUPERADMIN_TENANT_NAME` (obligatoria en ese caso), `SUPERADMIN_TENANT_COUNTRY` y `SUPERADMIN_TENANT_CURRENCY`. Es el caso de una base nueva.                                                                                                                      |
| Usuario `SUPERADMIN_EMAIL`: existe                 | Lo usa tal cual. **No** le cambia la contraseña, el nombre ni el estado: rotar la contraseña cerraría sus sesiones y, con un correo equivocado, sería tomarle la cuenta a otro. Si llega `SUPERADMIN_PASSWORD`, la ignora (`"passwordIgnored": true`).                                         |
| Usuario `SUPERADMIN_EMAIL`: no existe              | Lo crea con `SUPERADMIN_PASSWORD` (bcrypt de 12 rondas, como el api) y `SUPERADMIN_NAME`, las dos obligatorias en ese caso, con el correo verificado.                                                                                                                                          |
| Membership del usuario en la plataforma            | Pasa a `superadmin` activa (en producción era `consolidator_admin`), o se crea. Sus memberships en otros nodos no se tocan.                                                                                                                                                                    |
| Auditoría (`domain_events`)                        | Un evento por cambio, sin actor y con `payload.source = "seed-superadmin"`: `tenant.type.changed` (como 0049), `TenantCreated`, `UserCreated` y `MembershipRoleChanged` con el antes y el después (como la API). Ni el correo ni la contraseña en el payload. Si nada cambió, no escribe nada. |

## Se niega cuando

Sale con `1` y una línea JSON con `reason`. No escribe nada.

- `not_privileged`: la sesión no es superusuario ni `BYPASSRLS`. Con RLS no vería todas las memberships.
- `tenant_has_parent`: el tenant cuelga de otro nodo. La plataforma es raíz, y mover nodos lo decide el superadmin.
- `another_platform`: la base ya tiene otra plataforma. Hay una sola, y el mensaje dice cuál es: corre el seed con su
  slug.
- `tenant_promotion_blocked`: la jerarquía rechaza la promoción (STH01 de 0050). Por ejemplo, el tenant tiene
  sub-agencias, que no pueden colgar de la plataforma.
- `concurrent_change`: otro proceso creó el tenant, la plataforma o el usuario mientras corría. Vuelve a correrlo.

Si falta una variable que la base exige, sale con `SeedConfigError` y **todas** las que faltan de una vez:
`SUPERADMIN_TENANT_NAME:required_to_create_tenant`, `SUPERADMIN_PASSWORD:required_to_create_user` y
`SUPERADMIN_NAME:required_to_create_user`.

## Variables

| Variable                                       | Obligatoria                  | Por defecto                 |
| ---------------------------------------------- | ---------------------------- | --------------------------- |
| `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Sí (el superusuario)         | —                           |
| `PGPORT`                                       | No                           | `5432`                      |
| `SUPERADMIN_EMAIL`                             | Sí                           | —                           |
| `SUPERADMIN_PASSWORD`                          | Sólo si el usuario no existe | — (12 caracteres, 72 bytes) |
| `SUPERADMIN_NAME`                              | Sólo si el usuario no existe | —                           |
| `SUPERADMIN_TENANT_SLUG`                       | No                           | `platform`                  |
| `SUPERADMIN_TENANT_NAME`                       | Sólo si el tenant no existe  | —                           |
| `SUPERADMIN_TENANT_COUNTRY`                    | No (sólo al crear)           | `CO`                        |
| `SUPERADMIN_TENANT_CURRENCY`                   | No (sólo al crear)           | `USD`                       |

Una variable vacía (`-e X=`) cuenta como no enviada. La contraseña nunca va en la línea de comandos: se exporta y se pasa
con `-e SUPERADMIN_PASSWORD` sin valor.

## Salida

Una línea JSON en stderr:

- Con `ok: true`: los ids y lo que cambió (`tenant`, `user`, `membership`, `previousRole`, `tenantStatus`,
  `userStatus`, `passwordIgnored`).
- Con `ok: false`: el error (`reason` o `issues`).

Nunca imprime el correo ni una contraseña.

Si `tenantStatus` o `userStatus` no es `active`, el superadmin no puede entrar hasta corregirlo. El seed deja activa la
membership, pero no reactiva ni el tenant ni la cuenta.

## Tests

- `pnpm test`: unitarios (env, CLI y el orden de escrituras y negativas con un doble de `pg`).
- `seed.integration.test.ts`: corre contra Postgres con las migraciones y se salta sin `PG*`.
  - En CI usa la base compartida: cada caso corre en una transacción que se deshace.
  - Los casos que necesitan una base sin plataforma, como producción antes de 0049 o una base nueva, la ocultan dentro
    de esa transacción.
