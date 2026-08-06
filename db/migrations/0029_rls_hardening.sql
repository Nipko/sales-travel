-- 0029_rls_hardening.sql
-- Tres huecos de aislamiento detectados en la auditoría de la plataforma.

-- ============================================================================
-- 1. domain_events (audit log) no tenía RLS: legible cross-tenant a nivel base
-- ============================================================================
-- El audit log guarda quién cambió roles, quién tocó credenciales BYOC y quién
-- sobrescribió pricing, de TODAS las agencias de TODAS las redes. Sin RLS, cualquier
-- consulta desde app_user que olvidara filtrar exponía la actividad de consolidadores
-- competidores.
--
-- La lectura se acota al SUBÁRBOL administrado, reutilizando el mismo predicado que ya
-- gobierna memberships (0020). Nótese que can_read_membership() se apoya en
-- app.current_user_id —no en app.current_tenant_id—, que es justo lo que necesita
-- AuditService, cuyas consultas no siempre tienen tenant activo.
COMMENT ON FUNCTION can_read_membership(uuid) IS
  'Predicado genérico de subárbol: ¿el usuario de app.current_user_id administra el tenant dado o alguno de sus ancestros? Lo comparten memberships (0020), user_invitations (0028) y domain_events (0029).';

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY domain_events_subtree_read ON domain_events
  FOR SELECT
  USING (can_read_membership(tenant_id));

-- INSERT deliberadamente permisivo. Razón: AuditService.emit() es best-effort por
-- diseño —un fallo de auditoría nunca debe tumbar la operación de negocio— y se invoca
-- también en contextos sin usuario resoluble (login fallido de un email inexistente,
-- eventos de sistema). Una policy restrictiva aquí convertiría cada hueco de contexto en
-- una PÉRDIDA SILENCIOSA de rastro de auditoría, que es peor que el riesgo que cerraría:
-- la app es el único escritor y el tenant_id lo fija ella, no el cliente. La protección
-- real de esta tabla es de lectura (arriba) y su inmutabilidad (REVOKE UPDATE/DELETE en 0015).
CREATE POLICY domain_events_append ON domain_events
  FOR INSERT
  WITH CHECK (true);

-- Consecuencia conocida y aceptada: los eventos de plataforma (tenant_id IS NULL) dejan
-- de ser visibles para app_user. No hay regresión — AuditService.networkAudit ya los
-- excluía con su INNER JOIN contra tenants. Se consultan por acceso directo a la base.

-- ============================================================================
-- 2. Tres tablas con ENABLE pero sin FORCE ROW LEVEL SECURITY
-- ============================================================================
-- El resto del esquema usa ENABLE + FORCE. Estas tres quedaron a medias, así que si el
-- owner de la tabla llegara a ser el rol de runtime (por un cambio de despliegue o una
-- restauración de backup con otro owner) sus policies dejarían de aplicar sin previo
-- aviso. Se alinean con el resto: defensa en profundidad, sin cambio de comportamiento
-- para app_user, que hoy ya las cumple por no ser el owner.
ALTER TABLE orders            FORCE ROW LEVEL SECURITY;
ALTER TABLE order_operations  FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. memberships_self era FOR ALL: un usuario podía reescribir su propio rol
-- ============================================================================
-- La policy de 0002 se creó para que GET /me/memberships funcionara sin tenant activo,
-- pero se declaró FOR ALL con WITH CHECK (user_id = current_user_id). Ese WITH CHECK
-- restringe DE QUIÉN es la fila, no QUÉ columnas cambian: a nivel base, un UPDATE sobre
-- la propia fila podía elevar `role` a superadmin. Hoy no hay endpoint que lo permita
-- —changeRole valida contra ASSIGNABLE_ROLES— así que es un hueco latente, no una vía
-- explotable, pero deja la garantía fuera de la DB.
--
-- Se acota a FOR SELECT, que es el único uso legítimo. IMPRESCINDIBLE en la misma
-- migración: AuthService.register inserta la membership inicial apoyándose EXCLUSIVAMENTE
-- en el WITH CHECK de esta policy (no setea app.current_tenant_id), así que el alta
-- pública se rompería. El fix del lado app va en auth.service.ts, seteando el GUC del
-- tenant antes del INSERT para que pase por memberships_tenant_isolation.
DROP POLICY IF EXISTS memberships_self ON memberships;

CREATE POLICY memberships_self ON memberships
  FOR SELECT
  USING (user_id::text = current_setting('app.current_user_id', true));

COMMENT ON POLICY memberships_self ON memberships IS
  'Lectura de las propias memberships sin tenant activo (habilita GET /me/memberships). Sólo SELECT: las escrituras pasan por memberships_tenant_isolation.';
