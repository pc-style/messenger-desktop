const fs = require("fs");
const path = require("path");

const preloadDir = path.join(__dirname, "..", "build", "preload");

if (!fs.existsSync(preloadDir)) {
  process.exit(0);
}

const files = fs.readdirSync(preloadDir).filter((file) => file.endsWith(".js"));

const rewriteRequires = (content) =>
  content
    .replace(/require\(["'](\.{1,2}\/[^"']+)\.js["']\)/g, 'require("$1.cjs")')
    .replace(/sourceMappingURL=([^\s]+)\.js\.map/g, "sourceMappingURL=$1.cjs.map");

files.forEach((file) => {
  const sourcePath = path.join(preloadDir, file);
  const targetPath = path.join(preloadDir, file.replace(/\.js$/, ".cjs"));
  const mapPath = `${sourcePath}.map`;
  const targetMapPath = `${targetPath}.map`;

  let content = fs.readFileSync(sourcePath, "utf8");
  content = rewriteRequires(content);

  fs.writeFileSync(targetPath, content);
  fs.unlinkSync(sourcePath);

  if (fs.existsSync(mapPath)) {
    let mapContent = fs.readFileSync(mapPath, "utf8");
    mapContent = mapContent.replace(/\.js\"/g, ".cjs\"");
    fs.writeFileSync(targetMapPath, mapContent);
    fs.unlinkSync(mapPath);
  }
});
