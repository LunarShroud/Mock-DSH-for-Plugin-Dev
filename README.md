# Mock DSH Sandbox

[中文](README.zh-CN.md) · English

A DeepSeek Harness (DSH) plugin that gives plugin development a disposable DSH
instead of the one you are working in. Each mock is a real DSH process with its
own `DSH_HOME`, profile, port, workspace, and logs, so you can install, break,
restart, or stub components without touching the live profile.

## Why

Plugins run inside the DSH Host. A broken bundle, a bad loader patch, or a profile
edit can prevent the live DSH from booting. This plugin makes the safe path the
easy path:

- **Isolated mocks** — a separate DSH home and profile per instance.
- **One tool** — `mock_dsh` starts, feeds, inspects, and removes them.
- **Component mocking** — patch a row out, or provide a stub service.
- **A reminder** — a system-prompt section tells the model to use a mock first.
- **A guard** — live-profile changes are paused with a bilingual warning until
  the user explicitly approves them.

## Requirements

- A DSH build that provides the `tools`, `systemPrompt`, `workingDirectory`, and
  `agents` services (the shipped `web` and `desktop` profiles do).
- No extra dependencies: the plugin is plain ESM and uses Node built-ins only.
- Tested on Windows 11 with DSH `0.2.1-rc.3`.

## Install

Clone or copy this directory to a stable path, then install it as a local DSH
bundle:

1. In DSH, call `plugin_manager` with `action: "install_bundle"` and the absolute
   path of this directory as `target`.
2. Keep the directory where it is. DSH installs local bundles as a link, so moving
   or deleting the checkout breaks the plugin. Remove the bundle first if you need
   to relocate it.

Reload a changed checkout by disabling and re-enabling the row
`include:mock-dsh-sandbox`, or by restarting DSH.

## Quick start

Arguments for the `mock_dsh` tool:

```json
{ "action": "start", "name": "myplugin" }
{ "action": "install", "name": "myplugin", "source": "D:/work/my-plugin" }
{ "action": "restart", "name": "myplugin" }
{ "action": "run", "name": "myplugin", "args": ["--profile", "mock", "--dump-config"] }
{ "action": "logs", "name": "myplugin", "lines": 80 }
{ "action": "destroy", "name": "myplugin" }
```

`start` prints the mock's URL, root directory, isolated home, and log path. Open
the URL to inspect the mock's Web UI (the URL carries its own access token).

## Tool reference

| Parameter | Meaning |
|---|---|
| `action` | Required: `start`, `restart`, `install`, `run`, `logs`, `list`, `stop`, or `destroy`. |
| `name` | Instance name; default `dev`. Lowercase letters, digits, and hyphens, up to 32 characters. |
| `template` | Shipped profile template used when a new mock profile is created; default `web`. |
| `port` | Listen port for a new mock; `0` (default) lets the OS choose. |
| `patches` | Loader patch files, absolute or relative to the session workspace, applied when the mock starts. |
| `source` | `install`: a local bundle directory or a package spec. |
| `args` | `run`: dsh CLI arguments for a short-lived command. |
| `lines` | `logs`: number of trailing lines; default 40. |

| Action | Effect |
|---|---|
| `start` | Create the isolated home/profile if needed, boot `dsh --profile mock --port <n> --no-open`, wait for the URL. |
| `restart` | Stop and boot again with the stored template, port, and patches. |
| `install` | Run `dsh plugin --profile mock add <source>` with the mock's `DSH_HOME`. |
| `run` | Run short-lived dsh CLI arguments with the mock's `DSH_HOME` and working directory. |
| `logs` | Tail the mock's boot log. |
| `list` | Show every instance and whether its process is alive. |
| `stop` | End the process; files remain. |
| `destroy` | Stop and delete the instance tree. |

## Instance layout

Instances live under `<session working directory>/.dsh-mock/instances/<name>/`:

```text
dev/
  home/        # DSH_HOME, including profiles/mock
  workspace/   # the mock's working directory
  logs/        # dsh.log, profile-init.log, install-*.log, run-*.log
  record.json  # name, pid, url, paths, patches, timestamps
```

A mock starts from the shipped `web` template, not from the live profile. Its
`home` has no credentials copied from the real DSH, so the mock is signed out
until you sign in there.

## Mocking a component

Components are replaced in the mock, never in the live profile.

**Override or disable a row** with a loader patch:

```yaml
# patches/no-web-tools.yml
- id: tool-web
  disabled: true
```

Pass it to `start` or `restart`:

```json
{ "action": "start", "name": "myplugin", "patches": ["patches/no-web-tools.yml"] }
```

**Provide a stub service** by authoring a small bundle whose patch inserts a row
with the same service, then install it into the mock and restart:

```json
{ "action": "install", "name": "myplugin", "source": "D:/work/my-stub-bundle" }
{ "action": "restart", "name": "myplugin" }
```

Inspect the composed tree after either change:

```json
{ "action": "run", "args": ["--profile", "mock", "--dump-config"], "name": "myplugin" }
```

The full dump is written to the returned log path; the tool result shows the tail.

## Live-profile guard

Outside a mock, the plugin watches model tool calls that would change the DSH it
runs in:

- `plugin_manager` actions that install, remove, enable, or disable a plugin or
  bundle, including version exemptions;
- `write` / `edit` on a file under `DSH_PROFILE_DIR` or any
  `DSH_HOME/profiles/<name>`;
- `pwsh` / `bash` commands that install into a profile (`dsh plugin`,
  `--from-default-profile`) or rewrite a profile file.

When such a call needs an approval anyway, the guard prepends a bilingual warning
to the existing prompt and keeps the normal allow/deny choice. When the session
would let the call run without a prompt, the guard raises one itself. Under the
`never` approval policy it fails closed. Denying the prompt leaves the live
profile unchanged; the model should retry in a mock.

The guard is inactive inside a mock: instances are spawned with
`DSH_MOCK_INSTANCE`, and a `DSH_HOME` under `.dsh-mock/instances` is recognized
as well.

## Isolation and cleanup

- Every spawned command gets `DSH_HOME`, `DSH_PROFILE`, and
  `DSH_PROFILE_DIR` pointing into the instance; the real profile is never used.
- The mock listens on a free port with `--no-open`; stdout and stderr go to the
  instance log.
- `stop` kills the process tree (`taskkill /T /F` on Windows, `SIGTERM` then
  `SIGKILL` elsewhere) and verifies that the recorded PID is gone. A PID left by
  a previous Host is checked against the process image before it is terminated.
- `destroy` validates that the target is an instance directory inside
  `.dsh-mock/instances` before deleting it.
- Disabling the plugin kills the mocks it still owns; mocks orphaned by a Host
  crash remain listed and can be stopped or destroyed later.

## Safety and limitations

- Each mock is a real DSH process: expect memory, CPU, and a listening port while
  it runs. Use `stop` or `destroy` when done.
- Profile protection is path-based; symlinks or unusual path spellings are not
  resolved specially.
- Shell-command detection is heuristic. It recognizes the documented dsh/pnpm and
  profile-write patterns, not arbitrary PowerShell or Bash.
- The guard covers model tool calls, not actions a human performs directly in the
  DSH UI.
- Windows is the tested path. The POSIX termination branch is implemented but has
  not been exercised here.
- Installing packages into the mock uses pnpm and may create a package store
  outside the instance directory.

## Development

There is no build step. Edit `index.js`, then check syntax:

```bash
node --check index.js
```

To load a changed checkout in a running DSH, disable and re-enable the
`include:mock-dsh-sandbox` row with `plugin_manager`, or restart DSH. Exercise the
tool against a fresh instance (`start`, `list`, `stop`, `destroy`) before
installing the change into the live profile.

## Repository layout

```text
.
├── index.js             # Host plugin: mock_dsh, prompt reminder, live-profile guard
├── cordis.patch.yml     # Bundle patch that inserts the plugin row
├── package.json         # DSH bundle manifest and locale/icon exports
├── locale/en.json       # English title and description
├── locale/zh.json       # Chinese title and description
├── icon.svg             # Original plugin icon
├── README.md            # This file
└── README.zh-CN.md      # Chinese README
```
