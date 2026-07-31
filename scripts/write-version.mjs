import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const content = `export const PACKAGE_NAME = ${JSON.stringify(pkg.name)};\nexport const VERSION = ${JSON.stringify(pkg.version)};\n`;

fs.writeFileSync('src/generated/version.ts', content);
