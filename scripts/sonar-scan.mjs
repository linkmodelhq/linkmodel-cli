import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// Read token from environment, .sonar.env, or fallback shared-infra token
let token = process.env.SONAR_TOKEN;
const envFile = resolve(rootDir, '.sonar.env');
const sharedEnvFile = resolve('C:/development/github/shared-infra/sonarqube/.env');

if (!token && existsSync(envFile)) {
  const content = readFileSync(envFile, 'utf8');
  const match = content.match(/SONAR_TOKEN=([^\r\n]+)/);
  if (match) token = match[1].trim();
}

if (!token && existsSync(sharedEnvFile)) {
  const content = readFileSync(sharedEnvFile, 'utf8');
  const match = content.match(/SONAR_TOKEN=([^\r\n]+)/);
  if (match) token = match[1].trim();
}

if (!token) {
  console.error('[sonar] Error: SONAR_TOKEN not found in env, .sonar.env, or shared-infra/sonarqube/.env');
  process.exit(1);
}

const hostUrl = process.env.SONAR_HOST_URL || 'http://host.docker.internal:9000';

console.log(`[sonar] Starting SonarScanner via Docker against ${hostUrl}...`);

const dockerArgs = [
  'run',
  '--rm',
  '-v',
  `${rootDir.replace(/\\/g, '/')}:/usr/src`,
  '-e',
  `SONAR_HOST_URL=${hostUrl}`,
  '-e',
  `SONAR_TOKEN=${token}`,
  'sonarsource/sonar-scanner-cli',
  '-Dsonar.qualitygate.wait=true',
];

const res = spawnSync('docker', dockerArgs, {
  cwd: rootDir,
  shell: true,
  stdio: 'inherit',
});

if (res.status === 0) {
  console.log('\n[sonar] Quality Gate: PASSED');
} else {
  console.error(`\n[sonar] Quality Gate: FAILED or Scanner exited with code ${res.status}`);
  process.exit(res.status ?? 1);
}
