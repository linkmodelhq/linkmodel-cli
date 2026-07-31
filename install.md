# linkmodel-cli Install Guide for AI Agents

This document is for AI agents installing and validating `linkmodel-cli` on a
user machine. The npm package name is `linkmodel-cli`; the commands are `lkm`
and `linkmodel`.

## Copy Prompt

Give this prompt to an AI agent:

```text
Install and validate the LinkModel CLI on this machine.

Use the official AI install guide:
https://github.com/linkmodelhq/linkmodel-cli/blob/main/install.md

Follow these rules:
- Install with npm: npm install -g linkmodel-cli
- Verify with lkm --version, lkm --help, and lkm doctor --json
- Use lkm auth login --api-key <key> only through a secure local channel
- Never print, log, or commit the full API key
- Prefer --json for automation
- Do not run paid image or video generation unless I explicitly ask for it
```

## 1. Preflight

Check the environment before installing:

```sh
node -v
npm -v
```

Requirements:

- Node.js 20 or newer.
- npm available in PATH.
- Network access to the npm registry.

Use npm for the global install:

```sh
npm install -g linkmodel-cli
```

Global installs print a short next-step hint. For silent automation, set:

```sh
LINKMODEL_SKIP_POSTINSTALL=1 npm install -g linkmodel-cli
```

Validate the installed command:

```sh
lkm --version
which lkm
```

On Windows, use `where lkm` instead of `which lkm`.

If `lkm` is not found, inspect the global npm bin path:

```sh
npm prefix -g
```

Ensure the corresponding `bin` directory is in PATH.

## 2. Authentication

Authentication is API-Key based. Do not print the full API key in chat,
repository files, logs, screenshots, or generated skills.

Check current auth state:

```sh
lkm auth status --json
```

For interactive local setup, use:

```sh
lkm setup
```

`lkm setup` prints the current configuration first and can be cancelled with
Ctrl-C.

If no key is configured, ask the user for a LinkModel API key through the secure
local channel available in the current environment, then run the command in the
user terminal:

```sh
lkm auth login --api-key <key>
```

`auth login` verifies the key before saving it to:

```text
~/.linkmodel/config.json
```

The config file is written with mode `0600`.

After login, verify again:

```sh
lkm auth status --json
```

Only report masked values from the JSON output unless the user explicitly asks
to reveal a key locally.

Alternative API key sources:

- `--api-key <key>` for a single command.
- `LINKMODEL_API_KEY` environment variable.
- `lkm config set api-key <key>` for the legacy config path.

Resolution priority:

```text
--api-key > LINKMODEL_API_KEY > ~/.linkmodel/config.json
```

## 3. Non-Billing Validation

Do not run an image or video generation just to verify installation unless the
user explicitly asks for a paid generation test.

Use these safe checks:

```sh
lkm --help
lkm doctor --json
lkm auth status --json
lkm models list --json
lkm models show kling-v3 --json
```

## 4. Generation Examples

Create and wait for an image:

```sh
lkm image "a red panda"
```

Create and wait for a video:

```sh
lkm video "Empty cinematic establishing shot of a misty city street after rain"
```

Create only, then continue waiting later:

```sh
lkm video "A quiet empty street after rain" --no-wait
lkm video status <task_id> --wait
```

Print URLs without downloading:

```sh
lkm image "a red panda" --no-download
lkm video status <task_id> --wait --no-download
```

## 5. Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| `lkm: command not found` | Global npm bin not in PATH | Check `npm prefix -g` and PATH |
| Engine error during install | Node.js too old | Upgrade to Node.js 20+ |
| Auth exits with code 3 | Missing or invalid API key | Re-run `lkm auth login --api-key <key>` |
| Usage exits with code 2 | Missing key or invalid parameters | Read stderr or JSON `error` |
| Doctor exits with code 1 | A required local or auth check failed | Inspect `lkm doctor` output |
| Polling exits with code 4 | Task is still running | Run `lkm image status <task_id> --wait` or `lkm video status <task_id> --wait` |
| URL no longer downloads | Signed artifact URL expired | Re-query status if possible, otherwise regenerate |

## 6. Safety Rules for Agents

- Never commit API keys.
- Never include full API keys in responses.
- Prefer `--json` in automation.
- Set `NO_COLOR=1` when plain text logs are required.
- Treat generated artifact URLs as temporary signed links.
