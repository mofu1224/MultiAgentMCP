---
type: guide
---
# MultiAgentMCP

[日本語（詳細仕様）](README.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

A local **stdio MCP server** for delegating tasks to Codex CLI, Claude Code, or a configured OpenAI-compatible text API. The parent chooses a user-approved model and effort for each task. Model identifiers are discovered at runtime, not hard-coded.

This is an independent project, not an official OpenAI or Anthropic product. Use the official CLIs, your own authentication, and comply with each service's terms and usage limits.

## Safety first

**Omitting `permission` means `full-access`.** A full-access child runs with your OS user's access to files, credentials, and networking. Its `cwd` is not a security boundary. Use it only for trusted tasks.

- `read-only` / `workspace-write`: provider-native restrictions, not a sandbox around the CLI itself.
- `isolation: "brokered"`: Windows-only inference/credential separation with MXC execution. Requires an explicit restricted permission. No fallback to unrestricted execution.
- macOS/Linux do not expose brokered execution or restricted Claude execution. Standalone isolated code tools are available there only when Docker is explicitly configured.
- Models and efforts require local user approval. No automatic model substitution or generation retry.
- Shared concurrency is limited to three runs using the same `dataDir` on one machine. It is not a billing cap or a security boundary against a malicious full-access child.

See [SECURITY.md](SECURITY.md) for the complete trust model and limitations.

## Install by asking your agent

Give a coding agent with local terminal access this repository's URL and ask:

> Install this MCP from this repository. Follow the README, clone it into a persistent user-writable directory, install dependencies, verify the MCP connection, and register it with my installed Codex / Claude Code / OpenCode hosts. Preserve my existing settings and model approvals.
>
> https://github.com/mofu1224/MultiAgentMCP

You can specify a directory or a single host, such as “Codex only.” **The clone itself is the installation; no separate release archive is needed.** Login and model/effort approval remain user decisions, not automatic blanket approval.

### Instructions for the installing agent

1. Check the OS, Git, Node.js **24+**, npm, and requested host CLIs. Follow the user's scope and permissions; do not elevate privileges or install missing tools without authorization.
2. Clone the repository URL supplied in the request into a persistent writable directory. Do not overwrite unrelated folders, local edits, credentials, or existing settings.
3. In the clone, run these commands in order. Do not register the MCP if verification fails:

   ```sh
   npm ci --ignore-scripts
   npm test
   npm run check:release
   npm run verify:install -- .
   ```

4. Preview registration with `node src/register-hosts.mjs --dry-run`, then register with `node src/register-hosts.mjs`. Both accept `--host codex`, `--host claude`, or `--host opencode` to limit the target. Without a target, use the installed supported hosts; missing CLIs are skipped. Change only the `multi-agent` entry.
5. Preserve local settings, approvals, and authentication. Use `node src/select-models.mjs --show` to inspect candidates; use the interactive selector only with the user's model/effort choices. Initially, no models are approved. Never copy credentials or automatically approve every model.
6. Report the clone directory, version, registered hosts, verification results, and any remaining login/approval steps. Reconnect only this MCP where possible; do not force-close unrelated sessions or run a generation test without permission.

## Requirements and manual setup

- Node.js **24 or newer**.
- At least one supported official CLI, installed and authenticated according to its vendor's instructions.
- For Windows restricted execution: an MXC-capable OS and compatible Codex CLI.
- A writable installation directory for local settings and state.

After `git clone`, from the clone directory:

```sh
npm ci --ignore-scripts
npm test
npm run check:release
npm run verify:install -- .
node src/select-models.mjs
node src/register-hosts.mjs
```

The model selector writes `allowlist.json`. **No models are initially approved.** Registration updates the `multi-agent` entry in installed Codex, Claude Code, and OpenCode hosts; missing host CLIs are skipped. Reconnect the host afterward. VS Code registration is opt-in with `--vscode`.

Windows users can use `select-models.cmd` and `register-hosts.cmd`; macOS users can use the corresponding `.command` launchers.

Use `node src/select-models.mjs --show` to inspect approvals without saving. In interactive mode, entering `1,3-4` replaces the selection for the provider's visible models. Press Enter to keep the current selection; Enter also preserves existing effort settings at the next prompt.

Alternatively, configure your MCP host manually with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/MultiAgentMCP/src/server.mjs"]
}
```

Use the actual installation path. Registration must be refreshed if the installation or Node executable moves. `npm start` starts the stdio server, not an interactive application.

## Delegation workflow

1. Call `list_providers`, `get_policy`, and `list_models`.
2. Select a returned, approved model and an `allowedEfforts` value. Effort is required when the model supports it.
3. Call `start_agent` with `provider`, `model`, `effort`, `cwd`, and `task`; specify restricted permissions when appropriate.
4. Wait using `wait_agents` with `job_ids`, then retrieve the final result with `get_agent`.
5. Verify artifacts and tests, then call `close_conversation`.

Native full-access conversations use one persistent CLI process per conversation and send only new input on continuation. Restricted and brokered conversations explicitly replay in-memory history. Conversations do not survive server restarts. Idle processes may be evicted.

| Tools | Purpose |
|---|---|
| `list_providers`, `list_models`, `get_policy` | Capabilities, approved models, effective policy |
| `start_agent`, `get_agent`, `list_agents`, `wait_agents` | Background jobs and final results |
| `send_agent_message`, `cancel_agent`, `close_conversation` | Continue, cancel, and close |
| `run_agent`, `run_agents_parallel` | Synchronous execution |
| `run_brokered_agent` | Windows-only brokered delegation |
| `sandbox_status`, `run_isolated_code` | Platform-dependent isolated JavaScript |
| `get_run`, `usage_summary` | Local execution metadata |

Results omit progress and execution details by default. Use `include_events: true` on `get_agent` for diagnostics, and `include_details: true` for execution metadata. Parallel calls return a result or error per input, preserving other results when one submission fails.

## Configuration and updates

Optional: copy `config.example.json` to `config.json`. Relative `dataDir` and `allowedCwdRoots` paths resolve from the installation directory. An empty `allowedCwdRoots` means unrestricted working directories, but disables host-side `files` attachments.

For OpenAI-compatible APIs, configure `baseUrl` and, if needed, `apiKeyEnv` (an environment variable **name**, never a key value). If `/models` does not report effort choices, configure verified `modelEfforts` or `efforts`, or use `effortParam: null` to explicitly disable effort. Unknown effort support is rejected.

After active jobs finish, stop this MCP connection. Check `git status --short` and preserve any edits. In a clean clone, run `git pull --ff-only`, `npm ci --ignore-scripts`, the tests, release checks, and installation verification above, then reconnect. Re-register if the clone or Node executable moved. Preserve `config.json`, `allowlist.json`, and `data/`; never publish them. Run logs contain metadata, not prompts or responses, but remain private operational data.

Source cloning is the only installation path. There are no separate distribution archives or cross-machine deployment scripts. npm registry publication is intentionally disabled by `private: true`.

## Verification and license

```sh
npm test                  # Offline tests, including mock MCP/CLI integration
npm run check:release     # Syntax, lock, Git source boundaries, licenses, local links
npm run test:smoke        # Optional: real CLI model discovery, no generation
```

Real-model tests are separate, consume service usage, and are not run in CI. Passing automated tests does not guarantee live-model availability or compatibility with future CLI versions. Platform restrictions are documented in the Japanese README.

Licensed under [Apache-2.0](LICENSE). Codex-derived lifecycle code retains its source attribution and upstream notices in [third_party/codex](third_party/codex/README.md) and [NOTICE](NOTICE). External CLIs and dependencies retain their respective licenses.
