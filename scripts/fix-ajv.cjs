const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// fix bun's incomplete package installs for some deps
const fixPackages = ["agent-base", "https-proxy-agent", "http-proxy-agent"];
const nodeModules = path.join(__dirname, "..", "node_modules");

for (const pkg of fixPackages) {
  const pkgPath = path.join(nodeModules, pkg);
  const distPath = path.join(pkgPath, "dist");
  if (fs.existsSync(pkgPath) && !fs.existsSync(distPath)) {
    console.log(`Fixing incomplete package: ${pkg}`);
    try {
      execSync(`npm install ${pkg} --prefix "${path.dirname(nodeModules)}" --ignore-scripts`, {
        stdio: "inherit",
      });
    } catch (e) {
      // ignore errors, npm might not be available
    }
  }
}

// typescript compile ajv if needed
let ts;
try {
  ts = require("typescript");
} catch {
  process.exit(0);
}

const ajvRoot = path.join(nodeModules, "ajv");
const distRoot = path.join(ajvRoot, "dist");
const libRoot = path.join(ajvRoot, "lib");

const hasDist = fs.existsSync(path.join(distRoot, "ajv.js"));
if (!fs.existsSync(ajvRoot) || !fs.existsSync(libRoot) || hasDist) {
  process.exit(0);
}

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
      sourceMap: false,
    },
  }).outputText;

const copyNonTs = (from, to) => {
  const entries = fs.readdirSync(from, { withFileTypes: true });
  entries.forEach((entry) => {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      ensureDir(destPath);
      copyNonTs(srcPath, destPath);
      return;
    }
    if (!entry.name.endsWith(".ts")) {
      fs.copyFileSync(srcPath, destPath);
    }
  });
};

const compileDir = (from, to) => {
  const entries = fs.readdirSync(from, { withFileTypes: true });
  entries.forEach((entry) => {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      ensureDir(destPath);
      compileDir(srcPath, destPath);
      return;
    }
    if (entry.name.endsWith(".ts")) {
      const outPath = destPath.replace(/\.ts$/, ".js");
      const source = fs.readFileSync(srcPath, "utf8");
      fs.writeFileSync(outPath, transpile(source));
    }
  });
};

ensureDir(distRoot);
copyNonTs(libRoot, distRoot);
compileDir(libRoot, distRoot);
