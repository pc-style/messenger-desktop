const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const preloadDir = path.join(__dirname, "..", "src", "preload");
const outDir = path.join(__dirname, "..", "build", "preload");

// ensure output directory exists
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// find all entry points (files that are directly imported by main process)
const entryPoints = [
  path.join(preloadDir, "index.ts"),
  path.join(preloadDir, "dialog.ts"),
  path.join(preloadDir, "chat-head.ts"),
];

// bundle each entry point into a single .cjs file
// this is required for sandboxed preload scripts which cannot use require() for local files
async function build() {
  for (const entry of entryPoints) {
    if (!fs.existsSync(entry)) {
      console.warn(`Skipping ${entry} (not found)`);
      continue;
    }

    const basename = path.basename(entry, ".ts");
    const outfile = path.join(outDir, `${basename}.cjs`);

    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      target: "node18",
      format: "cjs",
      outfile,
      sourcemap: true,
      external: ["electron"],
      // minify for production but keep readable for debugging
      minify: false,
    });

    console.log(`Built ${basename}.cjs`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
