import { readFileSync } from 'node:fs';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { storageStateFile } from './auth';
import { E2E } from './env';
import type { UserKey } from './users';

/**
 * Ayudas de las pruebas de venta con proveedores reales (`@real`): sólo corren con `E2E_REAL=1`, en el
 * ambiente de pruebas de la Mac (infrastructure/pruebas), donde la red de prueba tiene Sabre CERT y
 * TBO test por BYOC y Despegar y LATAM por credencial global. Nunca contra producción.
 */

/** IDs de la red de prueba que crea e2e/env/seed.sql en el ambiente de pruebas. */
export const RED = {
  consolidador: 'e2e-consolidador',
  agenciaA: 'e2e-agencia-a',
} as const;

/** Una fecha `días` adelante, a mediodía de Bogotá para no cruzar de día por el huso. */
export function fechaEn(dias: number): Date {
  const d = new Date();
  d.setUTCHours(17, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

/** El nombre accesible de un día del calendario: «viernes 15 de enero de 2027». */
export function nombreDelDia(fecha: Date): string {
  return fecha
    .toLocaleDateString('es-CO', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'America/Bogota',
    })
    .replace(',', '');
}

/** Elige uno o dos días en el calendario abierto, avanzando de mes hasta que aparezcan. */
export async function elegirDias(page: Page, ...fechas: Date[]): Promise<void> {
  for (const fecha of fechas) {
    const dia = page.getByRole('gridcell', { name: nombreDelDia(fecha), exact: true });
    for (let i = 0; i < 12 && !(await dia.isVisible()); i++) {
      await page.getByRole('button', { name: 'Mes siguiente' }).click();
    }
    await dia.click();
  }
  await page.keyboard.press('Escape');
}

/** Elige un aeropuerto o ciudad en un combobox de ruta, esperando la opción ya filtrada. */
export async function elegirLugar(
  page: Page,
  campo: string,
  texto: string,
  opcion: RegExp,
): Promise<void> {
  const combo = page.getByRole('combobox', { name: campo, exact: true });
  await combo.click();
  await combo.fill(texto);
  await page.getByRole('option', { name: opcion }).first().click();
}

/** El token de sesión que el proyecto `setup` guardó para un usuario. */
function sesionGuardada(key: UserKey): { token: string; tenantId: string | undefined } {
  const state = JSON.parse(readFileSync(storageStateFile(key), 'utf8')) as {
    cookies: { name: string; value: string }[];
  };
  const token = state.cookies.find((c) => c.name === 'st_session')?.value;
  if (!token) throw new Error(`No hay sesión guardada de ${key}: corre el proyecto setup.`);
  return { token, tenantId: state.cookies.find((c) => c.name === 'st_tenant')?.value };
}

/** Cliente del api con la sesión de un usuario de prueba (las cookies son Secure: va por header). */
export async function apiComo(key: UserKey): Promise<APIRequestContext> {
  const { token, tenantId } = sesionGuardada(key);
  return request.newContext({
    baseURL: `${E2E.apiUrl}/api/`,
    extraHTTPHeaders: {
      authorization: `Bearer ${token}`,
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
  });
}

interface Cartera {
  id: string;
  currency: string;
  availableMinor: number;
}

/**
 * Deja la red de prueba lista para reservar hoteles, como lo haría el consolidador: contacto de
 * soporte heredado y carteras en COP y USD con saldo en el consolidador y en la agencia A. Repetirlo
 * no duplica nada: sólo abre lo que falta y recarga lo que bajó del mínimo.
 */
export async function prepararRedParaVender(): Promise<void> {
  const api = await apiComo('superadmin');
  try {
    const red = await api.get('tenants/network');
    expect(red.ok(), await red.text()).toBeTruthy();
    const { tenants } = (await red.json()) as { tenants: { id: string; slug: string }[] };
    const idDe = (slug: string): string => {
      const id = tenants.find((t) => t.slug === slug)?.id;
      if (!id) throw new Error(`No encontré el nodo ${slug} en la red`);
      return id;
    };

    const consolidador = idDe(RED.consolidador);
    const marca = await api.patch(`tenants/${consolidador}/branding`, {
      data: { supportEmail: 'soporte@e2e.test', supportPhone: '+57 300 123 4567' },
    });
    expect(marca.ok(), await marca.text()).toBeTruthy();

    const minimo = { COP: 2_000_000_000, USD: 500_000 } as const;
    for (const tenantId of [consolidador, idDe(RED.agenciaA)]) {
      const vista = await api.get(`tenants/${tenantId}/portfolios`);
      expect(vista.ok(), await vista.text()).toBeTruthy();
      const carteras = ((await vista.json()) as { portfolios: Cartera[] }).portfolios;
      for (const currency of ['COP', 'USD'] as const) {
        let cartera = carteras.find((c) => c.currency === currency);
        if (!cartera) {
          const res = await api.post(`tenants/${tenantId}/portfolios`, {
            data: { currency, creditLimitMinor: 0, reason: 'E2E de venta con proveedores reales' },
          });
          expect(res.ok(), await res.text()).toBeTruthy();
          cartera = ((await res.json()) as { portfolio: Cartera }).portfolio;
        }
        if (cartera.availableMinor < minimo[currency]) {
          const res = await api.post(`tenants/${tenantId}/portfolios/${cartera.id}/deposits`, {
            headers: { 'idempotency-key': crypto.randomUUID() },
            data: { amountMinor: minimo[currency] * 2, reason: 'Saldo de prueba E2E' },
          });
          expect(res.ok(), await res.text()).toBeTruthy();
        }
      }
    }
  } finally {
    await api.dispose();
  }
}
