const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ajvRoot = path.join(__dirname, "..", "node_modules", "ajv");
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
