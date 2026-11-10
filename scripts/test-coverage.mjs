import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const coverageDir = resolve(rootDir, 'coverage');
const rawLcovPath = resolve(coverageDir, 'lcov.raw.info');
const cleanLcovPath = resolve(coverageDir, 'lcov.info');

if (!existsSync(coverageDir)) {
  mkdirSync(coverageDir, { recursive: true });
}

console.log('[coverage] Building test distribution...');
const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.test.json'], {
  cwd: rootDir,
  shell: true,
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error('[coverage] Build failed');
  process.exit(build.status ?? 1);
}

console.log('[coverage] Running test suite with lcov coverage reporter...');
const testRun = spawnSync(
  'node',
  [
    '--experimental-test-coverage',
    '--test-reporter=lcov',
    `--test-reporter-destination=${rawLcovPath}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test',
    'test-dist/test/*.test.js',
  ],
  {
    cwd: rootDir,
    shell: true,
    stdio: 'inherit',
  }
);

if (!existsSync(rawLcovPath)) {
  console.error('[coverage] Raw lcov file was not generated.');
  process.exit(1);
}

// Remap paths: test-dist/src/*.js -> src/*.ts, drop test-dist/test/
const rawContent = readFileSync(rawLcovPath, 'utf8');
const lines = rawContent.split(/\r?\n/);
const remapped = [];
let skipRecord = false;
const stats = {};
let currentFile = '';

for (const line of lines) {
  if (line.startsWith('SF:')) {
    let p = line.slice(3).trim().replace(/\\/g, '/');
    if (p.includes('test-dist/test') || p.includes('test/')) {
      skipRecord = true;
    } else {
      skipRecord = false;
      p = p.replace(/^test-dist\//, '').replace(/\.js$/, '.ts');
      currentFile = p;
      if (!stats[currentFile]) {
        stats[currentFile] = { found: 0, hit: 0 };
      }
      remapped.push(`SF:${p}`);
    }
  } else if (line === 'end_of_record') {
    if (!skipRecord) {
      remapped.push(line);
    }
    skipRecord = false;
    currentFile = '';
  } else {
    if (!skipRecord) {
      remapped.push(line);
      if (line.startsWith('DA:')) {
        const parts = line.slice(3).split(',');
        const hit = Number(parts[1]);
        if (currentFile && stats[currentFile]) {
          stats[currentFile].found++;
          if (hit > 0) stats[currentFile].hit++;
        }
      }
    }
  }
}

writeFileSync(cleanLcovPath, remapped.join('\n'));
console.log(`\n[coverage] Normalized lcov saved to: ${cleanLcovPath}`);

console.log('\n============================= COVERAGE REPORT =============================');
console.log('File                                            | Lines Hit / Found | Percent');
console.log('------------------------------------------------+-------------------+--------');

let totalFound = 0;
let totalHit = 0;
let coreFound = 0;
let coreHit = 0;

for (const [file, s] of Object.entries(stats).sort()) {
  const pct = s.found > 0 ? ((s.hit / s.found) * 100).toFixed(1) : '100.0';
  totalFound += s.found;
  totalHit += s.hit;

  const isExcludedFromGate = file.includes('generated/') || file.includes('setup.ts');
  if (!isExcludedFromGate) {
    coreFound += s.found;
    coreHit += s.hit;
  }

  const paddedFile = file.padEnd(47, ' ');
  const counts = `${s.hit}/${s.found}`.padStart(17, ' ');
  const flag = isExcludedFromGate ? ' (excluded)' : '';
  console.log(`${paddedFile} | ${counts} | ${pct.padStart(6, ' ')}%${flag}`);
}

const totalPct = totalFound > 0 ? ((totalHit / totalFound) * 100).toFixed(1) : '100.0';
const corePct = coreFound > 0 ? ((coreHit / coreFound) * 100).toFixed(1) : '100.0';

console.log('------------------------------------------------+-------------------+--------');
console.log(`${'TOTAL (All files)'.padEnd(47, ' ')} | ${`${totalHit}/${totalFound}`.padStart(17, ' ')} | ${totalPct.padStart(6, ' ')}%`);
console.log(`${'CORE COVERAGE (Sonar Gate scope)'.padEnd(47, ' ')} | ${`${coreHit}/${coreFound}`.padStart(17, ' ')} | ${corePct.padStart(6, ' ')}%`);
console.log('===========================================================================\n');

if (process.env.CHECK_GATE === 'true' || process.argv.includes('--check-gate')) {
  const target = Number(process.env.GATE_TARGET ?? 95);
  if (Number(corePct) < target) {
    console.error(`[gate] FAILED: Core coverage is ${corePct}%, which is below the target ${target}%.`);
    process.exit(1);
  } else {
    console.log(`[gate] PASSED: Core coverage is ${corePct}% (>= ${target}%).`);
  }
}
