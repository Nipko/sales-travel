import type { NextConfig } from 'next';
import path from 'node:path';

/**
 * Content-Security-Policy del panel.
 *
 * CLAUDE.md exige "CSP estricto" y web-b2b no tenía ninguna: la API sí monta Helmet,
 * pero el front —que es donde corre el JavaScript y donde un XSS haría daño— estaba sin
 * cubrir.
 *
 * `'unsafe-inline'` en style-src es inevitable hoy: Next inyecta estilos en línea y la
 * hoja de marca del tenant (brand-tokens) también es un <style>. Los scripts NO llevan
 * unsafe-inline salvo el arranque de Next, que va con 'unsafe-eval' sólo en desarrollo.
 */
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  // pics.avs.io sirve los logos de aerolínea en los resultados de vuelo.
  "img-src 'self' data: blob: https://pics.avs.io https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  typedRoutes: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // El logo del tenant puede ser una URL de terceros; que no filtre la ruta.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
