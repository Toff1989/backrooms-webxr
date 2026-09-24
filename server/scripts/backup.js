import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env["DB_PATH"] ?? join(__dirname, "../data/backrooms.sqlite");
const BACKUP_DIR = join(__dirname, "../backups");
const KEEP = 14;

if (!existsSync(DB_PATH)) {
  console.error(`Base introuvable : ${DB_PATH} (rien à sauvegarder).`);
  process.exit(1);
}

mkdirSync(BACKUP_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(BACKUP_DIR, `backrooms-${timestamp}.sqlite`);

// Backup en ligne (API native better-sqlite3) : sûr même avec le WAL actif et la base en cours
// d'écriture par le process serveur — contrairement à une simple copie de fichier.
const db = new Database(DB_PATH, { readonly: true });
await db.backup(destination);
db.close();

console.log(`Sauvegarde créée : ${destination}`);

const backups = readdirSync(BACKUP_DIR)
  .filter((name) => name.startsWith("backrooms-") && name.endsWith(".sqlite"))
  .sort();
for (const name of backups.slice(0, -KEEP)) {
  unlinkSync(join(BACKUP_DIR, name));
  console.log(`Ancienne sauvegarde supprimée : ${name}`);
}
