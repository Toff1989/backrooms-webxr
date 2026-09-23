#!/usr/bin/env bash
# Déploiement SSH vers un serveur Plesk (fiche projet étape 8/"lancer directement via SSH
# sur Plesk"). Build le front localement, rsync le build + le serveur vers le serveur
# distant, installe les dépendances de prod côté serveur et (re)démarre via PM2.
#
# Ne suppose PAS l'extension Docker de Plesk : PM2 tourne en dehors de tout ça, sur
# n'importe quel Plesk avec accès SSH + Node.js installé (même sans utiliser la fonction
# "Node.js" du panneau Plesk). Voir deploy/README.md pour la config côté Plesk (domaine,
# proxy, HTTPS) — ce script ne s'occupe QUE du process Node lui-même.
#
# Usage :
#   DEPLOY_HOST=monserveur.example.com DEPLOY_USER=monuser DEPLOY_PATH=/var/www/vhosts/mondomaine/backrooms ./deploy/deploy.sh
#
# Variables (toutes obligatoires sauf DEPLOY_PORT) :
#   DEPLOY_HOST   Hôte SSH (domaine ou IP du serveur Plesk)
#   DEPLOY_USER   Utilisateur SSH (souvent l'utilisateur système du domaine Plesk)
#   DEPLOY_PATH   Répertoire distant où déployer (doit déjà exister, appartenir à DEPLOY_USER)
#   DEPLOY_PORT   Port SSH (def. 22)

set -euo pipefail

: "${DEPLOY_HOST:?définir DEPLOY_HOST}"
: "${DEPLOY_USER:?définir DEPLOY_USER}"
: "${DEPLOY_PATH:?définir DEPLOY_PATH}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Build du front (npm run build)"
npm run build

echo "==> Synchronisation vers ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"
ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" "mkdir -p '${DEPLOY_PATH}'"

rsync -az --delete \
  -e "ssh -p ${DEPLOY_PORT}" \
  --exclude 'node_modules' \
  --exclude 'server/node_modules' \
  --exclude 'server/data' \
  --exclude '.git' \
  --exclude '.env' \
  dist server package.json package-lock.json \
  "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"

echo "==> Installation des dépendances serveur + (re)démarrage PM2 (distant)"
ssh -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s <<REMOTE
  set -euo pipefail
  cd "${DEPLOY_PATH}/server"
  npm ci --omit=dev
  command -v pm2 >/dev/null 2>&1 || npm install -g pm2
  pm2 startOrRestart ecosystem.config.cjs --update-env
  pm2 save
REMOTE

echo "==> Déployé. Vérifiez : pm2 status (sur le serveur) et le domaine configuré côté Plesk."
