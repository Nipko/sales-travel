'use client';

import { Archive, Copy, Layers, Pencil, Plus, RefreshCw, Star, StarOff } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '../../../../../../components/ui/badge';
import { Button } from '../../../../../../components/ui/button';
import { Card } from '../../../../../../components/ui/card';
import { Dialog, useConfirm } from '../../../../../../components/ui/dialog';
import { Checkbox, Field, TextInput } from '../../../../../../components/ui/field';
import {
  nodesUsingLabel,
  parseProfileName,
  PROFILE_NAME_MAX,
  PROFILE_NAME_MIN,
  profileSummary,
  type GovernanceProfile,
  type GovernedProvider,
} from '../../../../../../lib/governance';
import {
  archiveProfile,
  duplicateProfile,
  setDefaultProfile,
} from '../../../../../../lib/governance-client';
import { ProfileEditorDialog } from './profile-editor-dialog';

type Editing = { readonly kind: 'new' } | { readonly kind: 'edit'; profile: GovernanceProfile };

/**
 * Los perfiles: conjuntos nombrados de reglas que se asignan a un nodo. Están enlazados: editar
 * uno cambia a todos los nodos que lo usan, por eso cada tarjeta dice cuántos son.
 */
export function ProfilesSection({
  catalog,
  profiles,
  onChanged,
}: {
  catalog: readonly GovernedProvider[];
  profiles: readonly GovernanceProfile[];
  /** Relee la lista: crear, archivar o marcar predeterminado puede mover a otros perfiles. */
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [duplicating, setDuplicating] = useState<GovernanceProfile | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const archivedCount = profiles.filter((p) => p.archived).length;
  const visible = profiles
    .filter((p) => showArchived || !p.archived)
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        Number(b.isDefaultForNewNodes) - Number(a.isDefaultForNewNodes) ||
        a.name.localeCompare(b.name, 'es'),
    );

  const closeEditing = useCallback(() => setEditing(null), []);
  const closeDuplicating = useCallback(() => setDuplicating(null), []);

  async function onArchive(profile: GovernanceProfile) {
    const ok = await confirm({
      title: `¿Archivar «${profile.name}»?`,
      description:
        profile.tenantCount > 0
          ? `${nodesUsingLabel(profile.tenantCount)}: quítaselo o asígnales otro antes de archivarlo.`
          : 'Deja de ofrecerse al asignar perfiles y al dar de alta nodos. Lo puedes duplicar después.',
      confirmLabel: 'Archivar',
    });
    if (!ok) return;
    setBusyId(profile.id);
    const res = await archiveProfile(profile.id);
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    toast.success(`«${profile.name}» quedó archivado.`);
    await onChanged();
  }

  async function onDefault(profile: GovernanceProfile, isDefault: boolean) {
    const ok = await confirm({
      title: isDefault
        ? `¿Usar «${profile.name}» para los nodos nuevos?`
        : `¿Dejar de usar «${profile.name}» para los nodos nuevos?`,
      description: isDefault
        ? 'Se propone al dar de alta un nodo, y se asigna solo cuando un admin de red crea una agencia. Reemplaza al predeterminado actual, si hay. Los nodos que ya existen no cambian.'
        : 'Los nodos nuevos heredan de su padre salvo que elijas un perfil al darlos de alta. Los que ya existen no cambian.',
      confirmLabel: isDefault ? 'Marcar predeterminado' : 'Quitar predeterminado',
      destructive: false,
    });
    if (!ok) return;
    setBusyId(profile.id);
    const res = await setDefaultProfile(profile.id, isDefault);
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    toast.success(
      isDefault
        ? `«${profile.name}» es el perfil de los nodos nuevos.`
        : `«${profile.name}» ya no es el perfil de los nodos nuevos.`,
    );
    await onChanged();
  }

  return (
    <section aria-labelledby="governance-profiles-title" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2
            id="governance-profiles-title"
            className="text-sm font-semibold text-[var(--color-fg)]"
          >
            Perfiles
          </h2>
          <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-[var(--color-fg-muted)]">
            Un perfil es un conjunto de reglas que se asigna a un nodo para no configurarlo
            proveedor por proveedor. Las reglas a mano del nodo le ganan al perfil.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({ kind: 'new' })} className="self-start">
          <Plus aria-hidden="true" />
          Nuevo perfil
        </Button>
      </div>

      {archivedCount > 0 ? (
        <label className="inline-flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
          <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Mostrar archivados ({archivedCount})
        </label>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-10 text-center">
          <Layers
            aria-hidden="true"
            className="mx-auto mb-2 size-6 text-[var(--color-fg-subtle)]"
          />
          <p className="text-sm font-medium text-[var(--color-fg)]">Todavía no hay perfiles.</p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Crea uno, por ejemplo «Agencia Colombia estándar» o «Solo hoteles».
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((profile) => (
            <li key={profile.id}>
              <ProfileCard
                profile={profile}
                busy={busyId === profile.id}
                onEdit={() => setEditing({ kind: 'edit', profile })}
                onDuplicate={() => setDuplicating(profile)}
                onArchive={() => void onArchive(profile)}
                onDefault={(isDefault) => void onDefault(profile, isDefault)}
              />
            </li>
          ))}
        </ul>
      )}

      {editing !== null ? (
        <ProfileEditorDialog
          key={editing.kind === 'edit' ? editing.profile.id : 'new'}
          catalog={catalog}
          profile={editing.kind === 'edit' ? editing.profile : undefined}
          onSaved={(saved, created) => {
            setEditing(null);
            toast.success(
              created ? `Perfil «${saved.name}» creado.` : `Perfil «${saved.name}» guardado.`,
            );
            void onChanged();
          }}
          onClose={closeEditing}
        />
      ) : null}

      {duplicating !== null ? (
        <DuplicateProfileDialog
          key={duplicating.id}
          profile={duplicating}
          onDuplicated={(copy) => {
            setDuplicating(null);
            toast.success(`Perfil «${copy.name}» creado como copia.`);
            void onChanged();
          }}
          onClose={closeDuplicating}
        />
      ) : null}

      {confirmElement}
    </section>
  );
}

function ProfileCard({
  profile,
  busy,
  onEdit,
  onDuplicate,
  onArchive,
  onDefault,
}: {
  profile: GovernanceProfile;
  busy: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onDefault: (isDefault: boolean) => void;
}) {
  return (
    <Card className={profile.archived ? 'p-4 opacity-75 sm:p-5' : 'p-4 sm:p-5'}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
            <span className="break-words">{profile.name}</span>
            {profile.isDefaultForNewNodes ? (
              <Badge>
                <Star aria-hidden="true" />
                Predeterminado para nodos nuevos
              </Badge>
            ) : null}
            {profile.archived ? <Badge>Archivado</Badge> : null}
          </h3>
          {profile.description ? (
            <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {profile.description}
            </p>
          ) : null}
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-fg-muted)]">
            <span className="font-medium text-[var(--color-fg)]">
              {nodesUsingLabel(profile.tenantCount)}
            </span>
            <span>{profileSummary(profile)}</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 md:shrink-0 md:justify-end">
          {!profile.archived ? (
            <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
              <Pencil aria-hidden="true" />
              Editar
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onDuplicate} disabled={busy}>
            <Copy aria-hidden="true" />
            Duplicar
          </Button>
          {!profile.archived ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDefault(!profile.isDefaultForNewNodes)}
                disabled={busy}
              >
                {profile.isDefaultForNewNodes ? (
                  <StarOff aria-hidden="true" />
                ) : (
                  <Star aria-hidden="true" />
                )}
                {profile.isDefaultForNewNodes ? 'Quitar predeterminado' : 'Predeterminado'}
              </Button>
              <Button variant="ghost" size="sm" onClick={onArchive} disabled={busy}>
                {busy ? (
                  <RefreshCw aria-hidden="true" className="animate-spin" />
                ) : (
                  <Archive aria-hidden="true" />
                )}
                Archivar
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function copyName(name: string): string {
  const suffix = ' (copia)';
  return `${name.slice(0, PROFILE_NAME_MAX - suffix.length)}${suffix}`;
}

function DuplicateProfileDialog({
  profile,
  onDuplicated,
  onClose,
}: {
  profile: GovernanceProfile;
  onDuplicated: (copy: GovernanceProfile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => copyName(profile.name));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const formId = useId();
  const invalid =
    parseProfileName(name) === undefined
      ? `El nombre lleva entre ${PROFILE_NAME_MIN} y ${PROFILE_NAME_MAX} caracteres.`
      : undefined;

  const savingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => {
    if (!savingRef.current) onCloseRef.current();
  }, []);

  async function submit() {
    if (savingRef.current) return;
    setSubmitted(true);
    setServerError('');
    if (invalid !== undefined) return;
    savingRef.current = true;
    setSaving(true);
    const res = await duplicateProfile(profile.id, name);
    savingRef.current = false;
    if (!res.ok) {
      setSaving(false);
      setServerError(res.message);
      return;
    }
    onDuplicated(res.data);
  }

  return (
    <Dialog
      open
      onClose={close}
      title={`Duplicar «${profile.name}»`}
      description="La copia nace con la misma matriz y sin nodos asignados. Es un perfil aparte: editarla no cambia el original."
      initialFocus="input"
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <Field label="Nombre de la copia" required error={submitted ? invalid : undefined}>
          {(a11y) => (
            <TextInput
              {...a11y}
              value={name}
              maxLength={PROFILE_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {serverError ? (
          <p
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/6 px-3 py-2 text-xs text-[var(--color-fg)]"
          >
            {serverError}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={close} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <RefreshCw aria-hidden="true" className="animate-spin" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {saving ? 'Duplicando…' : 'Duplicar'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
