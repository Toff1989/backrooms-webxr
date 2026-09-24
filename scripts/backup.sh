#!/usr/bin/env bash
# Sauvegarde quotidienne pour Plesk : trouve un Node.js assez récent puis lance server/scripts/backup.js.
# À planifier dans Plesk (Tâches planifiées > Exécuter une commande) :
#   bash /var/www/vhosts/<domaine>/<sous-domaine>/backrooms/scripts/backup.sh
set -euo pipefail
umask 077

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node_ok() { "$1" -e 'const [a]=process.versions.node.split(".").map(Number);process.exit(a>=20?0:1)' 2>/dev/null; }

NODE_BIN=""
for bin in $(ls -d /opt/plesk/node/*/bin/node /usr/local/bin/node /usr/bin/node 2>/dev/null | sort -V); do
  if node_ok "$bin"; then NODE_BIN="$bin"; fi # on garde la plus récente
done
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then NODE_BIN="$(command -v node)"; fi
[ -n "$NODE_BIN" ] || { echo "ERREUR : aucun Node.js >= 20 trouvé (Plesk > Extensions > Node.js Toolkit)." >&2; exit 1; }

exec "$NODE_BIN" "$SITE_DIR/server/scripts/backup.js"
