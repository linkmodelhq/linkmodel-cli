# linkmodel-cli

Command-line client for the linkmodel API. It supports image and video generation
end to end: create a task, poll until it finishes, download the results.

Requires Node.js 20+.

## Install

```sh
npm i -g linkmodel-cli
```

The package installs **two names for the same command**: `lkm` (short) and
`linkmodel` (descriptive). Use whichever you prefer — all examples below use `lkm`.

## Quick start

```sh
# 1. Configure your API key (stored in ~/.linkmodel/config.json, mode 0600)
lkm auth login --api-key <your-key>

# 2. Generate your first image or video.
# Built-in defaults: image -> gpt-image-2, video -> kling-v3.
lkm image "a red panda"
lkm video "Empty cinematic establishing shot of a misty city street after rain"

# Optional: override the built-in defaults per modality
lkm config set default-image-model seedream-4.5
lkm config set default-video-model kling-v3
```

Artifacts are downloaded to the current directory as `<task_id>-<n>.<ext>`
(the extension follows the actual content type: png, jpg, webp, mp4, …).

## Commands

### `lkm image gen <prompt>`

Generate an image: create the task, poll, download.

The word `gen` may be omitted inside the modality group —
`lkm image "a red panda"` is equivalent to `lkm image gen "a red panda"`.

Image model schemas are generated from LinkModel upstream metadata. The built-in
default model is `gpt-image-2`; pass `-m <model> --help` to see that model's own
options:

```sh
lkm image gen --help
lkm image gen -m seedream-4.5 --help
lkm image gen "a product photo" -m seedream-4.5 --max-images 2
```

| Option | Description | Default |
|---|---|---|
| `-m, --model <model>` | model name (any image model) | `gpt-image-2` |
| `-q, --quality <quality>` | `low` \| `medium` \| `high` | `medium` |
| `-s, --size <size>` | image size, see constraints below | `auto` |
| `-i, --image <url...>` | reference image URL, repeatable, max 10 | — |
| `-o, --out <dir>` | download directory | `.` |
| `--no-wait` | only create the task, print the task_id, and exit | `false` |
| `--no-download` | poll to completion but only print URLs, no download | `false` |
| `--open` | after download, open every image with the system default app (macOS `open` / Linux `xdg-open` / Windows `start`); no-op with `--json`; cannot be combined with `--no-download` | `false` |
| `--json` | output a single-line JSON for scripts | `false` |
| `--timeout <min>` | polling timeout, in minutes | `15` |
| `--api-key <key>` | override the configured API key | — |

Arguments are validated locally before any request is made
(prompt length 1–32000, at most 10 reference images, size constraints below),
so obvious mistakes exit with code 2 instead of wasting an API round trip.

**Size constraints.** `--size` accepts `auto` or any `<width>x<height>` that satisfies
the official constraints (gpt-image-2 accepts any resolution meeting these):
both edges must be multiples of 16, longest edge ≤ 3840px, long-to-short ratio ≤ 3:1,
and total pixels between 655360 and 8294400 (inclusive — 3840x2160 is valid).
Popular examples: `1024x1024` (square), `1536x1024` (landscape), `1024x1536` (portrait),
`2048x1152` (2K 16:9), `3840x2160` (4K 16:9). Invalid values are rejected locally with
the exact rule they violate (exit code 2).

### `lkm image status <task_id>`

Query a single task. Prints its status; on `Success`, prints the artifact URLs.
Options: `--json`, `--api-key`.

Useful after a timeout or Ctrl-C — the task keeps running on the server,
and the timeout/interrupt message tells you the exact command to re-check it.

Add `--wait` to continue polling an existing task. With `--wait`, status behaves
like a resumed `gen`: it waits for a terminal state and downloads artifacts by
default.

```sh
lkm image status <task_id> --wait
lkm image status <task_id> --wait --no-download
```

### `lkm video gen <prompt>`

Generate a video: create the task, poll, download.

The word `gen` may be omitted inside the modality group —
`lkm video "a cinematic product orbit"` is equivalent to
`lkm video gen "a cinematic product orbit"`.

Video model schemas are generated from LinkModel upstream metadata. The built-in
default model is `kling-v3`; pass `-m <model> --help` to see that model's own
options. Without `-m`, the CLI registers the default model's options.

```sh
lkm video gen --help
lkm video gen -m kling-v3 --help
lkm video gen "Empty cinematic establishing shot of a misty city street after rain" \
  --duration 5 \
  --resolution 720P \
  --size 16x9 \
  --extends-cfg-scale 0.7

# Seedance still uses the compatibility aliases.
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
| `-m, --model <model>` | model name (any video model) | `kling-v3` |
| `-o, --out <dir>` | download directory | `.` |
| `--no-wait` | only create the task, print the task_id, and exit | `false` |
| `--no-download` | poll to completion but only print URLs, no download | `false` |
| `--open` | after download, open every video with the system default app; no-op with `--json`; cannot be combined with `--no-download` | `false` |
| `--json` | output a single-line JSON for scripts | `false` |
| `--timeout <min>` | polling timeout, in minutes | `15` |
| `--api-key <key>` | override the configured API key | — |

Selected-model options are added from the generated schema. For example,
`kling-v3` currently exposes `--duration`, `--resolution`, `--size`,
`--extends-audio`, `--extends-cfg-scale`, `--extends-negative-prompt`,
`--first-frame-image`, and `--last-frame-image`. `seedance-2-0` keeps the older
compatibility aliases `-d/--duration`, `-r/--resolution`, `-s/--size`,
`--audio`, and `--video`.

Arguments are validated locally before any request is made
(prompt length, enums, min/max values, arrays, and URL fields follow the selected
model's generated schema).

### `lkm video status <task_id>`

Query a single video task. Prints its status; on `Success`, prints the video URL.
Options: `--json`, `--api-key`.

Add `--wait` to continue polling an existing video task:

```sh
lkm video status <task_id> --wait
lkm video status <task_id> --wait --no-download
```

### `lkm auth`

Authentication remains API-Key based. `auth` is the user-facing API Key flow;
the legacy `config set api-key` command remains supported.

| Command | Description |
|---|---|
| `lkm auth login --api-key <key>` | verify the key, then save it to `~/.linkmodel/config.json` |
| `lkm auth status [--reveal] [--json]` | show current key source and masked key |
| `lkm auth logout [--json]` | remove the saved `api_key`, preserving other config fields |

### `lkm config`

| Command | Description |
|---|---|
| `lkm config set api-key <key>` | write the key to `~/.linkmodel/config.json` (mode 0600) |
| `lkm config set default-image-model <model>` | set the default model for `lkm image gen` |
| `lkm config set default-video-model <model>` | set the default model for `lkm video gen` |
| `lkm config get [api-key\|default-image-model\|default-video-model] [--reveal] [--json]` | show one config value; no name keeps the legacy API key view |
| `lkm config list [--reveal] [--json]` | show all config values |
| `lkm config models [--json]` | show configured default image/video models |
| `lkm config path` | print the config file path |

API keys are **masked by default** (`sk-8b06…fcc6`) so the key does not end up
in scrollback, logs, or screenshots; keys too short to trim safely are fully masked.
Pass `--reveal` to print the full key. `--json` follows the same rule.

### API key resolution

`--api-key` flag > `LINKMODEL_API_KEY` environment variable > `~/.linkmodel/config.json`.

Model selection uses: `-m/--model` flag > per-modality config default > built-in
default (`gpt-image-2` for image, `kling-v3` for video). Defaults are deliberately
split by modality so an image default cannot accidentally affect video generation,
or the other way around.

## Model schema maintenance

The CLI ships generated image/video model schemas, so normal command execution
does not fetch model metadata at runtime. This keeps `lkm image/video gen --help`
fast and makes option parsing deterministic.

Users can inspect the built-in schemas:

```sh
lkm models list
lkm models list --modality video
lkm models show kling-v3
lkm models show kling-v3 --json
```

| Command | Description |
|---|---|
| `npm run list` | fetch and print upstream image/video models |
| `npm run build:all` | fetch upstream parameter schemas and regenerate `src/generated/model-schemas.ts` |

Run `npm run build:all` when LinkModel adds or changes image/video models, then
review and commit the generated diff.

## Releases and updates

Release scripts wrap `npm version`:

```sh
npm run release:patch
npm run release:minor
npm run release:major
```

They update `package.json` / `package-lock.json`, create a version commit, and
create a git tag such as `v0.1.1`. A typical manual release is:

```sh
npm run release:patch
git push --follow-tags
npm publish
```

Installed CLIs do not self-update. In interactive TTY mode, `lkm` checks npm at
most once every 24 hours and prints a stderr-only notice when a newer version is
available:

```text
Update available: linkmodel-cli 0.1.0 -> 0.1.1
Run: npm install -g linkmodel-cli@latest
```

The check is skipped in `--json`, non-TTY, `--help`, and `--version` contexts.
Set `LINKMODEL_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` to disable it.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | task failed / cancelled, download failure, or other API/network error |
| `2` | usage error (invalid parameters, missing API key, unknown command) |
| `3` | authentication failed (401) |
| `4` | polling timed out — the task **keeps running** on the server; the printed task_id can be re-checked with `lkm image status <task_id>` or `lkm video status <task_id>` |
| `130` | interrupted with Ctrl-C — same as above, the task is **not** cancelled |

Scripts can rely on these codes to branch, e.g. retry on `4` but alert on `3`.

## `--json` mode

With `--json` (or when stdout is not a TTY), all animations and colors are off.
stdout carries exactly one JSON line with the structured result; all human-readable
logs go to stderr. On failure the JSON line always has `ok: false` and a non-empty,
human-readable `error` string; local validation failures additionally carry an
`errors` array with each individual message.

## Artifact URLs expire (~48 hours)

The returned artifact URLs are **OSS-signed temporary links**
(`x-oss-expires=172800`, about 48 hours). URLs obtained via `--no-download` or
`lkm image status` / `lkm video status` cannot be kept long-term — download them promptly.
The CLI prints a reminder on stderr whenever it prints URLs.

## Agent install guide

For AI agents or scripted setup, use [install.md](./install.md). It covers
Node/npm preflight, global install validation, API-Key authentication, safe
non-billing checks, and troubleshooting.

## License

MIT
