'use client';

import { useEffect, useRef, useState } from 'react';
import { Field, Select } from '../../../../../components/ui/field';
import {
  assignableProfiles,
  defaultProfileFor,
  type GovernanceProfile,
} from '../../../../../lib/governance';
import { loadProfiles } from '../../../../../lib/governance-client';
import type { Loaded } from '../../../../../lib/provider-enablement-client';

/**
 * «Perfil de gobierno» en el alta de un nodo (docs/platform/17-opciones-de-pago.md §3.4). Sólo lo
 * ve el superadmin. Arranca en el perfil marcado como predeterminado para nodos nuevos, si hay;
 * «Heredar del padre» no manda nada y el nodo hereda lo que gobierna a su padre.
 */
export function GovernanceProfileField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (profileId: string) => void;
  disabled?: boolean;
}) {
  const [profiles, setProfiles] = useState<Loaded<GovernanceProfile[]> | null>(null);
  const touched = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let alive = true;
    void loadProfiles().then((res) => {
      if (!alive) return;
      setProfiles(res);
      if (res.ok && !touched.current) onChangeRef.current(defaultProfileFor(res.data));
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <GovernanceProfileSelect
      profiles={profiles}
      value={value}
      disabled={disabled}
      onChange={(id) => {
        touched.current = true;
        onChange(id);
      }}
    />
  );
}

export function GovernanceProfileSelect({
  profiles,
  value,
  onChange,
  disabled,
}: {
  /** `null` = cargando. */
  profiles: Loaded<GovernanceProfile[]> | null;
  value: string;
  onChange: (profileId: string) => void;
  disabled?: boolean;
}) {
  const options = profiles?.ok ? assignableProfiles(profiles.data) : [];
  const chosen = options.find((p) => p.id === value);
  const hint =
    profiles === null
      ? 'Cargando perfiles…'
      : !profiles.ok
        ? `No pudimos cargar los perfiles (${profiles.message}). El nodo heredará del padre; puedes asignarle uno después.`
        : chosen?.isDefaultForNewNodes
          ? 'Es el perfil predeterminado para nodos nuevos. Decide qué proveedores y formas de pago puede usar.'
          : chosen !== undefined
            ? 'Decide qué proveedores y formas de pago puede usar. Sus reglas a mano le ganan.'
            : 'Sin perfil, hereda lo que gobierna a su padre.';
  return (
    <Field label="Perfil de gobierno" hint={hint}>
      {(a11y) => (
        <Select
          {...a11y}
          value={chosen === undefined ? '' : value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || profiles === null || !profiles.ok}
        >
          <option value="">Heredar del padre</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.isDefaultForNewNodes ? ' (predeterminado)' : ''}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
