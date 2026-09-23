# Déploiement — Plesk via SSH

Ce projet est déployé comme un seul process Node (le serveur sert à la fois l'API de
classement et le build statique du front, voir `server/src/server.ts`). Deux façons de
le faire tourner derrière un domaine Plesk :

## Option A — PM2 en SSH pur (recommandé, ne dépend d'aucune fonctionnalité Plesk)

1. **Une fois, sur le serveur** : Node.js installé (`node -v`), et un dossier de
   destination appartenant à l'utilisateur SSH du domaine, ex.
   `/var/www/vhosts/mondomaine.tld/backrooms`.
2. **Depuis votre machine**, à la racine du projet :
   ```bash
   export DEPLOY_HOST=mondomaine.tld
   export DEPLOY_USER=monuser
   export DEPLOY_PATH=/var/www/vhosts/mondomaine.tld/backrooms
   ./deploy/deploy.sh
   ```
   Ça build le front, rsync `dist/` + `server/` vers le serveur, installe les
   dépendances de prod et démarre/redémarre le process via PM2 (`server/ecosystem.config.cjs`).
3. **Première fois seulement**, sur le serveur, définir le secret des tokens de run
   (voir `server/src/token.ts`) — sinon la valeur de dev (non sécurisée) est utilisée :
   ```bash
   cd /var/www/vhosts/mondomaine.tld/backrooms/server
   echo "RUN_TOKEN_SECRET=$(openssl rand -hex 32)" > .env
   pm2 restart ecosystem.config.cjs --update-env
   ```
   (`server.ts`/`token.ts` lisent `process.env` directement ; si vous préférez ne pas
   gérer de fichier `.env` manuellement, exportez la variable dans le shell avant
   `pm2 start`, ou ajoutez-la dans `ecosystem.config.cjs`.)
4. **Côté panneau Plesk** : le process PM2 écoute en local sur `127.0.0.1:8787` (jamais
   exposé directement à internet). Dans Plesk, pour le domaine :
   - **Apache & Nginx Settings → Additional nginx directives**, ajoutez :
     ```nginx
     location / {
         proxy_pass http://127.0.0.1:8787;
         proxy_set_header Host $host;
         proxy_set_header X-Real-IP $remote_addr;
         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
         proxy_set_header X-Forwarded-Proto $scheme;
     }
     ```
   - **SSL/TLS Certificates** : laissez Plesk gérer Let's Encrypt normalement (rien de
     spécifique à ce projet).

Pour redéployer après un changement de code, relancez simplement `./deploy/deploy.sh`.

## Option B — Docker (si l'extension Docker de Plesk est activée)

`docker-compose.yml` à la racine fonctionne tel quel :
```bash
scp -r . monuser@mondomaine.tld:/chemin/vers/backrooms
ssh monuser@mondomaine.tld
cd /chemin/vers/backrooms
cp .env.example .env   # puis renseigner RUN_TOKEN_SECRET (openssl rand -hex 32)
docker compose up -d --build
```
Le conteneur écoute sur `8787` (exposé en local par défaut, `docker-compose.yml`) —
même remarque que l'option A : faites proxy_pass depuis Plesk plutôt que d'exposer le
port directement, et laissez Plesk gérer le certificat HTTPS du domaine.

## Sauvegardes

La base SQLite (classement) vit dans `server/data/backrooms.sqlite` (option A) ou dans
le volume Docker `backrooms-data` (option B). Un simple `cp`/`rsync` périodique de ce
fichier suffit (WAL activé, voir `server/src/db.ts` — copier aussi les fichiers
`-wal`/`-shm` s'ils existent, ou passer par `sqlite3 ... ".backup"` pour une copie
cohérente à chaud).
