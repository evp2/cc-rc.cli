// Replaced by esbuild's `define` at build time (see build.mjs) with the git
// SHA the build was made from. `typeof` guards it so `tsx src/cli/index.ts`
// (no esbuild pass) doesn't throw on the undeclared identifier.
declare const __CONNECTOR_VERSION__: string;

export const CONNECTOR_VERSION =
  typeof __CONNECTOR_VERSION__ !== "undefined" ? __CONNECTOR_VERSION__ : "dev";
