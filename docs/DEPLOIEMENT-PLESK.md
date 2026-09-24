# Mettre le site en ligne avec Plesk — guide simple

Même méthode que les autres projets hébergés sur ce Plesk (ex. SiteChevauxTTR) : hébergement
**Node.js natif** via l'extension *Node.js Toolkit* (Phusion Passenger), le code arrive par **Git**
directement dans Plesk, et **un seul script** (`scripts/plesk-install.sh`) installe, compile,
configure et redémarre.

Dans ce guide, l'exemple est `backrooms.toffplace.fr` ; remplace-le par ton adresse.

| Ce dont tu as besoin | |
|---|---|
| Un VPS avec **Plesk** (Linux) et un accès SSH | |
| Un nom de domaine qui pointe vers le VPS | Plesk → domaine → *DNS* : un enregistrement **A** vers l'IP du VPS |
| Le dépôt GitHub du projet | `Toff1989/backrooms-webxr` (public — pas de clé de déploiement à configurer) |

---

## Étape 1 — Préparer Plesk (une seule fois)

1. **Mettre Plesk à jour** : *Outils et paramètres* → *Mises à jour*. Active aussi les mises à jour automatiques.
2. **Node.js** : *Extensions* → *Mes extensions* → **Node.js Toolkit** → *Ouvrir* → installe une version récente
   (20.x ou plus — ce projet n'a pas besoin de fonctionnalités très récentes de Node).
   (Si Node.js Toolkit n'apparaît pas : *Extensions* → *Catalogue d'extensions* → cherche « Node.js » → installer.)
3. **Git** : la même page *Extensions* doit proposer **Git** ; sinon, installe-le depuis le catalogue.
4. **SSH** : *Sites web et domaines* → ton domaine → *Accès à l'hébergement web* → *Accès au serveur via SSH* = **/bin/bash** → *OK*.
5. **Vider `httpdocs`** : *Gestionnaire de fichiers* → dossier `httpdocs` du domaine → supprime tout ce qu'il contient
   (souvent un `index.html` « Web Server is working »). Plesk affiche ces fichiers **avant** le site : s'il en reste,
   tu verras une page Plesk au lieu du jeu.

## Étape 2 — Envoyer le code sur le serveur

Le dépôt est **public** : pas besoin de clé de déploiement.

1. *Sites web et domaines* → ton domaine → **Git** → *Ajouter un dépôt* → **Hébergement Git distant**.
2. Remplis :
   - **URL du dépôt** : `https://github.com/Toff1989/backrooms-webxr.git`
   - **Nom du dépôt** : `backrooms`
   - **Branche** : `main`
   - **Chemin de déploiement** : `/backrooms` *(un dossier à côté de `httpdocs`, jamais dedans)*
3. Clique **OK**, puis **Extraire** (Pull). Le dossier `/backrooms` se remplit.

## Étape 3 — Lancer l'installation (une commande)

Connecte-toi en SSH et lance :

```bash
cd /var/www/vhosts/tondomaine.tld/backrooms.tondomaine.tld/backrooms
bash scripts/plesk-install.sh
```

Le script prend 2 à 4 minutes : il choisit un Node.js assez récent, installe les paquets (front et serveur),
compile le front (`vite build`) et bundle le serveur (`esbuild`), crée `server/.env` avec une clé
`RUN_TOKEN_SECRET` générée aléatoirement, donne les bons droits aux fichiers et prépare le redémarrage.
Il peut être relancé autant de fois que nécessaire, sans rien casser.

## Étape 4 — Brancher Plesk sur le site (3 réglages)

**a) Node.js** — *Sites web et domaines* → ton domaine → **Node.js** :

| Réglage | Valeur |
|---|---|
| Version de Node.js | la plus récente installée à l'étape 1 |
| Mode de l'application | **production** |
| Racine de l'application | `/var/www/vhosts/tondomaine.tld/backrooms.tondomaine.tld/backrooms` |
| Racine du document | `httpdocs` |
| Fichier de démarrage de l'application | **`server/passenger.cjs`** |

Clique **Activer Node.js** (ou *Appliquer*). **Ne clique pas** sur « NPM install » : le script s'en est déjà chargé.

> `server/passenger.cjs` est un petit fichier CommonJS qui fait juste `import('./dist/server.mjs')` : Passenger
> charge son fichier de démarrage avec `require()`, alors que le serveur est en modules ES (voir
> `server/src/server.ts`) — l'import dynamique fait le pont entre les deux.

**b) HTTPS** — *Certificats SSL/TLS* → **Let's Encrypt** → coche la case du domaine → *Obtenir*.
Puis *Paramètres d'hébergement* → active la redirection permanente HTTP → HTTPS.

**c) Redémarrer** — dans la page **Node.js**, clique **Redémarrer l'application**.

## Étape 5 — Vérifier

Ouvre `https://backrooms.tondomaine.tld` : le menu du jeu doit s'afficher, et une partie terminée doit apparaître
dans le classement en ligne (`/api/leaderboard`).

---

## Sauvegardes

La base SQLite du classement vit dans `server/data/backrooms.sqlite`. Planifie une sauvegarde quotidienne :

*Sites web et domaines* → ton domaine → **Tâches planifiées** → *Ajouter une tâche* → *Exécuter une commande* → tous les jours à 4 h :

```
bash /var/www/vhosts/tondomaine.tld/backrooms.tondomaine.tld/backrooms/scripts/backup.sh
```

Le script trouve tout seul la bonne version de Node et fait une copie **à chaud** (API `backup()` de better-sqlite3,
sûre même avec le WAL actif) dans `server/backups/` — les 14 dernières sont gardées. **Vérifie qu'elle fonctionne** :
sur la tâche, clique *Exécuter maintenant* ; un fichier `backrooms-….sqlite` doit apparaître dans `server/backups/`.

**Copie ces sauvegardes ailleurs** régulièrement (ton PC, un autre stockage) : une sauvegarde qui reste sur le même
serveur ne protège pas d'une panne du serveur.

### Restaurer une sauvegarde

```bash
cd /var/www/vhosts/tondomaine.tld/backrooms.tondomaine.tld/backrooms
cp server/backups/backrooms-DATE.sqlite server/data/backrooms.sqlite
rm -f server/data/backrooms.sqlite-wal server/data/backrooms.sqlite-shm
bash scripts/plesk-install.sh --update --skip-install --skip-build   # redonne les droits et redémarre
```

## Mettre le site à jour

1. Sur ton PC : `git push`.
2. Dans Plesk : **Git** → **Extraire**.
3. En SSH : `bash /var/www/vhosts/tondomaine.tld/backrooms.tondomaine.tld/backrooms/scripts/plesk-install.sh --update`

Pour automatiser l'étape 3 : dans **Git** → ton dépôt → *Actions de déploiement supplémentaires* → coche l'option
et colle cette ligne, puis un simple **Extraire** suffit :

```
bash /var/www/vhosts/tondomaine.tld/backrooms.tondomaine.tld/backrooms/scripts/plesk-install.sh --update
```

## Sécurité

- **Ferme l'accès SSH du domaine** une fois l'installation terminée : *Accès à l'hébergement web* → *Accès au
  serveur via SSH* = **/bin/false**. Ne le rouvre que pour une maintenance.
- Vérifie régulièrement la version de **Plesk** et de **Node.js** (mises à jour de sécurité).
- **`server/.env`** contient `RUN_TOKEN_SECRET`, qui signe les tokens anti-triche des parties (voir
  `server/src/token.ts`) — ne le partage jamais, ne le committe jamais.
- Le dossier `backrooms/` est **en dehors** de `httpdocs` : la base SQLite et `server/.env` ne sont donc jamais
  téléchargeables directement, contrairement à un déploiement qui mettrait le code dans `httpdocs`.

---

## Dépannage

Commence toujours par ces deux commandes : elles montrent presque toujours la cause.

```bash
cd /var/www/vhosts/tondomaine.tld/backrooms.tondomaine.tld/backrooms
export PATH=/opt/plesk/node/<version>/bin:$PATH
timeout 8 node server/passenger.cjs        # démarre le site 8 secondes : affiche le message de démarrage ou l'erreur exacte
tail -n 40 /var/www/vhosts/system/backrooms.tondomaine.tld/logs/error_log   # journal d'erreurs
```

| Symptôme | Cause probable | Solution |
|---|---|---|
| **Page 500** « Internal Server Error » | L'application n'a pas démarré | Les deux commandes ci-dessus ; relance `bash scripts/plesk-install.sh` |
| Page d'accueil Plesk (« Web Server is working ») | Des fichiers restent dans `httpdocs` | Vide `httpdocs` (étape 1.5) |
| `bad option` / erreur de syntaxe au démarrage | `node` trop ancien | Installe une version plus récente (étape 1.2) et relance le script |
| Le classement ne se met pas à jour / erreur 401 sur `/api/run/*` | `server/.env` absent ou `RUN_TOKEN_SECRET` manquant | Relance `bash scripts/plesk-install.sh` |
| `readonly database`, `EACCES` | Fichiers appartenant à `root` | Relance le script en `root` : il redonne les droits |
| Page blanche après une mise à jour | Le front n'a pas été recompilé | Relance sans `--skip-build` |
| Sauvegarde : « Base introuvable » | Le site n'a jamais tourné (base pas encore créée) | Normal avant la première partie jouée ; relance après |
| Tâche planifiée : `No such file or directory` pour `node` | Chemin de Node en dur, ou shell « chrooté » | Utilise `scripts/backup.sh` (il cherche Node lui-même) ; sinon règle le shell du domaine sur `/bin/bash` |

Après toute modification de `server/.env` : **Redémarrer l'application** (page Node.js de Plesk, ou
`touch tmp/restart.txt` en SSH).
