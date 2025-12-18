const fs = require('fs');
const path = require('path');

const type = process.argv[2] || 'patch';
const pkgPath = path.join(__dirname, '..', 'package.json');
const versionPath = path.join(__dirname, '..', '.version');
const preloadPath = path.join(__dirname, '..', 'preload.js');

if (!['patch', 'minor', 'major'].includes(type)) {
  console.error('Invalid bump type. Use patch, minor, or major.');
  process.exit(1);
}

// Update package.json
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
const parts = oldVersion.split('.').map(Number);

if (type === 'major') parts[0]++;
if (type === 'minor') parts[1]++;
if (type === 'patch') parts[2]++;

if (type === 'major') parts[1] = 0;
if (type === 'major' || type === 'minor') parts[2] = 0;

const newVersion = parts.join('.');
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Update .version
fs.writeFileSync(versionPath, `v${newVersion}\n`);

// Update preload.js
let preloadContent = fs.readFileSync(preloadPath, 'utf8');
const versionRegex = /subTitle\.textContent = 'v\d+\.\d+\.\d+ — Settings'/;
const newPreloadStr = `subTitle.textContent = 'v${newVersion} — Settings'`;

if (versionRegex.test(preloadContent)) {
  preloadContent = preloadContent.replace(versionRegex, newPreloadStr);
  fs.writeFileSync(preloadPath, preloadContent);
}

console.log(`Bumped version from ${oldVersion} to ${newVersion} (${type})`);
