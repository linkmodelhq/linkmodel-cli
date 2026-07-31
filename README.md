# LinkModel CLI

[![npm version](https://img.shields.io/npm/v/linkmodel-cli.svg)](https://www.npmjs.com/package/linkmodel-cli)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

Official command-line client for the LinkModel API. Generate images and videos
from your terminal with a complete task lifecycle: create, poll, download, and
resume.

```sh
lkm image "a clean product photo of a white sneaker on glass"
lkm video "Empty cinematic establishing shot of a misty city street after rain"
```

## Highlights

- Image and video generation in one CLI.
- Built-in modality defaults: `gpt-image-2` for images and `kling-v3` for videos.
- Dynamic model-specific options generated from LinkModel model schemas.
- Blocking generation by default, with `--no-wait` and resumable `status --wait`.
- Artifact download, URL-only output, and optional `--open` support.
- Script-friendly `--json` output with stable exit codes.
- API-Key authentication with masked local config.

## Requirements

- Node.js 20 or newer.
- A LinkModel API key.

## Agent Install Guide

AI agents and automated installers should start with [install.md](./install.md).
It is the canonical runbook for safe installation and validation, including:

- Node/npm preflight checks.
- Global install and silent install commands.
- Non-billing validation with `lkm doctor --json`.
- API-Key authentication without exposing secrets.
- Exit codes, JSON output, and troubleshooting guidance.

Copy this prompt into an AI agent:

```text
Install and validate the LinkModel CLI on this machine.

Use the official AI install guide:
https://github.com/linkmodelhq/linkmodel-cli/blob/main/install.md

Follow these rules:
- Install with npm: npm install -g linkmodel-cli
- Verify with lkm --version, lkm --help, and lkm doctor --json
- If no API key is configured, guide me to create one at https://www.linkmodel.ai/
- Use lkm auth login --api-key <key> only through a secure local channel
- Never print, log, or commit the full API key
- Prefer --json for automation
- Do not run paid image or video generation unless I explicitly ask for it
```

## Installation

```sh
npm install -g linkmodel-cli
```

The package installs two command names:

- `lkm`: short command used in this README.
- `linkmodel`: descriptive alias with the same behavior.

Verify the install:

```sh
lkm --version
lkm --help
```

Global installs print a short next-step hint. Set
`LINKMODEL_SKIP_POSTINSTALL=1` to silence that message in automated environments.

If you do not have an API key yet, create one from your LinkModel account at
[linkmodel.ai](https://www.linkmodel.ai/), then run:

```sh
lkm auth login --api-key <your-api-key>
```

## Quick Start

Run the interactive setup:

```sh
lkm setup
```

`setup` shows current configuration first, then lets you configure an API key,
default models, or both. Press `Ctrl-C` at any time to cancel.

Or configure your API key directly:

```sh
lkm auth login --api-key <your-api-key>
```

Generate an image:

```sh
lkm image "a red panda wearing round glasses"
```

Generate a video:

```sh
lkm video "Empty cinematic establishing shot of a misty city street after rain"
```

Artifacts are downloaded to the current directory as:

```text
<task_id>-<n>.<ext>
```

The file extension follows the actual content type, such as `png`, `jpg`,
`webp`, or `mp4`.

## Authentication

Authentication is API-Key based.

```sh
lkm setup
lkm auth login --api-key <your-api-key>
lkm auth status
lkm auth logout
```

`lkm setup` is an interactive first-time setup flow. It verifies and saves your
API key, then optionally lets you choose default image and video models.

Saved credentials are written to:

```text
~/.linkmodel/config.json
```

The config file is created with mode `0600`. API keys are masked by default in
human and JSON output.

API key resolution order:

```text
--api-key > LINKMODEL_API_KEY > ~/.linkmodel/config.json
```

## Image Generation

`gen` is optional inside the `image` group:

```sh
lkm image "a red panda"
lkm image gen "a red panda"
```

The built-in image default is `gpt-image-2`.

```sh
lkm image gen --help
lkm image gen -m seedream-4.5 --help
lkm image gen "a product photo" -m seedream-4.5 --max-images 2
```

Common options:

| Option | Description | Default |
|---|---|---|
| `-m, --model <model>` | Image model name | `gpt-image-2` |
| `-q, --quality <quality>` | `low`, `medium`, or `high` | `medium` |
| `-s, --size <size>` | `auto` or `<width>x<height>` | `auto` |
| `-i, --image <url...>` | Reference image URL, repeatable, max 10 | None |
| `-o, --out <dir>` | Download directory | `.` |
| `--no-wait` | Create the task and exit with `task_id` | `false` |
| `--no-download` | Wait for completion and print URLs only | `false` |
| `--open` | Open downloaded artifacts with the system default app | `false` |
| `--json` | Print one JSON line for automation | `false` |
| `--timeout <min>` | Polling timeout in minutes | `15` |
| `--api-key <key>` | Override configured authentication | None |

Image size validation happens locally before a request is sent. `--size` accepts
`auto` or any `<width>x<height>` that satisfies the model constraints:

- both edges are multiples of 16;
- longest edge is at most `3840px`;
- long-to-short ratio is at most `3:1`;
- total pixels are between `655360` and `8294400`, inclusive.

Useful examples:

```sh
lkm image "square app icon" -s 1024x1024
lkm image "wide product banner" -s 2048x1152
lkm image "portrait poster" -s 1024x1536
lkm image "4K cinematic frame" -s 3840x2160
```

## Video Generation

`gen` is optional inside the `video` group:

```sh
lkm video "a cinematic product orbit"
lkm video gen "a cinematic product orbit"
```

The built-in video default is `kling-v3`.

```sh
lkm video gen --help
lkm video gen -m kling-v3 --help
lkm video gen "Empty cinematic establishing shot of a misty city street after rain" \
  --duration 5 \
  --resolution 720P \
  --size 16x9 \
  --extends-cfg-scale 0.7
```

Seedance compatibility aliases are also supported:

```sh
lkm video gen "a product orbit" \
  -m seedance-2-0 \
  -d 6 \
  -r 720P \
  -s 16x9 \
  --first-frame-image https://example.com/first.png
```

Common options:

| Option | Description | Default |
|---|---|---|
| `-m, --model <model>` | Video model name | `kling-v3` |
| `-o, --out <dir>` | Download directory | `.` |
| `--no-wait` | Create the task and exit with `task_id` | `false` |
| `--no-download` | Wait for completion and print URLs only | `false` |
| `--open` | Open downloaded artifacts with the system default app | `false` |
| `--json` | Print one JSON line for automation | `false` |
| `--timeout <min>` | Polling timeout in minutes | `15` |
| `--api-key <key>` | Override configured authentication | None |

Selected-model options are registered from generated schemas. For example,
`kling-v3` exposes options such as `--duration`, `--resolution`, `--size`,
`--extends-audio`, `--extends-cfg-scale`, `--extends-negative-prompt`,
`--first-frame-image`, and `--last-frame-image`.

## Task Status and Resume

Use `status` to inspect a task after `--no-wait`, timeout, or Ctrl-C.

```sh
lkm image status <task_id>
lkm video status <task_id>
```

Add `--wait` to resume polling and download artifacts after completion:

```sh
lkm image status <task_id> --wait
lkm video status <task_id> --wait --no-download
```

Server-side tasks continue running after local timeout or interruption. The CLI
prints the exact status command to continue from the saved `task_id`.

## Diagnostics

Run local diagnostics when an install, config, or authentication issue is not
obvious:

```sh
lkm doctor
lkm doctor --json
```

`doctor` checks the Node.js version, CLI version, config file, API key source,
API key validity, and npm update status.

## Model Defaults

Model selection order:

```text
-m/--model > per-modality config default > built-in default
```

Built-in defaults:

| Modality | Default model |
|---|---|
| Image | `gpt-image-2` |
| Video | `kling-v3` |

Configure your own defaults:

```sh
lkm config set default-image-model seedream-4.5
lkm config set default-video-model kling-v3
lkm config models
```

Defaults are intentionally separated by modality so image settings never affect
video generation, and video settings never affect image generation.

## Model Schemas

The CLI ships generated model schemas for image and video models. Normal command
execution does not fetch metadata at runtime, so help output is fast and option
parsing is deterministic.

Inspect bundled schemas:

```sh
lkm models list
lkm models list --modality video
lkm models show kling-v3
lkm models show kling-v3 --json
```

Maintain generated schemas:

```sh
npm run list
npm run build:all
```

Run `npm run build:all` when LinkModel adds or changes image or video models,
then review and commit the generated diff.

## JSON Output

Use `--json` for scripts and agents:

```sh
lkm image "a red panda" --json
lkm video status <task_id> --wait --json
```

In JSON mode, stdout contains exactly one JSON line. Human-readable logs go to
stderr. On failure, the JSON line always includes:

```json
{
  "ok": false,
  "error": "human-readable error"
}
```

Local validation failures may also include an `errors` array.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Task failed, task cancelled, download failure, or API/network error |
| `2` | Usage error, invalid parameters, missing API key, or unknown command |
| `3` | Authentication failed |
| `4` | Polling timed out; the server task keeps running |
| `130` | Interrupted with Ctrl-C; the server task keeps running |

Scripts can retry or resume on `4`, and should treat `3` as an authentication
problem.

## Artifact URLs

Artifact URLs are temporary signed links and usually expire after about 48 hours.
Download artifacts promptly when using `--no-download` or `status`.

## Development

```sh
npm install
npm run build
npm test
```

Useful scripts:

| Command | Description |
|---|---|
| `npm run check:i18n` | Ensure project-facing source and docs stay English-only |
| `npm run list` | Fetch and print upstream image/video models |
| `npm run build:all` | Regenerate bundled model schemas |
| `npm run release:patch` | Create a patch version commit and tag |
| `npm run release:minor` | Create a minor version commit and tag |
| `npm run release:major` | Create a major version commit and tag |

Release manually:

```sh
npm run release:patch
git push --follow-tags
npm publish
```

Installed CLIs do not self-update. In interactive TTY mode, `lkm` checks npm at
most once every 24 hours and prints a stderr-only update notice when a newer
version is available.

Disable update checks:

```sh
LINKMODEL_NO_UPDATE_CHECK=1 lkm --help
NO_UPDATE_NOTIFIER=1 lkm --help
```

## License

MIT
