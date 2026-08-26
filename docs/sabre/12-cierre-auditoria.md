---
titulo: Sabre — cierre y auditoría del expediente
fecha: 2026-08-25
estado: cerrado-documentalmente
---

# Sabre — cierre y auditoría del expediente

Este documento cierra la investigación documental iniciada sobre la colección Postman de Booking Management.
No declara terminada la integración ni sustituye las pruebas contra CERT. Registra qué conclusiones se conservan,
qué afirmaciones fueron corregidas en la auditoría final y qué información debe permanecer fuera de Git.

## 1. Estado de cierre

- La colección contiene **1.077 requests**, de los cuales **243** son SOAP/LLS.
- Los **21 contratos OpenAPI** y las páginas oficiales usadas como evidencia quedaron congelados en
  `docs/sabre/evidence/specs/`; ya no dependen del directorio temporal de una sesión.
- Los conteos principales son reproducibles con `node tools/sabre/audit-postman.mjs`.
- Las credenciales EPR + PCC + password de CERT **están disponibles**, pero deliberadamente no se incorporan a
  Git, Postman ni Markdown. Se inyectan como `credentials = { epr, password }` y
  `config = { homePcc, targetPcc?, ... }` mediante `ProviderCredentialsService`, que cifra
  `provider_accounts.credentials_enc` con AES-256-GCM.
- El environment versionado continúa vacío a propósito. Que esté vacío ya no significa que el proyecto no tenga
  acceso a las credenciales; significa que el repositorio no contiene secretos.

## 2. Decisiones cerradas

1. **D0 — proveedor a evaluar:** se elimina Amadeus Self-Service como alternativa: fue descontinuado el
   17-jul-2026. La comparación vigente es Sabre frente a alternativas comerciales actuales (Amadeus Enterprise,
   Travelport u otra que se investigue con el mismo rigor). El expediente no selecciona automáticamente a Sabre;
   la compuerta sigue siendo fee + branch access + aporte incremental medido en CERT.
2. **D1 — PCI:** no se manda PAN/CVV en fase 1. ATPCO usa `CASH`/`ON_ACCOUNT`/`INVOICE` cuando el contrato del
   tenant lo permita. NDC queda condicionado a validar una FOP sin PAN por aerolínea; contenido que exija
   `PAYMENTCARD` no se vende hasta disponer de una ruta compatible con la postura PCI.
3. **D2 — transporte:** el primer incremento usa REST + ATK stateless. No se construye `SabreSessionPool` para
   Booking Management. SOAP queda como incremento separado si entra una capacidad que realmente lo requiera.
4. **D4 — red:** `targetPcc` es el primitivo técnico confirmado; la responsabilidad BSP/ADM y la condición de
   emisor de récord requieren confirmación comercial escrita. No se presentan como propiedades demostradas por
   el schema del API.

## 3. Correcciones de la auditoría final

### 3.1 Errores HTTP

Booking Management puede transportar fallos de negocio dentro de HTTP 200. La regla correcta no es sólo
`response.ok`: cada adapter clasifica el envelope propio (`errors[]`, `warnings[]`, `messages[]` o
`ApplicationResults`). El conteo actualizado es **14 de 21 contratos** que declaran únicamente `200`, no 12.

### 3.2 BFM y contenido con marca

`MultipleSourcePerItinerary.Value = true` conserva alternativas del mismo viaje entre ATPCO y NDC y debe formar
parte del builder cuando se quieren comparar fuentes. No garantiza por sí solo una tarifa con equipaje o un
upsell. Para eso también aplican `MultipleBrandedFares`, `MaxNumberOfUpsells` y `UpsellLimit`. La afirmación
"la tarifa con maleta nunca llega" queda sustituida por: **Sabre puede podar una alternativa cross-source más
cara; la conservación de marcas/upsells se solicita y prueba por separado**.

### 3.3 `targetPcc` y estado

El contrato dice que el contexto no se revierte después de algunas operaciones, pero las guías de Booking
Management declaran el API stateless y dicen que el AAA de ATH se limpia antes y después. Por eso una fuga entre
llamadas ATK no se marca como hecho verificado. La defensa permanece: `targetPcc` explícito, caché aislada por
`provider_account` y prueba consecutiva entre tenants. La semántica exacta debe confirmarse con Sabre.

### 3.4 Tokenización

La colección no trae ejemplos de tokenización, pero el contrato de fulfill sí define `referenceId` para una FOP
almacenada. La conclusión válida es **"no hay un flujo ejercitado en la colección"**, no "Sabre carece de soporte".

## 4. Salida del expediente y siguiente compuerta

El análisis documental queda cerrado. La siguiente actividad ya no es investigar más documentación sino ejecutar
la Fase 0 contra CERT:

1. inyectar las credenciales fuera de Git;
2. comprobar auth y entitlements por familia;
3. realizar 20–30 búsquedas CO/PE/BR con el mismo conjunto de casos usado para LATAM NDC directo;
4. medir aporte incremental y coste estimado;
5. probar `CASH`/`ON_ACCOUNT` en ATPCO y una FOP sin PAN en NDC;
6. guardar únicamente fixtures anonimizados y sin secretos.

Hasta completar esa compuerta, los mappers pueden implementarse contra los contratos congelados, pero Sabre no se
habilita para ventas reales.
