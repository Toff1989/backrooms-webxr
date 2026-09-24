declare module "*.glb" {
  const url: string;
  export default url;
}

declare module "*.ktx2" {
  const url: string;
  export default url;
}

/** Identifiant de build (commit + date), injecté par vite.config.ts. */
declare const __BUILD_ID__: string;
