/**
 * Monitor routes — long-poll delivery + liveness protocol.
 *
 * GET  /monitor/wait?attachment=<id>&owner_token=<tok>&pid=<pid>&started_at=<ts>
 *   Long-poll (25s server-side timeout). Claims or takes over monitor ownership,
 *   then leases and returns the next persisted messages. Returns empty array on
 *   timeout. Returns 409 if a healthy owner already holds the slot.
 *
 * POST /monitor/checkin?attachment=<id>
 *   Explicit 15s liveness signal. Body: { owner_token, pid, started_at, emitted_ids? }
 *   Refreshes the monitor owner TTL and records agent activity.
 *
 * POST /monitor/emitted
 *   Transition message(s) from leased → emitted.
 *   Body: { owner_token, message_ids: string[] }
 */

import { Hono } from 'hono';
import { type DurableRegistry, STALE_THRESHOLD_MS } from '../../registry';

const LONG_POLL_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 500;

export interface MonitorDeps {
  registry: DurableRegistry;
  /** Override long-poll timeout (ms). Defaults to 25_000. Used by tests. */
  longPollTimeoutMs?: number;
  /** Override PID liveness checks for ownership tests. */
  isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function monitorRoutes(deps: MonitorDeps): Hono {
  const route = new Hono();

  // GET /monitor/wait — long-poll for leased messages
  route.get('/wait', async (c) => {
    const attachmentId = c.req.query('attachment');
    const ownerToken = c.req.query('owner_token');
    const pidStr = c.req.query('pid');
    const startedAtStr = c.req.query('started_at');

    if (!attachmentId || !ownerToken || !pidStr || !startedAtStr) {
      return c.json(
        {
          ok: false,
          error:
            'Required query params: attachment, owner_token, pid, started_at',
        },
        400,
      );
    }

    const pid = Number(pidStr);
    const startedAt = Number(startedAtStr);
    if (!Number.isFinite(pid) || !Number.isFinite(startedAt)) {
      return c.json(
        { ok: false, error: 'pid and started_at must be numbers' },
        400,
      );
    }

    const now = Date.now();

    // Attempt to claim ownership (strict: only when monitor_owner IS NULL).
    // If expired owner present, route through takeOverStaleMonitor so in-flight
    // leased messages get reclaimed back to persisted.
    const claim = deps.registry.claimMonitorOwnership({
      attachmentId,
      ownerToken,
      pid,
      startedAt,
      ttlMs: STALE_THRESHOLD_MS,
      now,
    });

    if (!claim.ok) {
      if (claim.reason === 'not_found') {
        return c.json({ ok: false, error: 'attachment not found' }, 404);
      }
      if (claim.reason === 'already_owned') {
        // Same logical owner. Allow ordinary same-process long-poll reconnects.
        // Also allow same-token process restarts only when the previous PID is
        // gone; otherwise two live monitors with the deterministic token would
        // both deliver Slack messages into sessions.
        if (claim.existingToken === ownerToken) {
          const sameProcess =
            claim.existingPid === pid && claim.existingStartedAt === startedAt;
          const existingAlive =
            claim.existingPid !== null &&
            (deps.isPidAlive ?? defaultIsPidAlive)(claim.existingPid);

          if (!sameProcess && existingAlive) {
            console.log(
              `[agent-comms] 409 duplicate-monitor: attachment=${attachmentId} existing_pid=${claim.existingPid} new_pid=${pid} shared_token=${ownerToken}`,
            );
            return c.json(
              {
                ok: false,
                error: 'monitor already owned',
                existing: {
                  token: claim.existingToken,
                  pid: claim.existingPid,
                  startedAt: claim.existingStartedAt,
                },
              },
              409,
            );
          }

          const replacement = deps.registry.replaceMonitorOwner({
            attachmentId,
            ownerToken,
            pid,
            startedAt,
            ttlMs: STALE_THRESHOLD_MS,
            now,
            reclaimLeases: !sameProcess,
          });
          if (!replacement.ok) {
            return c.json(
              { ok: false, error: 'monitor ownership race, retry' },
              409,
            );
          }
          if (!sameProcess) {
            console.log(
              `[agent-comms] same-owner monitor restart: attachment=${attachmentId} old_pid=${claim.existingPid} new_pid=${pid} reclaimed=${replacement.reclaimedMessageIds.join(',')}`,
            );
          }
          // fall through to long-poll lease loop
        } else {
          console.log(
            `[agent-comms] 409 duplicate-monitor: attachment=${attachmentId} existing_pid=${claim.existingPid} existing_token=${claim.existingToken}`,
          );
          return c.json(
            {
              ok: false,
              error: 'monitor already owned',
              existing: {
                token: claim.existingToken,
                pid: claim.existingPid,
                startedAt: claim.existingStartedAt,
              },
            },
            409,
          );
        }
      }
      if (claim.reason === 'stale_existing') {
        // Take over: reclaim dead owner's in-flight leased messages → persisted.
        const takeover = deps.registry.takeOverStaleMonitor({
          attachmentId,
          newOwnerToken: ownerToken,
          newPid: pid,
          newStartedAt: startedAt,
          ttlMs: STALE_THRESHOLD_MS,
          now,
        });
        if (!takeover.ok) {
          // Race: became healthy again between claim and takeover
          return c.json(
            { ok: false, error: 'monitor ownership race, retry' },
            409,
          );
        }
        console.log(
          `[agent-comms] monitor takeover: attachment=${attachmentId} reclaimed=${takeover.reclaimedMessageIds.join(',')} new_token=${ownerToken}`,
        );
      }
    }

    // Long-poll: lease messages or wait up to the configured timeout
    const deadline =
      Date.now() + (deps.longPollTimeoutMs ?? LONG_POLL_TIMEOUT_MS);

    while (true) {
      // Expire stale leases first so reclaimed messages become available
      deps.registry.expireStaleLeases(Date.now());

      const messages = deps.registry.leaseNextMessages({
        attachmentId,
        ownerToken,
        limit: 1,
        now: Date.now(),
      });

      if (messages.length > 0) {
        return c.json({ ok: true, messages });
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      // Check client disconnect before sleeping
      if (c.req.raw.signal?.aborted) {
        // 499 = client closed request (nginx convention); not in Hono's enum
        return c.json(
          { ok: false, error: 'client_disconnected' },
          499 as unknown as 400,
        );
      }

      await new Promise<void>((r) =>
        setTimeout(r, Math.min(POLL_INTERVAL_MS, remaining)),
      );
    }

    // Timeout — return empty
    return c.json({ ok: true, messages: [] });
  });

  // POST /monitor/checkin — explicit liveness ping
  route.post('/checkin', async (c) => {
    const attachmentId = c.req.query('attachment');
    if (!attachmentId) {
      return c.json(
        { ok: false, error: 'attachment query param required' },
        400,
      );
    }

    let body: {
      owner_token?: string;
      pid?: number;
      started_at?: number;
      emitted_ids?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.owner_token) {
      return c.json({ ok: false, error: 'owner_token required' }, 400);
    }

    const now = Date.now();
    const attachment = deps.registry.getAttachment(attachmentId);
    if (!attachment || attachment.monitor_owner !== body.owner_token) {
      return c.json(
        {
          ok: false,
          error: 'checkin rejected: not owner or attachment not found',
        },
        409,
      );
    }

    const hasProcessIdentity =
      typeof body.pid === 'number' && typeof body.started_at === 'number';
    if (hasProcessIdentity) {
      const sameProcess =
        attachment.monitor_owner_pid === body.pid &&
        attachment.monitor_owner_started_at === body.started_at;
      const existingAlive =
        attachment.monitor_owner_pid !== null &&
        (deps.isPidAlive ?? defaultIsPidAlive)(attachment.monitor_owner_pid);
      if (!sameProcess && existingAlive) {
        return c.json(
          {
            ok: false,
            error: 'checkin rejected: another live monitor owns attachment',
          },
          409,
        );
      }
      const replacement = deps.registry.replaceMonitorOwner({
        attachmentId,
        ownerToken: body.owner_token,
        pid: body.pid as number,
        startedAt: body.started_at as number,
        ttlMs: STALE_THRESHOLD_MS,
        now,
        reclaimLeases: !sameProcess,
      });
      if (!replacement.ok) {
        return c.json(
          {
            ok: false,
            error: 'checkin rejected: not owner or attachment not found',
          },
          409,
        );
      }
      return c.json({ ok: true });
    }

    const ok = deps.registry.monitorCheckin({
      attachmentId,
      ownerToken: body.owner_token,
      ttlMs: STALE_THRESHOLD_MS,
      now,
    });
    if (!ok) {
      return c.json(
        {
          ok: false,
          error: 'checkin rejected: not owner or attachment not found',
        },
        409,
      );
    }

    return c.json({ ok: true });
  });

  // POST /monitor/emitted — transition leased → emitted for message ids
  route.post('/emitted', async (c) => {
    let body: { owner_token?: string; message_ids?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.owner_token) {
      return c.json({ ok: false, error: 'owner_token required' }, 400);
    }
    if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
      return c.json({ ok: false, error: 'message_ids array required' }, 400);
    }

    const now = Date.now();
    let transitioned = 0;
    for (const messageId of body.message_ids) {
      const changed = deps.registry.markMessageEmitted({
        messageId,
        ownerToken: body.owner_token,
        now,
      });
      if (changed) transitioned++;
    }

    return c.json({ ok: true, transitioned });
  });

  return route;
}

