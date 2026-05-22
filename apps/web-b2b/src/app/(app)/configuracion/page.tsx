'use client';

import { Building2, Globe, Loader2, Palette, Save, Upload, Users, Shield, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
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
  { id: 'branding', label: 'Branding (Identidad)', icon: Palette },
  { id: 'domain', label: 'Dominio', icon: Globe },
  { id: 'team', label: 'Equipo', icon: Users },
] as const;

type TabId = (typeof TABS)[number]['id'];

const COLOR_PRESETS = [
  '#e37b23', // Naranja Planetour Premium
  '#2563eb', // Azul Vercel
  '#7c3aed', // Púrpura Linear
  '#059669', // Esmeralda Stripe
  '#d97706', // Ámbar Cálido
  '#0f355c', // Azul Medianoche GDS
  '#4f46e5', // Índigo Moderno
  '#be185d', // Rosa Intenso
  '#0f766e', // Teal Elegante
  '#1e293b', // Grafito/Pizarra
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

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

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
        setMessage({ text: 'Identidad corporativa guardada. Recargue la página para aplicar los cambios.', success: true });
      } else {
        setMessage({ text: 'Error al guardar la configuración.', success: false });
      }
    } catch {
      setMessage({ text: 'Error de conexión con el servidor.', success: false });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="animate-pulse space-y-6">
          <div className="h-4 w-24 rounded bg-slate-200" />
          <div className="h-8 w-48 rounded bg-slate-200" />
          <div className="h-10 w-full rounded-xl bg-slate-200" />
          <div className="h-64 rounded-2xl bg-slate-100" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 space-y-8 animate-fade-in-up">
      {/* Header Sección */}
      <header className="flex flex-col gap-1.5">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary)]/10 px-2.5 py-0.5 text-[10px] font-bold text-[var(--color-primary)] uppercase tracking-wider w-fit">
          <Shield className="size-3" />
          Configuración del Sistema
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)] mt-1.5">
          Configuración de la Agencia
        </h1>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Gestione la identidad visual, preferencias del sistema y dominios personalizados de su workspace.
        </p>
      </header>

      {/* Tabs - Segmented Control Moderno */}
      <div className="flex gap-1 rounded-xl border border-slate-200/50 bg-slate-100/80 p-1 shadow-[var(--shadow-xs)]">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold transition-all duration-200 cursor-pointer',
                activeTab === tab.id
                  ? 'bg-white text-slate-800 shadow-[var(--shadow-sm)] border border-slate-200/40'
                  : 'text-slate-500 hover:text-slate-800'
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content wrapped in Premium visual containers */}
      <div className="space-y-6">
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
    <Card className="border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden">
      <CardContent className="p-6 space-y-6">
        <SectionHeader
          title="Información general"
          description="Datos básicos de identificación y operación de su agencia de viajes."
        />
        
        <div className="space-y-5">
          <FormField label="Nombre de la agencia" required helper="Nombre legal o comercial visible en la plataforma.">
            <input
              type="text"
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              placeholder="Ej. Viajes Planetour S.A.S"
              className="form-input shadow-[var(--shadow-xs)]"
            />
          </FormField>

          <FormField label="Identificador único (Slug)" helper="Identificador en base de datos. No editable por seguridad.">
            <input
              type="text"
              value={config.slug}
              disabled
              className="form-input opacity-50 cursor-not-allowed bg-slate-50 font-mono text-xs"
            />
          </FormField>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3 border-t border-slate-100 pt-5">
            <FormField label="País de Operación">
              <select
                value={config.countryCode}
                onChange={(e) => setConfig({ ...config, countryCode: e.target.value })}
                className="form-input cursor-pointer"
              >
                <option value="CO">Colombia</option>
                <option value="PE">Perú</option>
                <option value="BR">Brasil</option>
                <option value="MX">México</option>
                <option value="CL">Chile</option>
                <option value="AR">Argentina</option>
              </select>
            </FormField>

            <FormField label="Moneda Base">
              <select
                value={config.defaultCurrency}
                onChange={(e) => setConfig({ ...config, defaultCurrency: e.target.value })}
                className="form-input cursor-pointer font-mono"
              >
                <option value="COP">COP ($)</option>
                <option value="USD">USD ($)</option>
                <option value="PEN">PEN (S/.)</option>
                <option value="BRL">BRL (R$)</option>
                <option value="MXN">MXN ($)</option>
              </select>
            </FormField>

            <FormField label="Idioma Preferido">
              <select
                value={config.defaultLanguage}
                onChange={(e) => setConfig({ ...config, defaultLanguage: e.target.value })}
                className="form-input cursor-pointer"
              >
                <option value="es">Español (ES)</option>
                <option value="pt">Portugués (PT)</option>
                <option value="en">Inglés (EN)</option>
              </select>
            </FormField>
          </div>
        </div>
      </CardContent>
    </Card>
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
    <div className="space-y-6">
      {/* Sección Logo */}
      <Card className="border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden">
        <CardContent className="p-6 space-y-5">
          <SectionHeader 
            title="Logotipo Corporativo" 
            description="Suba el logo oficial de su marca. Se utilizará en la barra lateral, reportes y cotizaciones por correo." 
          />
          
          <div className="space-y-4">
            {branding.logoUrl ? (
              <div className="flex items-center gap-4 rounded-xl border border-slate-200/60 bg-slate-50/50 p-4 shadow-inner">
                <img
                  src={branding.logoUrl}
                  alt="Previsualización del logo"
                  className="size-16 rounded-lg border border-slate-200 bg-white object-contain p-1.5 shadow-sm"
                />
                <div className="flex-1 min-w-0">
                  <p className="truncate text-xs font-bold text-slate-800">Logo actual activo</p>
                  <p className="truncate text-[10px] text-slate-500 font-mono mt-0.5">{branding.logoUrl}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setBranding({ ...branding, logoUrl: null })}
                  className="border-slate-200 text-slate-600 hover:bg-slate-100"
                >
                  Quitar logo
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/30 px-6 py-10 transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/[0.02]">
                <Upload className="mb-3 size-8 text-slate-400" />
                <p className="text-xs font-bold text-slate-700">Arrastre o seleccione su logotipo</p>
                <p className="mt-1 text-[10px] text-slate-500">
                  Formatos recomendados: PNG, SVG de fondo transparente (200x200px)
                </p>
              </div>
            )}
            
            <FormField label="URL del logotipo (Alternativa)">
              <input
                type="url"
                value={branding.logoUrl ?? ''}
                onChange={(e) => setBranding({ ...branding, logoUrl: e.target.value || null })}
                placeholder="https://ejemplo.com/logotipo-marca.png"
                className="form-input shadow-[var(--shadow-xs)]"
              />
            </FormField>
          </div>
        </CardContent>
      </Card>

      {/* Sección Colores de Marca */}
      <Card className="border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden">
        <CardContent className="p-6 space-y-6">
          <SectionHeader
            title="Colores Corporativos"
            description="Personalice la experiencia visual adaptando los botones, alertas y acentos a los colores de su marca."
          />
          
          <div className="space-y-6">
            {/* Color Primario */}
            <div className="space-y-3.5">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Color Primario (Botones, elementos interactivos principales)
              </label>
              
              {/* Ajuste de paleta recomendada */}
              <div className="flex flex-wrap gap-2">
                {COLOR_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setBranding({ ...branding, primaryColor: color })}
                    className={cn(
                      'size-9 rounded-lg border-2 transition-all duration-200 hover:scale-105 shadow-sm cursor-pointer',
                      branding.primaryColor === color
                        ? 'border-slate-800 ring-4 ring-slate-800/10 scale-105'
                        : 'border-white'
                    )}
                    style={{ backgroundColor: color }}
                    aria-label={`Seleccionar color ${color}`}
                  />
                ))}
              </div>

              {/* Selector e Input de color primario */}
              <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
                <div
                  className="size-10 shrink-0 rounded-lg border border-slate-200 shadow-sm"
                  style={{ backgroundColor: branding.primaryColor ?? '#e37b23' }}
                />
                <input
                  type="text"
                  value={branding.primaryColor ?? ''}
                  onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value || null })}
                  placeholder="#e37b23"
                  className="form-input flex-1 font-mono text-xs shadow-[var(--shadow-xs)]"
                />
                <input
                  type="color"
                  value={branding.primaryColor ?? '#e37b23'}
                  onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                  className="size-10 cursor-pointer rounded-lg border border-slate-200 p-0.5 hover:scale-[1.02] transition-transform"
                />
              </div>
            </div>

            {/* Color Acento */}
            <div className="space-y-3.5 border-t border-slate-100 pt-5">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Color de Acento (Badges, notificaciones y elementos secundarios)
              </label>
              <div className="flex items-center gap-3">
                <div
                  className="size-10 shrink-0 rounded-lg border border-slate-200 shadow-sm"
                  style={{ backgroundColor: branding.accentColor ?? '#0f355c' }}
                />
                <input
                  type="text"
                  value={branding.accentColor ?? ''}
                  onChange={(e) => setBranding({ ...branding, accentColor: e.target.value || null })}
                  placeholder="#0f355c"
                  className="form-input flex-1 font-mono text-xs shadow-[var(--shadow-xs)]"
                />
                <input
                  type="color"
                  value={branding.accentColor ?? '#0f355c'}
                  onChange={(e) => setBranding({ ...branding, accentColor: e.target.value })}
                  className="size-10 cursor-pointer rounded-lg border border-slate-200 p-0.5 hover:scale-[1.02] transition-transform"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Previsualización en Vivo */}
      {(branding.primaryColor || branding.logoUrl) && (
        <Card className="border border-[var(--color-border)]/50 bg-slate-50/20 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden">
          <CardContent className="p-6 space-y-4">
            <SectionHeader title="Previsualización en tiempo real" description="Previsualice cómo se adaptará la interfaz con los colores y logotipo cargados." />
            
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-[var(--color-bg)] shadow-[var(--shadow-sm)]">
              {/* Simulador de cabecera */}
              <div className="flex h-12 items-center gap-3 border-b border-slate-100 bg-white px-4">
                {branding.logoUrl ? (
                  <img src={branding.logoUrl} alt="" className="size-6 rounded object-contain" />
                ) : (
                  <div
                    className="flex size-6 items-center justify-center rounded text-[9px] font-bold text-white shadow-sm"
                    style={{ backgroundColor: branding.primaryColor ?? '#e37b23' }}
                  >
                    AG
                  </div>
                )}
                <span className="text-xs font-semibold text-slate-800">Mi Agencia de Viajes</span>
              </div>
              
              {/* Simulador de cuerpo con botones */}
              <div className="flex flex-wrap items-center gap-3.5 p-5 bg-slate-50/40">
                <button
                  type="button"
                  className="rounded-lg px-4 py-2 text-xs font-bold text-white shadow-md active:scale-95 transition-all"
                  style={{ backgroundColor: branding.primaryColor ?? '#e37b23' }}
                >
                  Botón Primario
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Botón Secundario
                </button>
                {branding.accentColor && (
                  <span
                    className="rounded-full px-2.5 py-0.5 text-[10px] font-bold border"
                    style={{
                      backgroundColor: `${branding.accentColor}12`,
                      color: branding.accentColor,
                      borderColor: `${branding.accentColor}25`,
                    }}
                  >
                    Badge secundario
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Floating Save Footer - Glassmorphic */}
      <div className="sticky bottom-0 -mx-6 border-t border-slate-200/60 bg-white/80 px-6 py-4.5 backdrop-blur-md z-10 rounded-b-xl flex items-center justify-between shadow-[0_-4px_12px_rgba(0,0,0,0.03)]">
        {message ? (
          <div className={cn(
            'flex items-center gap-1.5 text-xs font-semibold',
            message.success ? 'text-emerald-600' : 'text-rose-600'
          )}>
            {message.success ? <CheckCircle2 className="size-4 shrink-0" /> : <AlertCircle className="size-4 shrink-0" />}
            <span>{message.text}</span>
          </div>
        ) : (
          <div className="text-xs text-slate-400 font-medium">Configure los cambios antes de guardar</div>
        )}
        <div className="ml-auto">
          <Button onClick={onSave} disabled={saving} className="gap-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white shadow-md transition-all duration-200 font-semibold cursor-pointer">
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            {saving ? 'Guardando...' : 'Guardar identidad'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Domain Tab ---
function DomainTab({ config }: { config: TenantConfig }) {
  return (
    <Card className="border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden">
      <CardContent className="p-6 space-y-5">
        <SectionHeader
          title="Dominio personalizado"
          description="Apunta un subdominio o dominio propio de su agencia para brindar un aspecto 100% corporativo."
        />
        
        <div className="space-y-5 pt-3">
          <FormField label="Subdominio por defecto">
            <div className="flex items-center shadow-[var(--shadow-xs)]">
              <input
                type="text"
                value={config.slug}
                disabled
                className="form-input rounded-r-none border-r-0 opacity-60 bg-slate-50 font-mono text-xs cursor-not-allowed"
              />
              <span className="inline-flex items-center rounded-r-lg border border-slate-200 bg-slate-100 px-3.5 py-2.5 text-xs font-semibold text-slate-500">
                .planetour.cloud
              </span>
            </div>
          </FormField>

          <div className="border-t border-slate-100 pt-5">
            <FormField label="Dominio personalizado (CNAME)" helper="Apunta el CNAME de su dominio propio (ej. viajes.miagencia.com) a: app.planetour.cloud">
              <input 
                type="text" 
                placeholder="Ej. viajes.miagencia.com" 
                className="form-input shadow-[var(--shadow-xs)] font-mono text-xs" 
              />
            </FormField>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Team Tab ---
function TeamTab() {
  return (
    <Card className="border border-[var(--color-border)]/50 shadow-[var(--shadow-sm)] rounded-xl overflow-hidden">
      <CardContent className="p-6 space-y-6">
        <SectionHeader
          title="Miembros de su equipo"
          description="Gestione los agentes de venta, administradores y personal autorizado que tienen acceso a este portal."
        />
        
        <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/30 px-6 py-12 text-center">
          <Users className="mx-auto mb-3.5 size-8 text-slate-400" />
          <p className="text-xs font-bold text-slate-700">Módulo de Gestión de Usuarios</p>
          <p className="mt-1 text-[10px] text-slate-500 leading-relaxed max-w-sm mx-auto">
            Habilite cuentas para sus vendedores, configure markups individuales y controle roles. Disponible próximamente.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Reusable components ---
function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1 border-b border-slate-100 pb-4">
      <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
        <span>{title}</span>
      </h2>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
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
      <label className="text-xs font-semibold text-slate-700">
        {label}
        {required && (
          <span className="ml-0.5 text-rose-500" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {helper && <p className="text-[10px] text-slate-400 font-medium leading-relaxed">{helper}</p>}
    </div>
  );
}
