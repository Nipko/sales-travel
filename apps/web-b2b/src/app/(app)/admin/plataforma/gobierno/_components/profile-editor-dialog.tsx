'use client';

import { AlertTriangle, RefreshCw, Save } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { Button } from '../../../../../../components/ui/button';
import { Dialog } from '../../../../../../components/ui/dialog';
import { Field, Textarea, TextInput } from '../../../../../../components/ui/field';
import {
  choiceAt,
  choicesOf,
  DESCRIPTION_MAX,
  itemKey,
  itemsFromChoices,
  PROFILE_NAME_MAX,
  profileEditWarning,
  profileFormErrors,
  type CellChoice,
  type GovernanceProfile,
  type GovernedProvider,
} from '../../../../../../lib/governance';
import {
  createProfile,
  updateProfile,
  type ProfileDraft,
} from '../../../../../../lib/governance-client';
import { GovernanceMatrix } from '../../../_components/governance-matrix';

/**
 * Crear o editar un perfil: nombre, descripción y la matriz completa. Cada celda es Encendido,
 * Apagado o «No decide» (el perfil no dice nada y decide la herencia). El perfil está enlazado:
 * editarlo cambia a todos los nodos que lo usan, y el aviso lo dice antes de guardar.
 */
export function ProfileEditorDialog({
  catalog,
  profile,
  onSaved,
  onClose,
}: {
  catalog: readonly GovernedProvider[];
  /** `undefined` = perfil nuevo. */
  profile?: GovernanceProfile;
  onSaved: (saved: GovernanceProfile, created: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [choices, setChoices] = useState<Map<string, CellChoice>>(() =>
    choicesOf(profile?.items ?? []),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const formId = useId();
  const errors = submitted ? (profileFormErrors({ name, description }) ?? {}) : {};
  const warning = profile === undefined ? null : profileEditWarning(profile.tenantCount);

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
    if (profileFormErrors({ name, description }) !== undefined) return;
    const draft: ProfileDraft = { name, description, items: itemsFromChoices(catalog, choices) };
    savingRef.current = true;
    setSaving(true);
    const res =
      profile === undefined ? await createProfile(draft) : await updateProfile(profile.id, draft);
    savingRef.current = false;
    if (!res.ok) {
      setSaving(false);
      setServerError(res.message);
      return;
    }
    onSaved(res.data, profile === undefined);
  }

  return (
    <Dialog
      open
      onClose={close}
      title={profile === undefined ? 'Nuevo perfil' : `Editar «${profile.name}»`}
      description="Lo que el perfil no decide queda a lo que herede el nodo de su red o de las reglas globales. Si nadie lo decide, queda apagado."
      className="max-w-3xl"
      initialFocus="input"
      footer={
        <div className="space-y-3">
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
            <Button form={formId} type="submit" disabled={saving}>
              {saving ? (
                <RefreshCw aria-hidden="true" className="animate-spin" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {saving ? 'Guardando…' : profile === undefined ? 'Crear perfil' : 'Guardar cambios'}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-5"
      >
        {warning ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/60 bg-[var(--color-warning)]/12 px-3 py-2 text-xs leading-relaxed text-[var(--color-fg)]"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-muted)]"
            />
            {warning}
          </p>
        ) : null}

        <div className="grid gap-4">
          <Field label="Nombre" required error={errors.name}>
            {(a11y) => (
              <TextInput
                {...a11y}
                value={name}
                maxLength={PROFILE_NAME_MAX}
                placeholder="Agencia Colombia estándar"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Descripción"
            error={errors.description}
            hint="Opcional. Para quién es y qué deja vender."
          >
            {(a11y) => (
              <Textarea
                {...a11y}
                value={description}
                rows={2}
                maxLength={DESCRIPTION_MAX}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
        </div>

        <fieldset className="space-y-3 border-t border-[var(--color-border)] pt-4">
          <legend className="sr-only">Proveedores y formas de pago del perfil</legend>
          <p aria-hidden="true" className="text-xs font-semibold text-[var(--color-fg)]">
            Proveedores y formas de pago
          </p>
          <GovernanceMatrix
            catalog={catalog}
            choiceAt={(key) => choiceAt(choices, key)}
            onChange={(key, choice) =>
              setChoices((current) => {
                const next = new Map(current);
                if (choice === 'unset') next.delete(itemKey(key));
                else next.set(itemKey(key), choice);
                return next;
              })
            }
            labels={{ unset: 'No decide' }}
            scopeLabel="en el perfil"
            disabled={saving}
          />
        </fieldset>
      </form>
    </Dialog>
  );
}
