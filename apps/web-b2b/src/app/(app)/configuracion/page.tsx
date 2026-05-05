'use client';

import { Palette, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button';

interface Branding {
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

export default function ConfiguracionPage() {
  const [branding, setBranding] = useState<Branding>({
    logoUrl: null,
    primaryColor: null,
    accentColor: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null);

  useEffect(() => {
    fetch('/api/tenant/branding')
      .then((r) => r.json() as Promise<Branding>)
      .then((data) => setBranding(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/tenant/branding', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(branding),
      });
      if (res.ok) {
        setMessage({
          text: 'Branding actualizado. Recarga la pagina para ver los cambios.',
          success: true,
        });
      } else {
        setMessage({ text: 'Error al guardar', success: false });
      }
    } catch {
      setMessage({ text: 'Error de conexion', success: false });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-6 w-40 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-40 rounded-xl bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
          Configuracion
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Personaliza la marca y apariencia de tu agencia.
        </p>
      </div>

      <div className="space-y-6">
        {/* Branding Section */}
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Palette className="size-4 text-[var(--color-primary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Branding</h2>
          </div>

          <div className="space-y-4">
            {/* Logo URL */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
                Logo URL
              </label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={branding.logoUrl ?? ''}
                  onChange={(e) => setBranding({ ...branding, logoUrl: e.target.value || null })}
                  placeholder="https://tu-agencia.com/logo.png"
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-primary)] focus:outline-none"
                />
                {branding.logoUrl && (
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
                    <img
                      src={branding.logoUrl}
                      alt="Preview"
                      className="size-6 rounded object-contain"
                    />
                  </div>
                )}
              </div>
              <p className="mt-1 text-[10px] text-[var(--color-fg-subtle)]">
                Se muestra en la barra superior. Recomendado: 128x128px, fondo transparente.
              </p>
            </div>

            {/* Primary Color */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
                Color primario
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={branding.primaryColor ?? '#2563eb'}
                  onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                  className="size-9 cursor-pointer rounded-md border border-[var(--color-border)]"
                />
                <input
                  type="text"
                  value={branding.primaryColor ?? ''}
                  onChange={(e) =>
                    setBranding({ ...branding, primaryColor: e.target.value || null })
                  }
                  placeholder="#2563eb o oklch(0.46 0.16 250)"
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-primary)] focus:outline-none"
                />
              </div>
              <p className="mt-1 text-[10px] text-[var(--color-fg-subtle)]">
                Botones, links y elementos activos. Acepta hex o oklch.
              </p>
            </div>

            {/* Accent Color */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
                Color de acento
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={branding.accentColor ?? '#f59e0b'}
                  onChange={(e) => setBranding({ ...branding, accentColor: e.target.value })}
                  className="size-9 cursor-pointer rounded-md border border-[var(--color-border)]"
                />
                <input
                  type="text"
                  value={branding.accentColor ?? ''}
                  onChange={(e) =>
                    setBranding({ ...branding, accentColor: e.target.value || null })
                  }
                  placeholder="#f59e0b o oklch(0.74 0.15 60)"
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-primary)] focus:outline-none"
                />
              </div>
            </div>

            {/* Preview */}
            {(branding.primaryColor || branding.logoUrl) && (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                <p className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Preview
                </p>
                <div className="flex items-center gap-3">
                  {branding.logoUrl && (
                    <img src={branding.logoUrl} alt="" className="size-8 rounded object-contain" />
                  )}
                  <div
                    className="rounded-md px-4 py-2 text-sm font-medium text-white"
                    style={{ backgroundColor: branding.primaryColor ?? '#2563eb' }}
                  >
                    Boton primario
                  </div>
                  {branding.accentColor && (
                    <div
                      className="rounded-md px-4 py-2 text-sm font-medium"
                      style={{ backgroundColor: branding.accentColor, color: '#1a1a1a' }}
                    >
                      Acento
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Save */}
        <div className="flex items-center justify-between">
          {message && (
            <p
              className={`text-xs ${message.success ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}
            >
              {message.text}
            </p>
          )}
          <div className="ml-auto">
            <Button onClick={() => void handleSave()} disabled={saving} className="gap-2">
              <Save className="size-3.5" />
              {saving ? 'Guardando...' : 'Guardar branding'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
