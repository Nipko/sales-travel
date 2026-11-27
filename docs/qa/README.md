# QA · cómo se trabaja

| Qué                                  | Dónde                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Qué se prueba (310 casos, hallazgos) | `01-plan-pruebas-funcionales.md`                                       |
| En qué fase está cada caso           | `estado.json` (sólo lo que cambió respecto del plan)                   |
| Datos del tablero (generados)        | `tablero/{casos,hallazgos,infra}.json` ← `tools/qa/tablero.mjs`        |
| Tablero                              | https://claude.ai/artifact/JnrRA7yrna6C7suQBNf5HR                      |
| Arnés HTTP (sin navegador)           | `apps/web-b2b/e2e/api/*.api.ts`, proyecto Playwright `api`             |
| Inventario de rutas de la API        | `apps/web-b2b/e2e/api/rutas.generated.json` ← `tools/qa/rutas-api.mjs` |

## El ciclo de cada caso

```
por crear → (correr en la Mac) → pasa
                               → falla → corregir en la rama → enviar a la Mac → reprobar → pasa → VPS
```

1. **Escribir la prueba** con el id del caso al principio del título (`TRV-08 …`) y, si confirma un
   hallazgo, su id entre paréntesis (`(QA-H-01)`). Así el resultado llega solo al tablero.
2. **Llevar el código a la Mac:** `bash infrastructure/pruebas/enviar-a-mac.sh` (sólo pruebas) o
   `… --up` (cambió la app: reconstruye api y panel). No crea commits en tu rama.
3. **Correr en la Mac:** `ssh <mac> 'cd ~/sales-travel-pruebas && bash infrastructure/pruebas/pruebas.sh e2e --project=api'`
   (o `--project=desktop` para el panel).
4. **Pasar el resultado al tablero:**
   `scp <mac>:sales-travel-pruebas/apps/web-b2b/playwright-report/resultados.json /tmp/r.json && node tools/qa/resultados.mjs /tmp/r.json --ambiente mac`
   y subir `docs/qa/tablero/*.json` al tablero.
5. **Falla:** se corrige en la rama, `estado.json` marca el caso con `"arreglo": "rama"`, y se vuelve al
   paso 2. Cuando pasa en la Mac, el arreglo queda en `mac`.
6. **VPS:** el arreglo llega a producción por el camino normal (PR → `main` → deploy). Después de
   desplegar se corre la suite contra producción sólo con lo que no cambia datos y se registra con
   `--ambiente vps`.

`"cobertura": "parcial"` en un caso de `estado.json` dice que sus pruebas cubren sólo una parte: pasar
lo deja en «parcial» y la `nota` dice qué falta.
