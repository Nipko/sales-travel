# Decisiones — Segunda Ronda

**Fecha:** 2026-04-24
**Estado:** Confirmado por el usuario + defaults recomendados aceptados implícitamente

---

## Decisiones explícitas del usuario

### Infraestructura (R1)
- **Fase 1 (lanzamiento):** Hostinger VPS detrás de **Cloudflare** (CDN, WAF, DDoS, SSL).
- **Fase 2 (post-validación):** Migración a **AWS** cuando la plataforma demuestre tracción y necesidad de robustez/cumplimiento.
- **Trigger de migración (criterios objetivos):** cualquiera de estos dispara migración a AWS:
  - >500 reservas/día sostenidas
  - Primer contrato con agencia que exija SLA contractual >99.5%
  - Onboarding de aerolínea NDC adicional que exija PCI-DSS L1
  - Volumen de pagos >100k USD/mes (Stripe pasa a exigir cumplimientos adicionales)
  - Solicitud formal de auditoría de seguridad por cliente B2B grande

### Pagos (R1)
- **Stripe** (internacional + B2C tarjetas globales)
- **Mercado Pago** (LATAM, métodos locales: PSE Colombia, Boleto/PIX Brasil, Yape Perú)
- **Split payments** vía Stripe Connect / MP Marketplace para comisiones a agencias

### Monetización (R4)
- **Parametrizable por agencia y por tipo de servicio.**
- Implementación: motor de pricing rules por tenant con:
  - Markup % o monto fijo, configurable por categoría (aéreo/hotel/actividad/asistencia/auto/paquete)
  - Reglas por destino, temporada, proveedor, tipo de cliente final
  - Override manual por reserva (con permiso)
  - Comisiones internas (vendedor → agencia → plataforma) configurables

---

## Defaults recomendados (aceptados implícitamente con "los demás recomiéndame")

### R2 — Presupuesto año 1
**Recomendación:** **400k–600k USD** para fase Hostinger (Olas 1+2), escalando a **1.2M–1.8M USD** total acumulado al cierre Ola 3 con migración AWS.
- Razón: equipo de 10–14 personas en fase Hostinger, ampliable a 20–25 con migración.
- Distribución típica: 65% nómina, 15% infra+licencias+APIs, 10% legal/fiscal/auditorías, 10% marketing+ventas.

### R3 — Esquema por olas
**Recomendación aceptada:** **3 olas** (cada una en producción, no MVP).
- **Ola 1 — Mes 6:** B2B Colombia + Brasil. Aéreo (Travelport+Amadeus+LATAM NDC), hoteles (HotelDo), asistencias (Assist Card o equivalente), pagos Stripe+MP, WhatsApp para cotización, white-label básico, facturación CO+BR.
- **Ola 2 — Mes 10:** Actividades, autos, Perú, app móvil para vendedores, IA omnicanal (IG+Telegram+webchat), reporting v1.
- **Ola 3 — Mes 14:** B2C completo, app móvil cliente final, IA con capacidad de reservar+cobrar, reporting avanzado, módulo contable completo.

### R5 — Modelo merchant
**Recomendación:** **Híbrido configurable por agencia.**
- Default B2C: **Merchant of Record** (cobras tú, facturas tú, asumes contracargos, mejor experiencia para cliente final).
- Default B2B: **Facilitador** (cada agencia cobra con sus credenciales Stripe/MP, tú cobras fee de plataforma vía Stripe Connect).
- Opt-in: agencia puede activar "MoR delegado" si no quiere lidiar con sus credenciales (pagas fee adicional).

### R6 — Equipo
**Recomendación:**
- Contratar **CTO / VP Engineering** primero (mes 0–1), perfil senior con experiencia travel-tech o fintech LATAM.
- Modelo de contratación: **núcleo en LATAM** (Colombia, Argentina, Uruguay) + **especialistas nearshore** para roles puntuales (PCI, IA).
- Estructura inicial Ola 1 (12 personas): 1 CTO, 2 backend sr, 2 frontend sr, 1 DevOps/SRE, 1 QA, 1 product manager, 1 UX designer, 1 integraciones (GDS/NDC), 1 data engineer, 1 IA engineer.

### R7 — Vendedor en ruta
**Recomendación:** **Empleados de agencia** (modelo más común en LATAM B2B). La app móvil de vendedor incluye:
- Cotización rápida desde el móvil
- Compartir cotización por WhatsApp con cliente
- Cierre de venta con pago link
- Comisiones y metas
- Modo offline para zonas con mala conectividad

Si más adelante quieres habilitar freelancers, se agrega rol "vendedor independiente" sin cambios mayores.

### R8 — App móvil cliente final
**Recomendación:** **Marca única tuya** ("Sales-Travel" o el nombre comercial que defines), **NO** white-label por agencia.
- Razón: publicar 50+ apps en App Store/Play Store es operativamente inviable (revisiones, updates, certificados, soporte).
- Alternativa para branding por agencia: **PWA white-label** (web app instalable) con dominio propio de la agencia. Da experiencia tipo app sin pasar por las stores.

---

## Banderas amarillas que asumo y dejo trazadas

1. **Hostinger no soporta PCI-DSS Level 1.** Mientras estemos en Hostinger, los pagos pasan **100% por Stripe Hosted Checkout / MP Checkout Pro** (no tocamos datos de tarjeta nunca → SAQ-A, el más liviano). No se podrá ofrecer "tokenización propia" hasta migración AWS.

2. **GDS Travelport/Amadeus/Sabre** podrían rechazar IPs compartidas de Hostinger. **Acción:** reservar IP dedicada en Hostinger desde día 1 y validar con cada GDS antes de cerrar contratos de homologación.

3. **LGPD Brasil:** mientras Hostinger no esté en región brasileña certificada, requerimos **DPA (Data Processing Agreement)** con cláusula de transferencia internacional + notificación expresa al usuario. Documentar en políticas de privacidad.

4. **Diseño cloud-ready desde día 1** aunque corramos en Hostinger: stateless, configuración por env vars, blob storage abstrayendo S3/MinIO, queues abstraídas, secrets manager. Sin esto, la migración a AWS toma meses.
