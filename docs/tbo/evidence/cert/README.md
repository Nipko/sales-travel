# Evidencia de la certificación de TBO

Aquí se archiva lo que se le envió a TBO para certificar la integración de hoteles y lo que TBO devolvió al cerrarla:
el zip con los 8 casos, el workflow, el registro de cada envío y la tabla de sign-off con el SHA de git de la versión
probada. Es lo que decide D-TBO-33 (A) ([08](../../08-requisitos-maestro.md#registro-de-decisiones)) y lo que piden
[07](../../07-certificacion.md) §2.7 y §6.9, RC-01 y RNF-15.

**Estado al 2026-09-27:** no se envió nada todavía. La carpeta solo tiene este README.

## Qué va en cada carpeta

Una carpeta por envío, con la fecha UTC del email: `docs/tbo/evidence/cert/<YYYY-MM-DD>/`. Si TBO pide correcciones
y se reenvía, la corrección va en una carpeta nueva con su fecha; una carpeta ya commiteada no se toca.

| Archivo                                                    | Cuándo                | Qué es                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<Empresa>_TBO_HotelAPI_JSON_Certification_<YYYYMMDD>.zip` | Al enviar             | Copia byte a byte del zip adjuntado al email: el mismo archivo que `zip` dejó en `.tbo-cert/<runId>/` ([tools/tbo](../../../../tools/tbo/README.md)), sin renombrar, sin descomprimir y sin volver a comprimir                       |
| El PDF del workflow                                        | Al enviar             | El [Anexo A de 07](../../07-certificacion.md#anexo-a--integration-workflow-listo-para-enviar) tal como salió, con los `[COMPLETAR]` llenos. Lleva el contacto técnico de la empresa, que es un dato de negocio y no un dato sensible |
| `SHA256SUMS`                                               | Al enviar             | Salida de `sha256sum` del zip y del PDF                                                                                                                                                                                              |
| `envio.md`                                                 | Al enviar             | Registro del envío (plantilla abajo)                                                                                                                                                                                                 |
| `sign-off.md`                                              | Al cerrar la fase 4   | La tabla de sign-off de TBO y los SHA probados (plantilla abajo)                                                                                                                                                                     |
| `hallazgos-json.xlsx`, `hallazgos-portal.xlsx`             | Opcional, al cerrarse | El Excel de "Issues, Observations and General queries" de TBO con nuestras respuestas, sin nombres, correos ni teléfonos de personas de TBO                                                                                          |

El zip no lleva secretos ni datos de personas reales: `zip` aborta si encuentra el usuario o la contraseña de TBO, su
Basic en base64, la cabecera `Authorization` (G-1) o un nombre fuera de la lista sintética del arnés (G-4), y vuelve a
pasar G-1 sobre el zip ya escrito ([07](../../07-certificacion.md) §6.7).

## Qué no entra nunca

- **Credenciales**: `.env.tbo`, el usuario y la contraseña de TBO (de test o live), cabeceras `Authorization`, la
  contraseña del usuario del portal, los secrets `CERT_*` del stack de certificación. Las credenciales live tampoco se
  anotan en `sign-off.md`: solo la fecha en que llegaron.
- **Corridas crudas**: `.tbo-cert/` entero (corridas, `attempts/`, `probes/`, `calls.jsonl`, `selfcheck.md`) está en
  `.gitignore` y se queda fuera. Si una sonda cierra una pregunta, lo que se versiona es la respuesta en
  [10](../../10-preguntas-para-tbo.md), no la captura.
- **Zips que no se enviaron**, ni una versión corregida de un zip ya enviado.
- **Datos de personas**: huéspedes reales (el zip solo tiene sintéticos) y nombres, correos o teléfonos de personas de
  TBO en el sign-off o en el Excel, con el mismo criterio que la colección Postman ([00](../../00-fuentes.md) §3).
- **El contenido del zip descomprimido.** El hook de pre-commit y el `format:check` de CI rechazan un JSON que no
  tiene el formato de prettier, y formatearlo para que pase deja de ser los bytes que vio TBO. El zip es binario y
  prettier no lo mira. Si hacen falta respuestas reales como fixtures, van a `providers/tbo-hotels` con la marca de su origen
  ([07](../../07-certificacion.md) §6.9).

## Cómo se archiva un envío

1. Enviar el email del [Anexo C de 07](../../07-certificacion.md#anexo-c--email-del-zip-listo-para-enviar) con el
   zip y el PDF del workflow.
2. Crear `docs/tbo/evidence/cert/<YYYY-MM-DD>/` y copiar ahí los dos archivos adjuntados, tal cual.
3. Desde esa carpeta, en Git Bash: `sha256sum <zip> <pdf> > SHA256SUMS`, y comprobarlo con `sha256sum -c SHA256SUMS`.
   `manifest.json`, dentro del zip, tiene además el SHA-256 de cada archivo, el `runId` y el SHA de git.
4. Llenar `envio.md` con la plantilla de abajo.
5. Commit de esa carpeta y nada más: `docs(tbo): set de certificación enviado el <YYYY-MM-DD>`.

## Sign-off (RC-01)

Cuando TBO manda la tabla de sign-off (Cert, Sign Off / API Live Credentials), se transcribe a `sign-off.md` en la
carpeta del último envío. Tiene que decir qué versión se probó:

- **JSON Verification**: el `Application build` del `README.txt` del zip, que es el mismo SHA de `manifest.json` y de
  `run.json`. Si dice "with uncommitted changes", ese SHA no identifica el build y la corrida hay que repetirla desde
  un commit limpio antes de enviar.
- **Portal Verification**: el SHA o el tag de la imagen que corría el stack de certificación durante la prueba (job
  `deploy-cert`, `infrastructure/hostinger/README.md` §9.3).

Si los dos difieren (por ejemplo, porque se corrigieron hallazgos del Excel entre una fase y otra), van los dos con
el motivo. Con esa tabla archivada y las credenciales live recibidas se cumple el criterio de salida de la Fase 7
([09](../../09-plan-implementacion.md) §14).

## Plantillas

`envio.md`:

```markdown
# Envío a TBO — <YYYY-MM-DD>

- Fecha y hora del email (UTC):
- Para / Cc: apisupport@tbo.com / apisupport@tboholidays.com
- Asunto:
- Zip: <nombre> · SHA-256: <hash> · runId: <runId>
- Application build (README.txt del zip): <git sha>
- Workflow: <archivo PDF> · sale del Anexo A de docs/tbo/07-certificacion.md en el commit <sha>
- Qué es: primer envío | reenvío por los hallazgos de <fecha>
- Respuesta de TBO: <fecha y resumen, sin datos de personas>
```

`sign-off.md`:

```markdown
# Sign-off de TBO — <YYYY-MM-DD>

- Recibido (UTC):
- Build probado en JSON Verification: <git sha> (README.txt del zip de <carpeta>)
- Build probado en Portal Verification: <git sha o tag de la imagen del stack>
- Credenciales live: recibidas el <fecha> (los valores nunca van aquí)

| Punto | Fase (JSON / Portal) | Lo que dice TBO | Estado | Nuestra respuesta |
| ----- | -------------------- | --------------- | ------ | ----------------- |
```

## Condición

Todo esto supone que TBO no impone confidencialidad sobre el material de certificación
([Q-94](../../10-preguntas-para-tbo.md#q-94)). Si la impone, el zip, el PDF y el Excel se guardan fuera de Git y aquí
quedan solo `envio.md`, `sign-off.md` y `SHA256SUMS`.
