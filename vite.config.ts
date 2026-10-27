import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

const UNCONDITIONAL_TW_VARS =
  "*,:before,:after,::backdrop{--tw-rotate-x:initial;--tw-rotate-y:initial;--tw-rotate-z:initial;--tw-skew-x:initial;--tw-skew-y:initial;--tw-space-y-reverse:0;--tw-border-style:solid;--tw-leading:initial;--tw-font-weight:initial;--tw-tracking:initial;--tw-shadow:0 0 #0000;--tw-shadow-color:initial;--tw-shadow-alpha:100%;--tw-inset-shadow:0 0 #0000;--tw-inset-shadow-color:initial;--tw-inset-shadow-alpha:100%;--tw-ring-color:initial;--tw-ring-shadow:0 0 #0000;--tw-inset-ring-color:initial;--tw-inset-ring-shadow:0 0 #0000;--tw-ring-inset:initial;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-offset-shadow:0 0 #0000;--tw-backdrop-blur:initial;--tw-backdrop-brightness:initial;--tw-backdrop-contrast:initial;--tw-backdrop-grayscale:initial;--tw-backdrop-hue-rotate:initial;--tw-backdrop-invert:initial;--tw-backdrop-opacity:initial;--tw-backdrop-saturate:initial;--tw-backdrop-sepia:initial;--tw-duration:initial}";

function flattenCssForAllWebviews(raw: string): string {
  // Remove standalone @layer declarations like `@layer components;`
  let css = raw.replace(/@layer\s+[a-zA-Z0-9_-]+\s*;/g, "");

  // Unwrap @layer <name> { ... } blocks with balanced brace matching
  while (true) {
    const match = /@layer\s+([a-zA-Z0-9_-]+)\s*\{/.exec(css);
    if (!match) break;
    const layerName = match[1];
    const startIdx = match.index;
    const bodyStart = startIdx + match[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const inner = css.slice(bodyStart, i - 1);
    const replacement = layerName === "properties" ? UNCONDITIONAL_TW_VARS : inner;
    css = css.slice(0, startIdx) + replacement + css.slice(i);
  }

  return css
    .replace(/3\.40282e38px/g, "9999px")
    .replace(/oklch\([^)]+\)/g, "#10b981");
}

function inlineAndFlattenCssPlugin(): Plugin {
  return {
    name: "ares-inline-and-flatten-css",
    enforce: "post",
    generateBundle(_options, bundle) {
      let combinedCss = "";
      for (const [fileName, item] of Object.entries(bundle)) {
        if (fileName.endsWith(".css") && item.type === "asset" && typeof item.source === "string") {
          const flattened = flattenCssForAllWebviews(item.source);
          item.source = flattened;
          combinedCss += flattened + "\n";
        }
      }
      if (!combinedCss) return;
      for (const [fileName, item] of Object.entries(bundle)) {
        if (fileName.endsWith(".html") && item.type === "asset" && typeof item.source === "string") {
          item.source = item.source
            .replace(/\scrossorigin(=("[^"]*"|'[^']*'))?/g, "")
            .replace("</head>", `<style id="ares-inline-css">${combinedCss}</style></head>`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), inlineAndFlattenCssPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: ["es2020", "safari14", "chrome100"],
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
