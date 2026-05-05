'use client';

import { Building2, Globe, Loader2, Palette, Save, Upload, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/cn';

// --- Types ---
interface TenantConfig {
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  defaultLanguage: string;
}

interface Branding {
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

// --- Constants ---
const TABS = [
  { id: 'general', label: 'General', icon: Building2 },
  { id: 'branding', label: 'Branding', icon: Palette },
  { id: 'domain', label: 'Dominio', icon: Globe },
  { id: 'team', label: 'Equipo', icon: Users },
] as const;

type TabId = (typeof TABS)[number]['id'];

const COLOR_PRESETS = [
  '#2563eb',
  '#7c3aed',
  '#dc2626',
  '#059669',
  '#d97706',
  '#0891b2',
  '#4f46e5',
  '#be185d',
  '#1d4ed8',
  '#0f766e',
];

// --- Page ---
export default function ConfiguracionPage() {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [branding, setBranding] = useState<Branding>({
    logoUrl: null,
    primaryColor: null,
    accentColor: null,
  });
  const [config, setConfig] = useState<TenantConfig>({
    name: '',
    slug: '',
    countryCode: '',
    defaultCurrency: '',
    defaultLanguage: 'es',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch('/api/tenant/branding')
        .then((r) => r.json() as Promise<Branding>)
        .catch(() => null),
      fetch('/api/tenant/config')
        .then((r) => r.json() as Promise<TenantConfig>)
        .catch(() => null),
    ]).then(([b, c]) => {
      if (b) setBranding(b);
      if (c) setConfig(c);
      setLoading(false);
    });
  }, []);

  async function handleSaveBranding() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/tenant/branding', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(branding),
      });
      if (res.ok) {
        setMessage({ text: 'Branding guardado. Recarga para ver los cambios.', success: true });
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
      <div className="mx-auto max-w-3xl px-5 py-8">
        <div className="animate-pulse space-y-6">
          <div className="h-7 w-48 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-10 w-full rounded-lg bg-[var(--color-surface-muted)]" />
          <div className="h-64 rounded-xl bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
          Configuracion
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Gestiona la identidad y preferencias de tu workspace.
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-8 flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-all',
                activeTab === tab.id
                  ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
              )}
            >
              <Icon className="size-3.5" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === 'general' && <GeneralTab config={config} setConfig={setConfig} />}
      {activeTab === 'branding' && (
        <BrandingTab
          branding={branding}
          setBranding={setBranding}
          onSave={() => void handleSaveBranding()}
          saving={saving}
          message={message}
        />
      )}
      {activeTab === 'domain' && <DomainTab config={config} />}
      {activeTab === 'team' && <TeamTab />}
    </div>
  );
}

// --- General Tab ---
function GeneralTab({
  config,
  setConfig,
}: {
  config: TenantConfig;
  setConfig: (c: TenantConfig) => void;
}) {
  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          title="Informacion general"
          description="Datos basicos de tu agencia o workspace."
        />
        <div className="mt-5 space-y-5">
          <FormField label="Nombre de la agencia" required>
            <input
              type="text"
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              placeholder="Mi Agencia de Viajes"
              className="form-input"
            />
          </FormField>

          <FormField label="Slug" helper="Identificador unico. Se usa en la URL del workspace.">
            <input
              type="text"
              value={config.slug}
              disabled
              className="form-input opacity-50 cursor-not-allowed"
            />
          </FormField>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <FormField label="Pais">
              <select
                value={config.countryCode}
                onChange={(e) => setConfig({ ...config, countryCode: e.target.value })}
                className="form-input"
              >
                <option value="CO">Colombia</option>
                <option value="PE">Peru</option>
                <option value="BR">Brasil</option>
                <option value="MX">Mexico</option>
                <option value="CL">Chile</option>
                <option value="AR">Argentina</option>
              </select>
            </FormField>

            <FormField label="Moneda">
              <select
                value={config.defaultCurrency}
                onChange={(e) => setConfig({ ...config, defaultCurrency: e.target.value })}
                className="form-input"
              >
                <option value="COP">COP</option>
                <option value="USD">USD</option>
                <option value="PEN">PEN</option>
                <option value="BRL">BRL</option>
                <option value="MXN">MXN</option>
              </select>
            </FormField>

            <FormField label="Idioma">
              <select
                value={config.defaultLanguage}
                onChange={(e) => setConfig({ ...config, defaultLanguage: e.target.value })}
                className="form-input"
              >
                <option value="es">Espanol</option>
                <option value="pt">Portugues</option>
                <option value="en">Ingles</option>
              </select>
            </FormField>
          </div>
        </div>
      </section>
    </div>
  );
}

// --- Branding Tab ---
function BrandingTab({
  branding,
  setBranding,
  onSave,
  saving,
  message,
}: {
  branding: Branding;
  setBranding: (b: Branding) => void;
  onSave: () => void;
  saving: boolean;
  message: { text: string; success: boolean } | null;
}) {
  return (
    <div className="space-y-8">
      {/* Logo */}
      <section>
        <SectionHeader title="Logo" description="Se muestra en el sidebar y correos." />
        <div className="mt-5">
          {branding.logoUrl ? (
            <div className="flex items-center gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <img
                src={branding.logoUrl}
                alt="Logo preview"
                className="size-14 rounded-lg border border-[var(--color-border)] bg-white object-contain p-1"
              />
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium text-[var(--color-fg)]">Logo actual</p>
                <p className="truncate text-xs text-[var(--color-fg-subtle)]">{branding.logoUrl}</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBranding({ ...branding, logoUrl: null })}
              >
                Quitar
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] px-6 py-10 transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-muted)]">
              <Upload className="mb-3 size-8 text-[var(--color-fg-subtle)]" />
              <p className="text-sm font-medium text-[var(--color-fg)]">Sube tu logo</p>
              <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                PNG, SVG, JPG — recomendado 200x200px
              </p>
            </div>
          )}
          <div className="mt-3">
            <FormField label="O pega una URL">
              <input
                type="url"
                value={branding.logoUrl ?? ''}
                onChange={(e) => setBranding({ ...branding, logoUrl: e.target.value || null })}
                placeholder="https://tu-agencia.com/logo.png"
                className="form-input"
              />
            </FormField>
          </div>
        </div>
      </section>

      {/* Primary Color */}
      <section className="border-t border-[var(--color-border)] pt-8">
        <SectionHeader
          title="Color primario"
          description="Botones, links y elementos activos. Define la personalidad de tu marca."
        />
        <div className="mt-5 space-y-4">
          {/* Presets */}
          <div className="flex flex-wrap gap-2">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setBranding({ ...branding, primaryColor: color })}
                className={cn(
                  'size-9 rounded-lg border-2 transition-all hover:scale-110',
                  branding.primaryColor === color
                    ? 'border-[var(--color-fg)] ring-2 ring-[var(--color-fg)]/10 scale-110'
                    : 'border-transparent',
                )}
                style={{ backgroundColor: color }}
                aria-label={`Color ${color}`}
                aria-pressed={branding.primaryColor === color}
              />
            ))}
          </div>

          {/* Custom input */}
          <div className="flex items-center gap-3">
            <div
              className="size-10 shrink-0 rounded-lg border border-[var(--color-border)]"
              style={{ backgroundColor: branding.primaryColor ?? '#2563eb' }}
            />
            <input
              type="text"
              value={branding.primaryColor ?? ''}
              onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value || null })}
              placeholder="#2563eb"
              className="form-input flex-1 font-mono"
            />
            <input
              type="color"
              value={branding.primaryColor ?? '#2563eb'}
              onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
              className="size-10 cursor-pointer rounded-lg border border-[var(--color-border)] p-0.5"
            />
          </div>
        </div>
      </section>

      {/* Accent Color */}
      <section className="border-t border-[var(--color-border)] pt-8">
        <SectionHeader
          title="Color de acento"
          description="Badges, notificaciones y elementos secundarios."
        />
        <div className="mt-5">
          <div className="flex items-center gap-3">
            <div
              className="size-10 shrink-0 rounded-lg border border-[var(--color-border)]"
              style={{ backgroundColor: branding.accentColor ?? '#f59e0b' }}
            />
            <input
              type="text"
              value={branding.accentColor ?? ''}
              onChange={(e) => setBranding({ ...branding, accentColor: e.target.value || null })}
              placeholder="#f59e0b"
              className="form-input flex-1 font-mono"
            />
            <input
              type="color"
              value={branding.accentColor ?? '#f59e0b'}
              onChange={(e) => setBranding({ ...branding, accentColor: e.target.value })}
              className="size-10 cursor-pointer rounded-lg border border-[var(--color-border)] p-0.5"
            />
          </div>
        </div>
      </section>

      {/* Live Preview */}
      {(branding.primaryColor || branding.logoUrl) && (
        <section className="border-t border-[var(--color-border)] pt-8">
          <SectionHeader title="Preview" description="Asi se vera tu marca en la plataforma." />
          <div className="mt-5 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
            <div className="flex h-12 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
              {branding.logoUrl ? (
                <img src={branding.logoUrl} alt="" className="size-6 rounded object-contain" />
              ) : (
                <div
                  className="flex size-6 items-center justify-center rounded text-[9px] font-bold text-white"
                  style={{ backgroundColor: branding.primaryColor ?? '#2563eb' }}
                >
                  AG
                </div>
              )}
              <span className="text-xs font-medium text-[var(--color-fg)]">Mi Agencia</span>
            </div>
            <div className="flex items-center gap-3 p-5">
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ backgroundColor: branding.primaryColor ?? '#2563eb' }}
              >
                Boton primario
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-[var(--color-fg)]"
              >
                Secundario
              </button>
              {branding.accentColor && (
                <span
                  className="rounded-full px-3 py-1 text-xs font-medium"
                  style={{
                    backgroundColor: `${branding.accentColor}20`,
                    color: branding.accentColor,
                  }}
                >
                  Badge
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Save footer */}
      <div className="sticky bottom-0 -mx-5 border-t border-[var(--color-border)] bg-[var(--color-bg)]/80 px-5 py-4 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          {message && (
            <p
              className={cn(
                'text-xs',
                message.success ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]',
              )}
            >
              {message.text}
            </p>
          )}
          <div className="ml-auto">
            <Button onClick={onSave} disabled={saving} className="gap-2">
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {saving ? 'Guardando...' : 'Guardar branding'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Domain Tab ---
function DomainTab({ config }: { config: TenantConfig }) {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Dominio personalizado"
        description="Configura un dominio propio para tu workspace."
      />
      <div className="mt-5 space-y-5">
        <FormField label="Subdominio actual">
          <div className="flex items-center gap-0">
            <input
              type="text"
              value={config.slug}
              disabled
              className="form-input rounded-r-none border-r-0 opacity-60"
            />
            <span className="inline-flex items-center rounded-r-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-fg-muted)]">
              .planetour.cloud
            </span>
          </div>
        </FormField>

        <FormField label="Dominio personalizado" helper="Apunta un CNAME a: app.planetour.cloud">
          <input type="text" placeholder="viajes.tuagencia.com" className="form-input" />
        </FormField>
      </div>
    </div>
  );
}

// --- Team Tab ---
function TeamTab() {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Miembros del equipo"
        description="Gestiona quienes tienen acceso a este workspace."
      />
      <div className="mt-5 rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-12 text-center">
        <Users className="mx-auto mb-3 size-8 text-[var(--color-fg-subtle)]" />
        <p className="text-sm font-medium text-[var(--color-fg)]">Gestion de equipo</p>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Invita vendedores, managers y administradores. Disponible pronto.
        </p>
      </div>
    </div>
  );
}

// --- Reusable components ---
function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-[var(--color-fg)]">{title}</h2>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{description}</p>
    </div>
  );
}

function FormField({
  label,
  helper,
  required,
  children,
}: {
  label: string;
  helper?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-[var(--color-fg)]">
        {label}
        {required && (
          <span className="ml-0.5 text-[var(--color-danger)]" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {helper && <p className="text-xs text-[var(--color-fg-subtle)]">{helper}</p>}
    </div>
  );
}
