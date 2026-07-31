#!/usr/bin/env node

const truthy = new Set(['1', 'true', 'yes']);

function isTruthy(value) {
  return typeof value === 'string' && truthy.has(value.toLowerCase());
}

if (
  isTruthy(process.env.CI) ||
  isTruthy(process.env.LINKMODEL_SKIP_POSTINSTALL) ||
  isTruthy(process.env.npm_config_json)
) {
  process.exit(0);
}

const isGlobalInstall =
  process.env.npm_config_global === 'true' ||
  process.env.npm_config_location === 'global';

if (!isGlobalInstall) {
  process.exit(0);
}

process.stderr.write(`
LinkModel CLI installed.

Start:
  lkm setup
  lkm --help

`);
