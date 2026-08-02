# slack-agent-comms

> **Read [`docs/SLACK_COMMS.md`](../../docs/SLACK_COMMS.md) first** for the bigger picture: use `agent-tui` for live Claude Code, Codex, and Pi sessions; use `@skills/general/slack-notify.md` and `@skills/general/slack-ask.md` for agent-initiated alerts and bounded workstream questions. This README is the operational reference for the Mac Mini daemon.

Slack ↔ agent comms layer for Slack-originated headless Claude Code, Codex, and
Pi sessions, plus the legacy Claude live-session attach surface.

The primary workflow starts with a strict top-level selector such as
`@app codex`. After the daemon preflights and registers the binding it replies
`` `codex` is ready, reply to begin. `` The first ordinary thread reply starts the
session; later replies resume it. Use `agent-tui` for live terminal session
handoff—it is harness-independent and does not require Claude Code's Monitor
feature.

## Scope

This daemon is a **single Mac Mini host with three headless harness adapters.**
That scope is intentional:

- **Mac Mini only.** The service listens locally on `127.0.0.1:42100`. Socket
  Mode load-balances events across connected clients, so only this daemon runs
  the Slack app connection.
- **Claude Code, Codex, and Pi.** Slack-originated sessions use the selected
  CLI's non-interactive JSON mode and resume its stored session ID on later
  thread replies.
- **Headless only.** Use `agent-tui` for interactive terminals on either
  machine. A daemon-owned session has no TUI to reattach to.

The live `/slack-attach-session` path below is retained for compatibility. It
depends on Claude Code's Monitor tool and is no longer the recommended terminal
handoff path.

## Privacy & security — read this first

**`#agents` MUST stay a private Slack channel.** This daemon runs every
headless harness with non-interactive tool approval, which means any text posted
by an allow-listed user in a registered thread can execute arbitrary local
tools—filesystem, shell, network, anything. The
`SLACK_AGENT_COMMS_ALLOWED_USERS` allowlist is defense-in-depth; channel privacy
is the load-bearing control.

If you ever consider opening this channel up, the answer is no. Add a separate channel and a separate Slack app for that purpose.

## Session bindings

Each Slack thread is bound to exactly one agent session. There are two
ownership modes:

- **Daemon-owned headless session:** a strict top-level selector registers it;
  the first reply starts the selected harness, and the daemon resumes it for
  later replies and posts the final output.
- **Legacy live attachment:** `/slack-attach-session` binds an already-running
  Claude terminal; Monitor delivers inbound messages to that terminal.

Thread lifetime = session lifetime. Either end can terminate it; the registry tracks the binding.

## Legacy live attach model (v2)

The v2 model replaces the v1 Slack-reply → `claude --resume` path. The core rule:

> **For a locally attached live CC session, the daemon NEVER spawns `claude --resume`.**

### The attach ritual

1. CC (or the user) runs `/slack-attach-session` in an active terminal CC session.
2. The slash command calls daemon `POST /attach-live` with `cwd` and optional `hint`.
3. Daemon creates or reuses an attachment row and posts a Slack opener.
4. The slash-command output ends with an unmissable instruction: start `agent-comms monitor --attachment <id>` immediately via the Claude Code Monitor tool.
5. CC starts the monitor via Monitor. The monitor long-polls the daemon for inbound messages and sends liveness check-ins every 15s.
6. Daemon marks the attachment active after the monitor's first check-in.
7. CC continues working in the same live terminal session.

### What happens when the user replies in Slack

1. Daemon receives the reply via Socket Mode.
2. **Routing precedence ladder** (in order):
   1. **Active or stale attachment** for `(channel, thread_ts)` → message is persisted to durable inbox, Slack receives an inbox reaction (📥). Heartbeat state begins. Does not consult `ask`/`handoffs`.
   2. **Legacy `handoffs` row** (no attachment) → Slack receives a clear re-attach prompt ("this thread is from the old system, please re-attach via `/slack-attach-session`"). Never resumes.
   3. **No known thread** → non-attached pending-ask resolution (legacy AFK `ask` flows only).
3. The active monitor long-poll delivers a **notification line** to CC: `[agent-comms] msg=<id> attach=<id> from=<slack_user_id> slack_ts=<ts> chars=<n>` — metadata only, no body. (See "Inbound delivery: two-step protocol" below for why.)
4. CC reads the body via `agent-comms get-message --message-id <id>` and then responds via `agent-comms reply` or marks it handled with `agent-comms handled`.

### Readiness and spawn behavior for top-level mentions

A root message must be exactly `@app <identifier>`, where the canonical
identifier is `claude`, `codex`, or `pi` (case-insensitive). Extra prompt text,
missing text, and aliases are invalid. Invalid commands receive a thread reply
listing all valid identifiers and do not create an attachment.

For a valid selector the daemon, in order:

1. runs `task -d ~/Documents/core-repo repos:pull` and waits for the complete
   registered repo family to refresh (dirty or unpushed repos retain the pull
   command's normal safe-skip behavior);
2. runs `<identifier> --version` in `AGENT_COMMS_DEFAULT_CWD`;
3. creates or reuses a durable attachment with
   `owner_mode='daemon-spawned'` and `delivery_adapter='daemon-worker'`;
4. posts `` `<identifier>` is ready, reply to begin. `` in the new thread.

If the repo refresh command fails, the daemon posts a visible failure in the
thread and does not register or launch the session. Concurrent selectors share
one in-flight refresh so git operations cannot race across the same checkouts.

No model turn runs during registration. The visible readiness reply is the
acknowledgement that preflight, registration, and the Slack write completed. If
it is absent, treat the setup as broken. CLI authentication and a real provider
request are intentionally deferred until the first reply; failures then appear
visibly in the thread.

The first ordinary reply is the first prompt. The adapter captures the new
session ID, and subsequent replies route through `DaemonWorker.kick`, which
resumes that ID once per inbound message. Turns are serialized per attachment.
No `agent-comms monitor` process is involved—the daemon owns the spawn loop
end-to-end.

The v1 two-process race condition is structurally avoided: the daemon is the
sole owner of the session ID (no terminal harness is attached to these
threads), and per-attachment serialization keeps two resume invocations from
running concurrently against the same session.

## Surfaces

### User → `@app <harness>` in `#agents`

Select `claude`, `codex`, or `pi` in a root mention. Wait for the readiness
reply, then put the first prompt in that thread. The working directory defaults
to `~/Documents/core-repo` and can be changed with
`AGENT_COMMS_DEFAULT_CWD`. See "Readiness and spawn behavior for top-level
mentions" above for the exact contract.

### User → `/slack-attach-session` slash command

Run inside a live CC session: calls `POST /attach-live`, posts a Slack opener, and returns an instruction for CC to start `agent-comms monitor --attachment <id>` via the Monitor tool immediately. This is the entry point for the durable attach ritual.

### CC → `agent-comms monitor --attachment <id>`

Start immediately after attaching. Long-polls the daemon for inbound Slack messages and sends liveness check-ins every 15s. Emits one **notification** line per delivered message (metadata only — no body):

```
[agent-comms] msg=<message_id> attach=<attachment_id> from=<slack_user_id> slack_ts=<ts> chars=<n>
```

Exit codes: 0 clean, 1 daemon error, 3 daemon not running, 4 attachment not found, 7 monitor slot already owned by another process.

At most one monitor may hold leases for an attachment at a time. Monitor owner identity is deterministic per attachment so a restarted monitor reconnects immediately inside the prior owner's 60s stale window when the previous PID is gone. A second live monitor for the same attachment gets `409 Conflict`, even if it uses the default stable token. If the first is past the 60s stale threshold, the new monitor takes over automatically.

### Inbound delivery: two-step protocol

Claude Code's `Monitor` tool applies a small per-event stdout cap and silently appends `...(truncated)` when a single emitted line overflows. The cap is small enough that real Slack messages routinely don't fit, and CC has no way to recover the lost tail. So we never inline the body in the monitor stream. Inbound delivery is always two steps:

1. **Notify (Monitor stream).** `agent-comms monitor` emits the metadata line shown above — id, attachment, sender, slack_ts, char count. Always under the Monitor cap.
2. **Fetch (Bash).** CC runs `agent-comms get-message --message-id <id>` to read the full text from the daemon. Bash output has a much larger cap, so the body comes through verbatim.

This split is enforced in the CLI: the monitor never writes message text to stdout, even for short messages. The `/slack-attach-session` slash command spells the protocol out for CC.

### CC → `agent-comms get-message --message-id <id>`

Fetch the full body of a previously-notified inbound message from the daemon. Returns the text verbatim (or the full row with `--json`).

```bash
agent-comms get-message --message-id msg456
```

Exit codes: 0 success, 1 daemon error, 3 daemon not running, 4 message not found.

### CC → `agent-comms reply --attachment <id> --message-id <id> --text "..."`

Post a Slack reply closing the pending-response loop for a specific inbound message. Idempotent: duplicate calls (e.g. after a network timeout) post to Slack exactly once and return the prior result.

```bash
agent-comms reply --attachment abc123 --message-id msg456 --text "Done — 42/42 tests passing."
```

### CC → `agent-comms status --attachment <id> --text "..."`

Fire-and-forget Slack thread post without closing a pending response. Use for progress updates.

```bash
agent-comms status --attachment abc123 --text "Phase 2 complete. Starting phase 3."
```

### CC → `agent-comms handled --attachment <id> --message-id <id>`

Explicitly close a pending response without posting a Slack reply. Use when the message needed no response.

```bash
agent-comms handled --attachment abc123 --message-id msg456
```

### CC → `agent-comms post --text "..."`

Fire-and-forget. Posts `text` to the attached thread. Does not close any pending response.

```bash
agent-comms post --text "Status: 42/42 items done"
```

### CC → `agent-comms ask --text "..."`

Blocking. Posts `text` to the non-attached thread; holds the HTTP connection until the user replies. **Cannot intercept replies for active attachments** — if a Slack thread has an active attachment, `ask` returns an error telling CC to use `agent-comms status`/`reply` and wait for the next monitor-delivered message. Non-attached AFK `ask` flows are unaffected.

```bash
agent-comms ask --text "Should I rename the schema column or add a new one?"
# → (the user replies in Slack) → stdout: "add a new one, keep the old for one migration cycle"
```

Flags: `--timeout <duration>` (`30s`, `5m`, `1h`, `24h`, `0` = indefinite), `--session-id <id>`, `--json`.

## Heartbeat semantics

The daemon posts Slack heartbeat messages only while a response is actually pending.

| State | Slack message |
|-------|---------------|
| Message persisted, monitor not yet connected | (no post — heartbeat stays quiet until monitor is healthy, message is emitted, or attachment goes stale) |
| Monitor healthy OR message emitted to live session | `_thinking..._` |
| Heartbeat repeat (after 5 min in the thinking phase) | `_still working... Xm since your message, last agent activity Ym ago_` |
| Monitor stale (no check-in for 60s) | `_queued, but the attached Claude Code monitor has not checked in for Xs_` (one-shot; no further repeats until recovery) |
| Stale → recovered (monitor back to active while heartbeat suspended) | `_thinking..._` (fresh post, repeats resume) |
| Attachment ended | `_the attached session has ended — no response will be sent_` |
| Attachment errored | `_the attached session encountered an error — no response will be sent_` |
| Message marked failed | `⚠️ _message delivery failed — check daemon logs_` |
| 60-minute hard cap | `_pending response timeout — attachment looks healthy but Claude has not acknowledged — check the session_` (no further heartbeats) |

Heartbeat stops when CC calls `reply` or `handled` for the inbound message. Stale notice converts the repeating heartbeat to a one-shot; heartbeat resumes when the monitor reconnects.

Stale attachments (monitor gone for 60s) still receive Slack messages — they are persisted and Slack shows the stale notice. When the monitor reconnects, un-emitted messages flush on the first long-poll.

## Stale recovery

If the monitor process crashes or loses its connection:

1. After 60s with no long-poll or check-in, the daemon marks the attachment `stale`.
2. Inbound Slack messages are still persisted. Slack sees the stale notice instead of `_thinking..._`.
3. Restart the monitor: `agent-comms monitor --attachment <id>`. It will:
   - Take over the stale monitor slot automatically (old owner is past its TTL).
   - Replay any in-flight `leased` messages back to `persisted` so they flush on the first long-poll.
   - Post a fresh delivery-status to Slack once the first message is re-emitted.
4. If a 409 conflict is returned, the previous monitor is still healthy — don't start a second one.

To find the active attachment id: inspect the registry (see Debugging below) or rerun `/slack-attach-session` (it returns the existing attachment if one is active for the current cwd/channel).

## Why live attachments never use `claude --resume`

The v1 model caused a critical failure on the Mac Mini: after `/slack-attach-session`, a Slack reply spawned a second `claude -p --resume <session_id>` while the original terminal CC session was still running. Both CC processes raced on the same session transcript and workspace. The failure was architectural — the daemon had no way to know a live terminal CC session was active.

The ownership boundary now makes the safe behavior explicit:

- A legacy live attachment delivers through Monitor and never spawns
  `claude --resume`, because the terminal already owns that session.
- A daemon-owned headless attachment has no terminal process. Its serialized
  worker may safely run one selected-harness turn per Slack reply.

Do not add a fallback that resumes a Monitor-owned or otherwise live terminal
session from the daemon.

## Required env vars

| Var | Source | Purpose |
|-----|--------|---------|
| `SLACK_BOT_TOKEN_AGENT_COMMS` | vault → `.env` | Bot token (`xoxb-…`) for posting + reactions |
| `SLACK_APP_TOKEN_AGENT_COMMS` | vault → `.env` | App-level token (`xapp-…`) for Socket Mode |
| `SLACK_AGENT_COMMS_CHANNEL` | vault → `.env` | Channel ID of `#agents` |
| `SLACK_AGENT_COMMS_ALLOWED_USERS` | vault → `.env` | Comma-separated Slack `user_id`s |
| `MACHINE_ID` | `.env` or `~/.AGENT_MACHINE_IDENTITY` | Identifies the daemon host in logs and failures; normally `mac-mini` |
| `AGENT_COMMS_PORT` | `.env` (optional) | Defaults to `42100` |
| `AGENT_COMMS_DEFAULT_CWD` | `.env` (optional) | cwd for fresh sessions from @-mentions. Default: `~/Documents/core-repo` |

Secret paths on disk:

- Shared secret: `~/.claude/agent-comms/secret`
- Registry: `~/.claude/agent-comms/registry.db`
- Logs: `~/.claude/agent-comms/logs/`

## Slack app scopes

- **Bot Token Scopes:** `chat:write`, `channels:history`, `groups:history`, `reactions:write`, `app_mentions:read`
- **Subscribed bot events:** `message.channels` (or `message.groups` for private channels), `app_mention`
- **Socket Mode:** enabled, with an app-level token (`xapp-…`) with `connections:write`

## Daemon lifecycle

Run these from `~/Documents/sean-machine-setup` on the Mac Mini:

| Command | Purpose |
|---------|---------|
| `task agent-comms:install` | First install or full reinstall: build, stage, write launchd plist, install slash command, load daemon. |
| `task agent-comms:restart` | Rebuild and restart after code changes. Alias for install. |
| `task agent-comms:stage` | Atomically stage a new daemon build without touching the running process. |
| `task agent-comms:restart-after-reply` | For a daemon-owned Slack turn: validate and stage, then restart once all active final replies are posted. |
| `task agent-comms:start` | Start an already-installed daemon, bootstrapping or kickstarting launchd as needed. |
| `task agent-comms:stop` | Stop the launchd agent. |
| `task agent-comms:status` | Print daemon health JSON. |
| `task agent-comms:logs` | Tail daemon stdout and stderr logs. |

There is no Task target for uninstall yet; use the uninstall script below.

### Restarting from a daemon-owned Slack turn

A headless agent is a child of the daemon. Running `agent-comms:restart` from
that child kills the turn that requested it, so it cannot post its final Slack
reply. Do not solve this with `launchctl submit`, background sleeps, or detached
shell helpers.

After changing `tools/agent-comms`, the agent's final tool command must be:

```bash
task -d ~/Documents/sean-machine-setup agent-comms:restart-after-reply
```

This is a two-phase deployment:

1. Run the package checks and atomically stage the new bundle while the old
   daemon continues serving Slack.
2. Send an authenticated restart request to the running daemon. It holds one
   in-memory, idempotent request until every daemon-owned turn has finished its
   awaited Slack post. It rechecks that no new turn raced in, exits cleanly,
   and lets the existing launchd `KeepAlive` job start the staged bundle once.

No new process, launchd label, timer job, or retry loop is created. Changes to
the LaunchAgent definition itself still require the ordinary operator-run
`task agent-comms:restart`, because a self-exit reloads code but not a modified
launchd plist.

## Install sequence

### 1. Populate env

```bash
cd ~/Documents/core-repo
task secrets:load                     # makes the canonical Slack credentials available
```

### 2. Install daemon

```bash
cd ~/Documents/sean-machine-setup
task agent-comms:install
```

This builds the dist, writes the launchd plist (`com.priori.agent-comms`), installs the `/slack-attach-session` slash command, symlinks `agent-comms` to `~/.local/bin/`, and loads the agent.

### macOS Full Disk Access (REQUIRED, one-time per machine)

The launchd-spawned daemon has no inherited TCC grants. Any harness spawn that
needs `getcwd()` on `~/Documents` can hang in `__open_nocancel` without FDA.

1. **System Settings → Privacy & Security → Full Disk Access**
2. Click `+` and add (use Shift-Cmd-G to paste paths):
   - `/Users/<you>/.bun/bin/bun` — what launchd actually exec's (load-bearing)
   - the paths printed by `command -v claude`, `command -v codex`, and
     `command -v pi` (belt-and-suspenders)
3. Toggle both ON
4. Restart: `task agent-comms:restart`

Symptom if skipped: a harness runs forever, produces no JSON output, and the
daemon log shows the spawn line but never the exit line. `sample <pid>` shows
`getcwd → __open_nocancel` in the stack.

### 3. Verify

```bash
launchctl list | grep com.priori.agent-comms
curl -sS http://127.0.0.1:42100/health
```

## Manual dev run

```bash
bun run --cwd tools/agent-comms src/index.ts
```

## Uninstall

```bash
bun run --cwd tools/agent-comms scripts/uninstall.ts
```

Registry, dist, .env, and logs are preserved — registered threads remain reusable after reinstall.

## Debugging

| Symptom | First thing to check |
|---------|---------------------|
| `agent-comms post/ask/monitor` returns "connection refused" | Daemon not running. Run `task agent-comms:status`; if absent, run `task agent-comms:start` or `task agent-comms:install`. Also check `AGENT_COMMS_PORT` matches on both sides. |
| `/health` returns `slack_connected: false` | Bolt not connected. Check `~/.claude/agent-comms/logs/stderr.log` for token/scope errors. Verify `xoxb-…` and `xapp-…` in `.env` and that the Slack app is installed to the workspace. |
| Slack reply does nothing | Check stdout log. Channel ID mismatch, non-allowlisted user, or unregistered thread. |
| No readiness reply after `@app <harness>` | Check the thread for an invalid-selector or preflight failure, then inspect daemon logs. The daemon did not acknowledge a usable binding. |
| First prompt reports a harness failure | The executable passed preflight, but its real model turn failed. Verify that harness's authentication and provider configuration under the launchd user. |
| Monitor exits with code 7 | Another live monitor is already running for this attachment. `pgrep -f 'agent-comms monitor'`. Normal restarts without `--owner-token` reconnect immediately after the previous PID is gone. |
| Monitor exits with code 4 | Attachment not found. Rerun `/slack-attach-session` to get a fresh attachment id. |
| Slack shows stale notice | Monitor has not checked in for 60s. Restart it: `agent-comms monitor --attachment <id>`. |
| Replies silently ignored | Non-allowlisted user (`SLACK_AGENT_COMMS_ALLOWED_USERS`) or unregistered thread. Inspect registry below. |
| `agent-comms ask` returns 409 | Session has an active attachment — `ask` cannot intercept attached threads. Use `agent-comms status`/`reply` instead and wait for the next monitor-delivered message. |

### Inspect the registry

```bash
bun -e "
import { Database } from 'bun:sqlite';
const db = new Database(process.env.HOME + '/.claude/agent-comms/registry.db', { readonly: true });
console.log('--- attachments ---');
for (const r of db.query('SELECT id, status, cwd, channel_id, thread_ts, monitor_owner, updated_at FROM attachments ORDER BY updated_at DESC').all()) console.log(r);
console.log('--- messages (recent) ---');
for (const r of db.query('SELECT id, attachment_id, direction, status, text, created_at FROM messages ORDER BY created_at DESC LIMIT 20').all()) console.log(r);
"
```

### Tail the daemon logs

```bash
tail -f ~/.claude/agent-comms/logs/stdout.log
tail -f ~/.claude/agent-comms/logs/stderr.log
```

### Restart without rebuilding

```bash
task agent-comms:start
```

### Restart with a fresh dist

```bash
task agent-comms:restart
```

## Files

**Daemon:**
- `src/index.ts` — daemon entrypoint; calls `reconcileOnStartup` before HTTP serves
- `src/registry.ts` — durable SQLite registry: `attachments`, `messages`, `handoffs` tables; all delivery/lease/monitor helpers
- `src/config.ts` — env var loading
- `src/secret.ts` — shared secret for CLI → daemon auth

**HTTP routes:**
- `src/http/server.ts` — Hono app wiring
- `src/http/routes/attach-live.ts` — `POST /attach-live` — durable attach register/reuse
- `src/http/routes/monitor.ts` — `GET /monitor/wait`, `POST /monitor/checkin`, `POST /monitor/emitted`
- `src/http/routes/messages.ts` — `GET /messages/:id` — body-fetch companion to `/monitor` (bypasses CC's per-event Monitor stdout cap)
- `src/http/routes/reply.ts` — `POST /reply` — egress reply
- `src/http/routes/status.ts` — `POST /status` — fire-and-forget Slack post
- `src/http/routes/handled.ts` — `POST /handled` — close pending response
- `src/http/routes/restart-after-reply.ts` — authenticated, idempotent deferred self-restart request
- `src/http/routes/post.ts` — `POST /post` (legacy fire-and-forget)
- `src/http/routes/ask.ts` — `POST /ask` (legacy blocking ask; rejects for active attachments)
- `src/http/routes/attach.ts` — `POST /attach` (v1 alias; preserved for backcompat)
- `src/http/thread-service.ts` — shared Slack thread helpers
- `src/http/auth.ts` — shared secret middleware

**Slack:**
- `src/slack/app.ts` — Bolt + Socket Mode; `routeThreadReply` precedence ladder
- `src/slack/heartbeat.ts` — `HeartbeatManager`; pending-response heartbeat with all termination paths
- `src/slack/handler.ts` — strict top-level selector, CLI preflight, durable registration, readiness acknowledgement
- `src/slack/formatter.ts` — Markdown → Slack mrkdwn + 40k-char truncation
- `src/slack/system-prompt.ts` — phone-friendly system prompt for Slack-driven turns
- `src/slack/headless-turn.ts` — one Slack-facing harness turn: progress, output formatting, and visible failures
- `src/slack/types.ts` — shared Slack adapter types

**CLI:**
- `src/cli/index.ts` — `agent-comms` entrypoint
- `src/cli/monitor.ts` — `monitor` subcommand (emits notification-only lines)
- `src/cli/get-message.ts` — `get-message` subcommand (fetches the body)
- `src/cli/reply.ts` — `reply` subcommand
- `src/cli/status.ts` — `status` subcommand
- `src/cli/handled.ts` — `handled` subcommand
- `src/cli/post.ts` — `post` subcommand
- `src/cli/ask.ts` — `ask` subcommand
- `src/cli/restart-after-reply.ts` — queue a restart after active final replies
- `src/cli/client.ts` — HTTP client shared by all subcommands
- `src/cli/args.ts` — CLI arg parsing
- `src/cli/duration.ts` — duration string parser

**Session / spawn:**
- `src/session/discover.ts` — find newest `*.jsonl` for a given cwd
- `src/headless/process.ts` — shell-free child-process runner
- `src/headless/harness.ts` — harness identifiers, preflight, command builders, and JSON output adapters
- `src/slack/daemon-worker.ts` — serialized turn worker for daemon-owned attachments
- `src/restart-after-reply.ts` — race-safe idle gate for one deferred self-restart
- `src/asks.ts` — in-memory pending-ask resolver (non-attached flows only)

**Install:**
- `src/daemon/launchd.plist.tmpl` — launchd LaunchAgent template
- `scripts/install.ts` / `scripts/uninstall.ts` — launchd install/uninstall
- `templates/claude-commands/slack-attach-session.md` — `/slack-attach-session` slash-command source
