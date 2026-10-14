'use client';

import { Loader2, UserRound } from 'lucide-react';
import { useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../../components/ui/button';
import { Field, TextInput } from '../../../../../components/ui/field';
import { checkPersonName } from '../../../../../lib/person-name';
import { Notice } from '../../seguridad/_components/notice';
import { settleAction } from '../../seguridad/_components/settle-action';
import { updateNameAction } from '../actions';
import { PROFILE_COPY, type ProfileData } from '../profile-model';

/**
 * El nombre y el correo. Se envía desde `onSubmit` y no con `<form action>`: React vacía el
 * formulario al terminar la acción, también cuando falló, y la persona perdía lo que había escrito
 * (como en Seguridad, `use-security-form.ts`).
 *
 * El error va junto al campo (`Field`: `role="alert"`, `aria-invalid` y `aria-describedby`) y el
 * foco vuelve al campo para corregirlo. El éxito se avisa con un toast, que se anuncia solo.
 */
export function ProfileForm({ profile }: { profile: ProfileData }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(profile.name);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  function fail(message: string): void {
    setError(message);
    inputRef.current?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) return;
    const check = checkPersonName(value);
    if (!check.ok) {
      fail(check.error);
      return;
    }
    const data = new FormData();
    data.set('name', check.name);
    startTransition(async () => {
      const result = await settleAction(() => updateNameAction(data));
      // Una acción que redirige (sesión cerrada) no devuelve nada: la navegación ya está en curso.
      if (!result) return;
      if (result.error) {
        fail(result.error);
        return;
      }
      setError(undefined);
      if ('name' in result && result.name) setValue(result.name);
      toast.success(PROFILE_COPY.saved);
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <Field label={PROFILE_COPY.nameLabel} hint={PROFILE_COPY.nameHint} error={error} required>
        {(a11y) => (
          <TextInput
            {...a11y}
            ref={inputRef}
            name="name"
            autoComplete="name"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(undefined);
            }}
            // Sólo lectura y no deshabilitado mientras guarda: un campo deshabilitado no recibe el
            // foco, y si el API dice que el nombre no sirve el foco tiene que volver acá.
            readOnly={pending}
            aria-busy={pending || undefined}
            className="h-11 max-w-md sm:h-9"
          />
        )}
      </Field>

      <dl className="max-w-md space-y-1.5">
        <dt className="text-xs font-semibold text-[var(--color-fg)]">{PROFILE_COPY.emailLabel}</dt>
        <dd className="break-all text-sm text-[var(--color-fg)]">{profile.email}</dd>
        <dd className="text-xs text-[var(--color-fg-muted)]">{PROFILE_COPY.emailNote}</dd>
      </dl>

      <Button type="submit" disabled={pending} className="h-11 w-full sm:h-9 sm:w-auto">
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {pending ? PROFILE_COPY.saving : PROFILE_COPY.save}
      </Button>
    </form>
  );
}

/** La pantalla: título, la tarjeta con el formulario, o el aviso si `GET /me` no respondió. */
export function ProfileScreen({ profile }: { profile: ProfileData | null }) {
  const titleId = useId();
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[var(--color-fg)]">
          {PROFILE_COPY.title}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{PROFILE_COPY.intro}</p>
      </div>

      <section
        aria-labelledby={titleId}
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
      >
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-4 sm:px-5">
          <UserRound className="size-4 shrink-0 text-[var(--color-fg-muted)]" aria-hidden="true" />
          <h2 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
            {PROFILE_COPY.sectionTitle}
          </h2>
        </header>
        <div className="px-4 py-4 sm:px-5 sm:py-5">
          {profile ? (
            <ProfileForm profile={profile} />
          ) : (
            <Notice tone="error">{PROFILE_COPY.loadError}</Notice>
          )}
        </div>
      </section>
    </div>
  );
}
