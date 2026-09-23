// Process PM2 (fiche projet étape 8, déploiement Plesk via SSH — voir deploy/README.md).
// `.cjs` : PM2 charge sa config en CommonJS même si le reste du projet est en ESM.
module.exports = {
  apps: [
    {
      name: "backrooms-vr-server",
      cwd: __dirname,
      script: "node_modules/.bin/tsx",
      args: "src/server.ts",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "8787",
        HOST: "127.0.0.1",
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
