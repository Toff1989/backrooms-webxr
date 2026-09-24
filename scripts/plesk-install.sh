#!/usr/bin/env bash
# Installation et mise à jour du site sur un serveur Plesk (Linux) : une seule commande.
#
#   Première installation (en SSH) :             bash scripts/plesk-install.sh
#   Mise à jour (après un « Extraire » Git) :     bash scripts/plesk-install.sh --update
#
# Ce que fait le script : choisit un Node.js assez récent, installe les paquets (front + serveur),
# compile le front (vite) et bundle le serveur (esbuild), crée server/.env s'il n'existe pas (avec
# une clé RUN_TOKEN_SECRET générée), donne les fichiers au bon utilisateur Plesk et déclenche le
# redémarrage de l'application (Phusion Passenger). Peut être relancé sans risque.
#
# Options : --update  --skip-install  --skip-build  --domain=exemple.fr  --help
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VHOST_DIR="$(dirname "$SITE_DIR")"
DOMAIN="${BACKROOMS_DOMAIN:-$(basename "$VHOST_DIR")}"
UPDATE=0
SKIP_INSTALL=0
SKIP_BUILD=0

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { printf '  \033[32mOK\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mATTENTION\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31mERREUR : %s\033[0m\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --domain=*) DOMAIN="${arg#*=}" ;;
    -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Option inconnue : $arg (voir --help)" ;;
  esac
done

# --- 1. Node.js : la plus récente trouvée dans les toolkits Plesk (minimum 20) -----------------------------------
node_ok() { "$1" -e 'const [a]=process.versions.node.split(".").map(Number);process.exit(a>=20?0:1)' 2>/dev/null; }

say "Recherche de Node.js"
NODE_BIN=""
for bin in $(ls -d /opt/plesk/node/*/bin/node 2>/dev/null | sort -V); do
  if node_ok "$bin"; then NODE_BIN="$bin"; fi # on garde la plus récente
done
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then NODE_BIN="$(command -v node)"; fi
[ -n "$NODE_BIN" ] || fail "Aucun Node.js 20 ou plus trouvé.
  -> Plesk : Extensions > Mes extensions > Node.js Toolkit > Ouvrir > installer une version récente, puis relance ce script."
export PATH="$(dirname "$NODE_BIN"):$PATH"
ok "Node $(node -v) ($NODE_BIN)"

cd "$SITE_DIR"
[ -f package.json ] || fail "package.json introuvable dans $SITE_DIR : ce script doit rester dans le dossier scripts/ du projet."

# En root, les paquets sont installés et le site compilé SOUS L'IDENTITÉ DE L'UTILISATEUR DU SITE : le code des
# dépendances (postinstall, etc.) ne doit jamais s'exécuter en root. Si ce n'est pas possible (pas de runuser…),
# le script continue comme avant, avec un avertissement.
OWNER=""
OWNER_USER=""
CAN_DROP=0
if [ "$(id -u)" = 0 ]; then
  OWNER="$(stat -c '%U:%G' "$VHOST_DIR/httpdocs" 2>/dev/null || stat -c '%U:%G' "$VHOST_DIR")"
  OWNER_USER="${OWNER%%:*}"
  mkdir -p "$SITE_DIR/tmp"
  chown -R "$OWNER" "$SITE_DIR"
  if [ "$OWNER_USER" != root ] && command -v runuser >/dev/null 2>&1 && runuser -u "$OWNER_USER" -- test -w "$SITE_DIR"; then
    CAN_DROP=1
  else
    warn "Installation et compilation en root (runuser indisponible) : moins sûr, à éviter."
  fi
fi
as_owner() {
  if [ "$CAN_DROP" = 1 ]; then
    runuser -u "$OWNER_USER" -- env "PATH=$PATH" "HOME=$SITE_DIR/tmp" "npm_config_cache=$SITE_DIR/tmp/npm-cache" "$@"
  else
    "$@"
  fi
}

# --- 2. Paquets et compilation --------------------------------------------------------------------------------
if [ "$SKIP_INSTALL" = 0 ]; then
  say "Installation des paquets — front (2 à 4 minutes)"
  as_owner npm ci --include=dev || fail "npm ci a échoué à la racine. Vérifie que package-lock.json est à jour (npm install sur ton PC, puis git push), puis relance."
  ok "paquets front installés"

  say "Installation des paquets — serveur"
  as_owner npm --prefix server ci --include=dev || fail "npm ci a échoué dans server/. Vérifie server/package-lock.json, puis relance."
  ok "paquets serveur installés"
fi

if [ "$SKIP_BUILD" = 0 ]; then
  say "Compilation du front (tsc + vite)"
  as_owner npm run build
  [ -f dist/index.html ] || fail "La compilation n'a pas produit dist/index.html."
  ok "front compilé (dist/)"

  say "Bundle du serveur (esbuild)"
  as_owner npm --prefix server run build
  [ -f server/dist/server.mjs ] || fail "La compilation n'a pas produit server/dist/server.mjs."
  ok "serveur compilé (server/dist/server.mjs)"
fi

# --- 3. Configuration (server/.env) ---------------------------------------------------------------------------
ENV_FILE="$SITE_DIR/server/.env"
say "Configuration (server/.env)"
if [ ! -f "$ENV_FILE" ]; then
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
RUN_TOKEN_SECRET=$SECRET
# Fait confiance à l'en-tête X-Forwarded-For du proxy Plesk/nginx (voir server/src/server.ts).
TRUST_PROXY=1
EOF
  chmod 600 "$ENV_FILE"
  ok "server/.env créé (clé RUN_TOKEN_SECRET générée)"
else
  grep -q '^RUN_TOKEN_SECRET=' "$ENV_FILE" || warn "RUN_TOKEN_SECRET manque dans $ENV_FILE"
  ok "server/.env existe déjà : conservé tel quel"
fi

# --- 4. Droits et redémarrage ------------------------------------------------------------------------------------
say "Droits des fichiers et redémarrage"
mkdir -p "$SITE_DIR/tmp" "$SITE_DIR/server/data" "$SITE_DIR/server/backups"
touch "$SITE_DIR/tmp/restart.txt" # Passenger redémarre l'application quand ce fichier change
if [ "$(id -u)" = 0 ]; then
  chown -R "$OWNER" "$SITE_DIR"
  ok "fichiers donnés à $OWNER"
else
  ok "lancé sans être root : les fichiers appartiennent déjà à ton utilisateur"
fi
for dir in server/data server/backups; do
  chmod 700 "$SITE_DIR/$dir"
done
chmod 600 "$ENV_FILE"
ok "droits d'accès restreints (base, sauvegardes, configuration)"
ok "application redémarrée"

printf '\n\033[1mTerminé.\033[0m Ouvre https://%s\n' "$DOMAIN"
echo "S'il reste une page d'erreur : voir la section « Dépannage » de docs/DEPLOIEMENT-PLESK.md."
