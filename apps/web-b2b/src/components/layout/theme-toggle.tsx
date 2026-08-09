'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'st-theme';

/**
 * Script que corre ANTES de pintar, para evitar el flash de tema claro.
 *
 * Va inline en el <head>: si esperáramos a que React hidrate, quien tiene el tema oscuro
 * vería un destello blanco en cada carga. Se exporta como cadena para inyectarlo desde
 * el layout raíz.
 */
export const THEME_INIT_SCRIPT = `
(function(){try{
  var t = localStorage.getItem('${STORAGE_KEY}');
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}catch(e){}})();
`.trim();

function apply(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', Icon: Sun },
  { value: 'dark', label: 'Oscuro', Icon: Moon },
  { value: 'system', label: 'Sistema', Icon: Monitor },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    setTheme(stored ?? 'system');
    setMounted(true);
  }, []);

  // Con 'system' hay que seguir los cambios del SO en vivo, no sólo al montar.
  useEffect(() => {
    if (!mounted || theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, mounted]);

  function choose(next: Theme) {
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }

  // Hasta montar no se sabe la preferencia: renderizar un estado activo distinto al del
  // script inline provocaría un desajuste de hidratación.
  if (!mounted) {
    return <div className="h-8 w-[104px]" aria-hidden="true" />;
  }

  return (
    <div
      role="radiogroup"
      aria-label="Tema de la interfaz"
      className="flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className={cn(
            'flex size-7 items-center justify-center rounded-md transition-colors',
            theme === value
              ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
              : 'text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]',
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
