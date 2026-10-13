-- 0066_invitation_pending_unique.sql
-- Una sola invitación pendiente por correo y nodo.
--
-- Qué resuelve: "Invitar usuario" creaba una invitación nueva cada vez, aunque ya hubiera una
-- pendiente para ese correo en el nodo. El admin que no veía llegar el correo volvía a invitar y la
-- persona terminaba con varios enlaces vigentes, cada uno con su rol y su vencimiento; revocar uno
-- dejaba los demás andando. Ahora la API rechaza la segunda con 409 INVITATION_ALREADY_PENDING y le
-- ofrece al admin reenviar la que existe (InvitationsService.invite), y este índice es el respaldo
-- de esa regla ante dos pedidos simultáneos.
--
-- "Pendiente" es lo mismo que en el resto de la API: ni aceptada ni revocada, venza o no. Una vencida
-- se reenvía (enlace nuevo y 7 días más), así que también ocupa el lugar. `email` es CITEXT: el
-- índice no distingue mayúsculas.
--
-- Antes del índice se limpian los duplicados que ya existen. De cada grupo queda la invitación con
-- el enlace más reciente: `expires_at` es el momento del último envío (invitar o reenviar) más los 7
-- días, así que ordena mejor que `created_at` cuál es el correo que la persona probablemente tiene a
-- mano. Las demás se revocan y cada una deja su UserInvitationRevoked con la causa, como cualquier
-- revocación. Los enlaces revocados dejan de funcionar: es aceptable, porque el que queda sigue
-- vigente y se puede reenviar.
--
-- Corre como el dueño de la base (superusuario): la RLS FORCE de user_invitations (0028) no la frena.

WITH ranked AS (
  SELECT i.id,
         row_number() OVER (
           PARTITION BY i.tenant_id, i.email
           ORDER BY i.expires_at DESC, i.created_at DESC, i.id DESC
         ) AS position
    FROM user_invitations i
   WHERE i.accepted_at IS NULL
     AND i.revoked_at IS NULL
),
revoked AS (
  UPDATE user_invitations i
     SET revoked_at = now()
    FROM ranked r
   WHERE r.id = i.id
     AND r.position > 1
  RETURNING i.id, i.tenant_id, i.role
)
INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
SELECT revoked.tenant_id,
       NULL,
       'UserInvitationRevoked',
       'invitation',
       revoked.id::text,
       jsonb_build_object(
         'cause', 'duplicate_cleanup',
         'role', revoked.role,
         'source', 'migration:0066_invitation_pending_unique'
       )
  FROM revoked;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_invitations_pending
  ON user_invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON INDEX uq_user_invitations_pending IS
  'Una invitación pendiente (ni aceptada ni revocada, venza o no) por correo y nodo (0066). La API responde 409 INVITATION_ALREADY_PENDING y ofrece reenviar la existente.';
