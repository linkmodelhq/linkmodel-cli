import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'test'];
const EXTRA_FILES = ['README.md', 'install.md', 'package.json', '.gitignore'];
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const files = [
  ...ROOTS.flatMap((root) => walk(root)),
  ...EXTRA_FILES.filter((file) => fs.existsSync(file)),
].filter((file) => /\.(ts|mts|cts|js|mjs|cjs|json|md|gitignore)$/.test(file));

const offenders = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (CJK_PATTERN.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  console.error('CJK text is not allowed in project source, tests, or user-facing docs.');
  for (const offender of offenders) console.error(offender);
  process.exit(1);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'test-dist' || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}
