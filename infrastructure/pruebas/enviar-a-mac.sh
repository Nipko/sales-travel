#!/usr/bin/env bash
# Lleva el estado ACTUAL del repo de este PC (rama + cambios sin commit) al ambiente de pruebas de la Mac
# mini y lo deja en la rama `qa-pruebas` de ~/sales-travel-pruebas. Es el paso «aplicar en la Mac» del
# ciclo de QA (docs/qa/README.md): probar → corregir → enviar-a-mac → reprobar → VPS.
#
#   infrastructure/pruebas/enviar-a-mac.sh            # sólo código (las pruebas no necesitan más)
#   infrastructure/pruebas/enviar-a-mac.sh --up       # además reconstruye y levanta api/web (cambios de app)
#
# No crea commits en tu rama: arma un commit suelto con lo que hay en disco (refs/mac/qa) y manda sólo lo
# que la Mac no tiene. No viaja nada fuera de git: ni .env, ni e2e/.auth, ni credenciales.
# Variables: MAC (default inipko@100.117.147.69), MAC_DIR (default ~/sales-travel-pruebas).
set -euo pipefail

MAC="${MAC:-inipko@100.117.147.69}"
MAC_DIR="${MAC_DIR:-sales-travel-pruebas}"
UP=0
[[ "${1:-}" == "--up" ]] && UP=1

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

# Archivos con cambios locales que NO viajan (de trabajo del founder, ajenos a las pruebas).
EXCLUIR=(.claude/launch.json docs/despegar/02-brechas-y-plan.md)

tmp_index="$(mktemp)"
trap 'rm -f "$tmp_index" "$bundle"' EXIT
cp "$(git rev-parse --git-dir)/index" "$tmp_index"
GIT_INDEX_FILE="$tmp_index" git add -A
for f in "${EXCLUIR[@]}"; do GIT_INDEX_FILE="$tmp_index" git reset -q HEAD -- "$f" 2>/dev/null || true; done
# Desde Windows los scripts pierden el bit de ejecución: en la Mac se corren directo.
GIT_INDEX_FILE="$tmp_index" git update-index --chmod=+x infrastructure/pruebas/pruebas.sh infrastructure/pruebas/enviar-a-mac.sh
tree="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
snap="$(git commit-tree "$tree" -p HEAD -m "qa: snapshot de $(git branch --show-current) para la Mac ($(date -u +%FT%TZ))")"
git update-ref refs/mac/qa "$snap"

base="$(ssh -o BatchMode=yes "$MAC" "cd $MAC_DIR && git rev-parse HEAD")"
bundle="$(mktemp --suffix=.bundle 2>/dev/null || mktemp)"
# Sólo lo que la Mac no tiene: desde el ancestro común con lo que tiene (cada envío es un commit suelto
# hermano del anterior, no su hijo).
if comun="$(git merge-base "$base" "$snap" 2>/dev/null)"; then
  git bundle create -q "$bundle" "$comun..refs/mac/qa"
else
  git bundle create -q "$bundle" refs/mac/qa
fi
scp -q "$bundle" "$MAC:/tmp/qa.bundle"

ssh -o BatchMode=yes "$MAC" bash -s -- "$MAC_DIR" "$UP" <<'REMOTO'
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$1"
git fetch -q /tmp/qa.bundle +refs/mac/qa:refs/remotes/qa/snapshot
git checkout -q -f -B qa-pruebas refs/remotes/qa/snapshot
git log --oneline -1
command -v pnpm >/dev/null || corepack enable pnpm
pnpm install --frozen-lockfile --silent >/dev/null
if [[ "$2" == "1" ]]; then bash infrastructure/pruebas/pruebas.sh up; fi
REMOTO
echo "Mac en $(git rev-parse --short "$snap") ($(git branch --show-current) + cambios locales)."
