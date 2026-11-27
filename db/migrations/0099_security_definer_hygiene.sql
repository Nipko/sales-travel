-- 0099_security_definer_hygiene.sql
-- Las funciones SECURITY DEFINER que la app puede ejecutar: ninguna huérfana y ninguna abierta a
-- PUBLIC (QA-H-42, plan de pruebas SQL-02).
--
-- 1. `accept_invitation(uuid)` y `find_pending_invitation(text)` (0028) quedaron sin uso cuando 0056
--    pasó el canje a `claim_pending_invitation`, pero seguían vivas, como dueño y con EXECUTE para
--    `app_user`. `accept_invitation` marcaba aceptada CUALQUIER invitación por id: sin mirar el
--    nodo, el vencimiento ni la revocación, y por encima de la RLS. La app no la llama, así que
--    hacía falta otra falla (una inyección) para usarla; pero un id de invitación de otra agencia
--    bastaba para inutilizarla. Se borran las dos.
--
-- 2. 0028 y las migraciones anteriores a 0048 no hacían `REVOKE ... FROM PUBLIC`: esas funciones las
--    puede ejecutar cualquier rol de la base, no sólo `app_user`. Hoy no hay otro rol, pero el día
--    que exista uno de lectura (reportes, Grafana) heredaría funciones que leen por encima de la
--    RLS. Se les quita PUBLIC y se le da EXECUTE explícito a `app_user`, que es quien las usa
--    (`is_admin_user()` sólo la tenía por PUBLIC). Las de trigger no se tocan: un trigger no pide
--    EXECUTE para dispararse.
--
-- El test `security-definer.integration.test.ts` vigila las dos reglas en adelante.

DROP FUNCTION IF EXISTS accept_invitation(UUID);
DROP FUNCTION IF EXISTS find_pending_invitation(TEXT);

DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend dep
          WHERE dep.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dep.objid = p.oid
            AND dep.deptype = 'e'
       )
       AND (p.proacl IS NULL
            OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a
                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
  END LOOP;
END;
$$;
