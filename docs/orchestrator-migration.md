# Orchestrator migration: post-decoupling

Sapling no longer reaches out to a specific orchestrator. Two behaviors that previously lived inside sapling are now the orchestrator's responsibility:

1. **Sapling no longer polls a mailbox between turns.** Earlier versions ran `ov mail check --agent <name>` after every turn. That call has been removed.
2. **Sapling no longer pushes a `task_done` notification on exit.** Earlier versions ran `ov mail send` from `handleEcosystemExit`. That call has been removed; only the metrics-file `_exit` block is written.

A consumer that depended on either behavior must migrate to the documented general-purpose surface. Nothing else changes — `--agent-name`, `--task-id`, `--metrics-path`, `--guards-file`, `--json`, `--mode rpc`, and `--rpc-socket` all behave identically.

## What the orchestrator now does

| Old (sapling pulled / pushed) | New (orchestrator drives) |
|---|---|
| `ov mail check` after every turn — sapling polled for steer/followUp/interrupt requests | Push **JSON-RPC `steer` / `followUp` / `abort`** on stdin via `--mode rpc`; sapling injects them at the next turn boundary |
| `ov mail send task_done: <id>` on exit — sapling notified the orchestrator | Watch the metrics file `_exit` block, the final NDJSON `result` event on stdout, or the process exit code |
| `OVERSTORY_AGENT_NAME` / `OVERSTORY_TASK_ID` / `OVERSTORY_METRICS_PATH` env fallbacks | Use `SAPLING_AGENT_NAME` / `SAPLING_TASK_ID` / `SAPLING_METRICS_PATH` (or pass `--agent-name` / `--task-id` / `--metrics-path` directly) |

## Minimal orchestrator stub

This is what it takes to wire up the surface end-to-end. About 30 lines.

```ts
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "agent-"));
const metricsPath = join(work, "metrics.json");
const socketPath = join(work, "rpc.sock");
const guardsPath = join(work, "guards.json"); // pre-write your guard rules

const sp = spawn(
  "sp",
  [
    "run", "Implement feature X",
    "--json",
    "--mode", "rpc",
    "--rpc-socket", socketPath,
    "--guards-file", guardsPath,
    "--metrics-path", metricsPath,
    "--agent-name", "builder-1",
    "--task-id", "task-42",
  ],
  { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
);

// 1. Consume NDJSON events from stdout (turn boundaries, tool calls, final result)
sp.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n").filter(Boolean)) {
    const ev = JSON.parse(line);
    if (ev.type === "turn_end") {
      // Optional: push a steer at this boundary
      sp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "steer", params: { content: "Reminder: keep diffs small" } }) + "\n");
    }
    if (ev.type === "result") console.log("agent done:", ev.exitReason);
  }
});

// 2. Read final metrics on exit
sp.on("exit", (code) => {
  const metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
  console.log("exit code:", code, "exit block:", metrics._exit);
});

// 3. (Optional) Send an abort if you need to stop the agent early
// sp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "abort" }) + "\n");

// 4. (Optional) Query live state without disturbing stdin via the unix socket
// const client = net.createConnection(socketPath, () => client.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "getState" }) + "\n"));
```

## Acceptance check for migrators

After porting, the orchestrator should be able to reproduce its prior end-to-end flow with no sapling-side changes:

- [ ] All inbound steers/follow-ups go via `--mode rpc` stdin instead of mail polling.
- [ ] Task completion is detected from the NDJSON `result` event, the metrics `_exit` block, or the process exit code — whichever fits the orchestrator's architecture best.
- [ ] All env vars reference `SAPLING_*` only. `OVERSTORY_*` env fallbacks are gone.
- [ ] No source code in the orchestrator names sapling internals; everything goes through CLI flags + the documented surface.

## See also

- `docs/event-schema.md` — NDJSON event reference (every type, payload shape, fire conditions, CLI gating).
- `src/orchestrator-surface.test.ts` — E2E tests asserting the contract above.
- `src/hooks/events.ts` — NDJSON event emitter source of truth.
- `src/rpc/types.ts` — JSON-RPC request/response shapes.
- `sapling/CLAUDE.md` § "Orchestrator integration surface" — surface index.
