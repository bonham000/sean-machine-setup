---
description: attaches this Claude Code session to a persistent Slack thread for back and forth comms
allowed-tools: Bash(curl:*), Bash(cat:*), Bash(jq:*), Bash(agent-comms:*)
---

Attaches this Claude Code session to a durable Slack thread using the v2 durable attach model. The block below calls the local agent-comms daemon (`POST /attach-live`), which posts a Slack opener, registers the thread, and returns an attachment id.

!`SECRET_FILE="$HOME/.claude/agent-comms/secret"; if [ ! -f "$SECRET_FILE" ]; then echo '{"ok":false,"error":"Secret file missing at ~/.claude/agent-comms/secret. Start the daemon from sean-machine-setup: task agent-comms:start. For first install or full reinstall: task agent-comms:install."}'; else SECRET=$(cat "$SECRET_FILE"); BODY=$(jq -nc --arg cwd "$PWD" --arg hint "$ARGUMENTS" --argjson cc_pid "$PPID" '{cwd: $cwd, hint: $hint, cc_pid: $cc_pid}'); curl -sS --max-time 10 -X POST http://127.0.0.1:${AGENT_COMMS_PORT:-42100}/attach-live -H "X-Agent-Comms-Secret: $SECRET" -H "Content-Type: application/json" -d "$BODY" || echo '{"ok":false,"error":"Could not reach agent-comms daemon at 127.0.0.1:42100. Start it from sean-machine-setup with: task agent-comms:start. For first install or full reinstall: task agent-comms:install."}'; fi`

Parse the JSON response above and follow exactly one of these paths:

- **If `"ok": false`** — surface the `error` field verbatim and stop. Do not take any further action.
- **If `"ok": true` and `"created": false`** — tell me this session is already attached and show the `thread_url`. Then follow the REQUIRED NEXT STEP below.
- **If `"ok": true` and `"created": true`** — tell me the thread is open and show the `thread_url`. Then follow the REQUIRED NEXT STEP below.

---

> **REQUIRED NEXT STEP — run this before any other action:**
>
> Extract `attachment_id` from the JSON above. Start the durable message monitor now via the Monitor tool:
>
> ```text
> Monitor(command="agent-comms monitor --attachment <attachment_id from JSON>", description="Slack inbound for <attachment_id>", persistent=true)
> ```
>
> This is the delivery channel for all Slack → CC messages for this session. Inbound Slack messages will not reach you until the monitor is running. Monitor is the canonical delivery mechanism per the Phase 0 live-session spike.
>
> **Inbound protocol — every Slack message is delivered in TWO steps:**
>
> 1. The Monitor tool surfaces a notification line:
>
>    ```text
>    [agent-comms] msg=<message_id> attach=<attachment_id> from=<slack_user_id> slack_ts=<ts> chars=<n>
>    ```
>
>    This line is metadata only — **the body is NOT in this line**. The Monitor tool's per-event stdout cap silently clips long lines with `...(truncated)`, so the body is never inlined. Treat `chars` as a hint about the expected body length.
>
> 2. To read the actual body, run via Bash:
>
>    ```bash
>    agent-comms get-message --message-id <message_id>
>    ```
>
>    Bash output has a much larger cap than Monitor's per-event cap, so the full body comes through verbatim. Always fetch with this command — never assume the Monitor line contains any portion of the message text.
>
> Respond to a Slack message with `agent-comms reply --attachment <id> --message-id <id> --text "..."`, or close it silently with `agent-comms handled --attachment <id> --message-id <id>`. Both via Bash.
