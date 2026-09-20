import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(root, "worker/firebase-messaging-sw.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: path.join(root, "dist/firebase-messaging-sw.js"),
  sourcemap: false,
  minify: true
});

console.log("Built firebase-messaging-sw.js into web/dist successfully");
