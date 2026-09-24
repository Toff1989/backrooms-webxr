// Point d'entrée pour Phusion Passenger (Plesk → extension Node.js Toolkit).
// Passenger charge son fichier de démarrage avec require(), alors que le serveur (dist/server.mjs,
// généré par `npm run build`) est en modules ES avec du await de haut niveau, non chargeable par
// require() : on passe par un import() dynamique, qui fonctionne dans tous les cas.
// Passenger intercepte ensuite l'appel à listen() du serveur : le port n'a pas d'importance.
import("./dist/server.mjs").catch((error) => {
  console.error(error);
  process.exit(1);
});
