# Evidencia técnica de Sabre

Este directorio congela las fuentes técnicas usadas para reconciliar el análisis de `docs/sabre/` el
25 de agosto de 2026.

- `specs/`: 21 contratos OpenAPI/YAML y 81 capturas de páginas oficiales de Sabre Developer Portal.
- Procedencia: <https://developer.sabre.com/rest-api/booking-management-api/v1/index.html> y páginas enlazadas del
  catálogo oficial.
- La colección Postman analizada está en `sabre/`; sus métricas se reproducen con
  `node tools/sabre/audit-postman.mjs`. La copia versionada reemplaza 23 valores fijos de ejemplo
  `<ClientSecret>` por `{{soap_client_secret}}`; `docs/sabre/00-fuentes.md` conserva ambos hashes.
- No se almacenan EPR, PCC, passwords, tokens ni claves operativas en esta evidencia.

Las fuentes se conservan como evidencia, incluso cuando contienen ejemplos sintéticos del proveedor. El archivo
`get-hotel-avail-v5.0.yml` incluye un ejemplo YAML malformado en el material descargado; no debe utilizarse para
generar cliente sin normalización previa.
