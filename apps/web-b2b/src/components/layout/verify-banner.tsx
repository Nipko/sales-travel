'use client';

import { MailWarning, X } from 'lucide-react';
import { useState } from 'react';

export function VerifyBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');

  if (dismissed) return null;

  async function resend() {
    setSending(true);
    setMsg('');
    try {
      const res = await fetch('/api/auth/resend-verification', { method: 'POST' });
      const data = (await res.json()) as {
        sent?: boolean;
        alreadyVerified?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setMsg(data.error ?? 'No se pudo reenviar el correo.');
        return;
      }
      setMsg(
        data.alreadyVerified
          ? 'Tu correo ya está verificado.'
          : 'Te enviamos un correo de verificación.',
      );
    } catch {
      setMsg('Error de conexión.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-sm text-amber-900">
      <MailWarning className="size-4 shrink-0 text-amber-600" aria-hidden />
      <span className="flex-1">
        Verificá tu correo para asegurar tu cuenta y recibir notificaciones.
        {msg && <span className="ml-2 font-medium">{msg}</span>}
      </span>
      <button
        type="button"
        onClick={() => void resend()}
        disabled={sending}
        className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
      >
        {sending ? 'Enviando…' : 'Reenviar correo'}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded p-1 text-amber-600 hover:bg-amber-100"
        aria-label="Cerrar aviso"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
