// extension/commands.ts — /mesh command. All output via ctx.ui.notify.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { MeshRole } from "../protocol/envelope.js";
import { brokerLockPath, brokerSocketPath } from "../shared/paths.js";
import { MESH_VERSION } from "../shared/version.js";
import type { MeshHud } from "./hud.js";
import { identityFromClient } from "./identity.js";
import type { ExtensionAPI, SessionContext } from "./pi-types.js";
import type { GetRuntime, MeshRuntime } from "./tools.js";

export const HELP_TEXT = [
  "/mesh status [room]   — broker snapshot (online peers, rooms)",
  "/mesh join <room> [observer]",
  "/mesh leave <room>",
  "/mesh log [on|off]    — opt-in transcript (redacted bodies)",
  "/mesh ping <alias>    — send a one-shot ping message",
  "/mesh stale           — reservations held by peers, with age (TTL insight)",
  "/mesh broker          — socket path, lock pid, session state",
  "/mesh help",
].join("\n");

function notify(ctx: SessionContext, message: string): void {
  ctx.ui.notify(message, { level: "info" });
}

/** persist alias/rooms after a mutation (join/leave/rename). */
function persistIdentity(rt: MeshRuntime): void {
  try {
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
  } catch {
  // best effort
  }
}

/** Parse `/mesh join <room> [observer]` args. */
export function parseJoinArgs(args: string[]): { room?: string; observer: boolean } {
  const observer = args.includes("observer");
  if (args.includes("as")) return { room: undefined, observer };
  return { room: args.find((a) => a !== "observer"), observer };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStatus(rt: MeshRuntime, ctx: SessionContext, room?: string): Promise<void> {
  if (!rt.client.isOnline()) {
    try {
      await rt.client.connect();
    } catch {
      notify(ctx, "mesh: blocked broker_unavailable");
      return;
    }
  }
  const snap = await rt.client.status(room);
  if (snap.peers.length === 0) {
    notify(ctx, `mesh: no online peers${room !== undefined ? ` in room ${room}` : ""}`);
    return;
  }
  const lines = snap.peers.map(
    (p) => `@${p.alias} rooms=${p.rooms.join(",")}${p.since !== undefined ? ` since=${p.since}` : ""}${p.via !== undefined ? ` via=${p.via} ⟵ other machine` : ""}`,
  );
  notify(ctx, `mesh peers (${snap.peers.length}):\n${lines.join("\n")}\nrooms: ${snap.rooms.join(", ") || "(none)"}`);
}

async function cmdJoin(
  rt: MeshRuntime,
  ctx: SessionContext,
  room: string | undefined,
  observer: boolean,
): Promise<void> {
  if (room === undefined) {
    notify(ctx, "usage: /mesh join <room> [observer]");
    return;
  }
  const role: MeshRole = observer ? "observer" : "member";
  try {
    await rt.client.join(room, role);
    notify(ctx, `mesh: joined ${room} as ${role}`);
    persistIdentity(rt);
  } catch (err) {
    notify(ctx, `mesh: join failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdLeave(rt: MeshRuntime, ctx: SessionContext, room: string | undefined): Promise<void> {
  if (room === undefined) {
    notify(ctx, "usage: /mesh leave <room>");
    return;
  }
  try {
    await rt.client.leave(room);
    notify(ctx, `mesh: left ${room}`);
    persistIdentity(rt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "not_member") {
  // Honest + friendly: the broker does not know us in this room. The
  // local joinedRooms set is resynced by client.leave so a later
  // reconnect does not try to rejoin it.
      notify(ctx, `mesh: not in room "${room}" — nothing to leave`);
    } else {
      notify(ctx, `mesh: leave failed: ${msg}`);
    }
  }
}

function cmdLog(
  rt: MeshRuntime, ctx: SessionContext, arg: string | undefined): void {
  if (arg === "on") {
    rt.transcript.setEnabled(true);
    notify(ctx, "mesh: transcript ON (bodies redacted, retention applies)");
  } else if (arg === "off") {
    rt.transcript.setEnabled(false);
    notify(ctx, "mesh: transcript OFF");
  } else {
    notify(ctx, `mesh: transcript is ${rt.transcript.isEnabled() ? "ON" : "OFF"}`);
  }
}

async function cmdPing(rt: MeshRuntime, ctx: SessionContext, alias: string | undefined): Promise<void> {
  if (alias === undefined) {
    notify(ctx, "usage: /mesh ping <alias>");
    return;
  }
  const res = await rt.client.send({ to: alias, message: "ping" });
  switch (res.status) {
    case "delivered":
      notify(ctx, `mesh: pong-path ok — delivered ${res.msgId}`);
      break;
    case "queued_offline":
      notify(ctx, `mesh: @${alias} offline — queued ${res.msgId}`);
      break;
    default:
      notify(ctx, `mesh: ping ${res.status}${"reason" in res ? `: ${res.reason}` : ""}`);
  }
}

/** `/mesh stale` — pure report builder: every reservation currently
 *  blocking peers, with its age vs the TTL (measured: 10 leaked claims,
 *  some blocking edits for 5+ h). Exported for tests. */
export function buildStaleReport(
  reservationsByPeer: ReadonlyMap<string, readonly { pattern: string; reason?: string; since?: string }[]>,
  selfAlias: string,
  ttlMs: number,
  activityOf: (alias: string) => { state: string } | undefined,
  now: number = Date.now(),
): string[] {
  const rows: string[] = [];
  for (const [alias, reservations] of reservationsByPeer) {
    if (alias === selfAlias) continue;
    for (const r of reservations) {
      const t = r.since !== undefined ? Date.parse(r.since) : Number.NaN;
      const ageH = Number.isNaN(t) ? "?" : `${((now - t) / 3_600_000).toFixed(1)}h`;
      const expired =
        ttlMs > 0 && !Number.isNaN(t) && now - t > ttlMs ? " (EXPIRED — ignorable)" : "";
      const act = activityOf(alias);
      const state = act === undefined ? "" : act.state === "busy" ? " · busy" : ` · ${act.state}`;
      rows.push(`  @${alias} · ${r.pattern} · held ${ageH}${state}${expired}`);
    }
  }
  return rows;
}

function cmdStale(rt: MeshRuntime, ctx: SessionContext): void {
  const rows = buildStaleReport(
    rt.client.peerReservationMap,
    rt.client.alias,
    rt.client.reservationTtlMs,
    (a) => rt.client.activityOf(a),
  );
  if (rows.length === 0) {
    notify(ctx, "mesh: no peer reservations (nothing stale)");
    return;
  }
  const ttlMs = rt.client.reservationTtlMs;
  notify(
    ctx,
    `mesh reservations held by peers (TTL ${ttlMs > 0 ? `${(ttlMs / 3_600_000).toFixed(0)} h` : "off"}):\n${rows.join("\n")}`,
  );
}

/** Phase 3: session file size + compaction count (context pressure hint). */
function sessionHealth(rt: MeshRuntime): { sizeMb: number; compactions: number; path: string } | null {
  const file = rt.ctx?.sessionManager?.getSessionFile?.();
  if (file === undefined || file === "") return null;
  let sizeMb = 0;
  let compactions = 0;
  try {
    sizeMb = statSync(file).size / 1e6;
  // count compaction entries — streaming scan, bounded to the first MBs
    const fd = openSync(file, "r");
    try {
      const CHUNK = 256 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      let carry = "";
      let scanned = 0;
      for (;;) {
        const n = readSync(fd, buf, 0, CHUNK, pos);
        if (n <= 0) break;
        pos += n;
        scanned += n;
        const text = carry + buf.subarray(0, n).toString("utf8");
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (line.includes('"compaction"')) compactions += 1;
        }
        if (scanned > 4 * 1024 * 1024) break; // good enough; never block
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  return { sizeMb, compactions, path: file };
}

function cmdBroker(rt: MeshRuntime, ctx: SessionContext): void {
  const sock = brokerSocketPath(rt.runtimeDir);
  let lockInfo = "absent";
  try {
    const pid = Number(readFileSync(brokerLockPath(rt.runtimeDir), "utf8").trim());
    if (Number.isFinite(pid)) lockInfo = `pid=${pid} alive=${pidAlive(pid)}`;
  } catch {
  // no lock file
  }
  const uptimeS = Math.floor((Date.now() - rt.startedAt) / 1000);
  const lines = [
    `mesh broker:`,
    `  version: ${MESH_VERSION}`,
    `  socket: ${sock}`,
    `  lock: ${lockInfo}`,
    `  online: ${rt.client.isOnline()}`,
    `  session uptime: ${uptimeS}s`,
    `  inbound failures: ledger=${rt.ledgerFailures} transcript=${rt.transcriptFailures} injection=${rt.injectionFailures}`,
  ];
  // Phase 3: context pressure — a huge session means frequent compactions
  const health = sessionHealth(rt);
  if (health !== null) {
    lines.push(`  session file: ${health.sizeMb.toFixed(1)} MB · ${health.compactions} compaction(s)`);
    if (health.sizeMb > 15) {
      lines.push(`  hint: start a fresh Pi session soon (context pressure)`);
    }
  }
  notify(ctx, lines.join("\n"));
}

export function registerCommands(
  pi: ExtensionAPI,
  getRuntime: GetRuntime,
  onChanged?: () => void, // HUD refresh after join/leave/log toggles
  getHud: () => MeshHud | null = () => null,
): void {
  pi.registerCommand("mesh", {
    description: "mesh inter-agent coms: status, join/leave, log, ping, broker",
    handler: async (args, ctx) => {
      const rt = getRuntime();
      if (rt === null) {
        notify(ctx, "mesh: session not started");
        return;
      }
      const [sub, ...rest] = args.trim().split(/\s+/).filter((s) => s.length > 0);
      switch (sub) {
        case "status":
          await cmdStatus(rt, ctx, rest[0]);
          break;
        case "join": {
          const parsed = parseJoinArgs(rest);
          await cmdJoin(rt, ctx, parsed.room, parsed.observer);
          onChanged?.();
          break;
        }
        case "leave":
          await cmdLeave(rt, ctx, rest[0]);
          onChanged?.();
          break;
        case "log":
          cmdLog(rt, ctx, rest[0]);
          onChanged?.();
          break;
        case "ping":
          await cmdPing(rt, ctx, rest[0]);
          break;
        case "stale":
          cmdStale(rt, ctx);
          break;
        case "broker":
          cmdBroker(rt, ctx);
          break;
        case "help":
        case undefined:
          notify(ctx, HELP_TEXT);
          break;
        default:
          notify(ctx, `mesh: unknown subcommand '${sub}'\n${HELP_TEXT}`);
      }
    },
  });
}
