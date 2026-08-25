import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MeshClient } from "../src/client/client.js";
import {
  brokerSocketPathOf,
  makeTempDirs,
  RawClient,
  startTestBroker,
} from "./helpers.js";
import { deriveSemanticIdentity } from "../src/extension/semantic-identity.js";

interface SemanticIdentity {
  repo: string;
  worktree: string;
  role: string;
}

function helloWithIdentity(
  client: RawClient,
  id: string,
  identity: SemanticIdentity,
): void {
  client.sendRaw(`${JSON.stringify({
    v: 1,
    type: "hello",
    id,
    ts: new Date().toISOString(),
    from: `${identity.repo}-${identity.worktree}-${identity.role}`,
    semanticIdentity: identity,
  })}\n`);
}

describe("semantic identity derivation", () => {
  it("derives repo, root worktree, and normalized role from a Git workspace", () => {
    const dirs = makeTempDirs("mesh-semantic-derive-");
    try {
      const repo = path.join(dirs.root, "mesh-repo");
      mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const identity = deriveSemanticIdentity(repo, { PI_SUBAGENT_AGENT: "QA Reviewer" });
      assert.deepEqual(identity, { repo: "mesh-repo", worktree: "root", role: "qa-reviewer" });
    } finally {
      dirs.cleanup();
    }
  });

  it("uses the workspace basename and root when Git metadata is unavailable", () => {
    const dirs = makeTempDirs("mesh-semantic-nongit-");
    try {
      const workspace = path.join(dirs.root, "plain-workspace");
      mkdirSync(workspace);
      assert.deepEqual(deriveSemanticIdentity(workspace, {}), {
        repo: "plain-workspace",
        worktree: "root",
        role: "agent",
      });
    } finally {
      dirs.cleanup();
    }
  });
});

describe("broker: semantic agent alias allocation", () => {
  it("names the invalid semantic identity component in broker errors", async (t) => {
    const dirs = makeTempDirs("mesh-semantic-invalid-");
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => broker.close());
    const client = await RawClient.connect(brokerSocketPathOf(dirs.runtimeDir));
    t.after(() => client.close());
    client.sendRaw(`${JSON.stringify({
      v: 1,
      type: "hello",
      id: "invalid-semantic",
      ts: new Date().toISOString(),
      from: "client",
      semanticIdentity: { repo: "___", worktree: "root", role: "agent" },
    })}\n`);
    const response = await client.waitFrame((frame) => frame.type === "error");
    assert.equal(response.code, "invalid_alias");
    assert.match(response.body ?? "", /repo/);
  });

  it("assigns the base alias and lowest suffix to concurrent agents with the same identity", async (t) => {
    const dirs = makeTempDirs("mesh-semantic-alias-");
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => broker.close());
    const socketPath = brokerSocketPathOf(dirs.runtimeDir);
    const first = await RawClient.connect(socketPath);
    const second = await RawClient.connect(socketPath);
    t.after(() => first.close());
    t.after(() => second.close());
    const identity = { repo: "pi-lpt-mesh", worktree: "root", role: "agent" };
    helloWithIdentity(first, "semantic-first", identity);
    helloWithIdentity(second, "semantic-second", identity);
    const [firstResult, secondResult] = await Promise.all([
      first.waitFrame((frame) => frame.type === "welcome" || frame.type === "error"),
      second.waitFrame((frame) => frame.type === "welcome" || frame.type === "error"),
    ]);
    const outcomes = [firstResult, secondResult]
      .map((frame) => frame.type === "welcome" ? `welcome:${frame.from}` : `error:${frame.code}`)
      .sort();
    assert.deepEqual(outcomes, [
      "welcome:pi-lpt-mesh-root-agent",
      "welcome:pi-lpt-mesh-root-agent-2",
    ].sort());
  });
});

describe("semantic aliases stay online-only after disconnect", () => {
  it("does not queue delivery to a disconnected semantic peer", async (t) => {
    const dirs = makeTempDirs("mesh-semantic-online-only-");
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => broker.close());
    const sender = new MeshClient({ alias: "sender", runtimeDir: dirs.runtimeDir, config: {} });
    const target = new MeshClient({
      semanticIdentity: { repo: "repo", worktree: "root", role: "agent" },
      runtimeDir: dirs.runtimeDir,
      config: {},
    });
    t.after(async () => Promise.all([sender.close(), target.close()]));
    await Promise.all([sender.connect(), target.connect()]);
    const targetAlias = target.alias;
    const peer = broker.state.peers.get(targetAlias);
    assert.ok(peer);
    const serverSocket = peer.socket as typeof peer.socket & { write: (...args: unknown[]) => boolean };
    serverSocket.write = ((_chunk: unknown, callback?: (error: Error) => void) => {
      callback?.(new Error("forced write failure"));
      return true;
    }) as typeof serverSocket.write;
    const result = await sender.send({ to: targetAlias, message: "must not mailbox" });
    assert.equal(result.status, "error");
    assert.match(result.reason ?? "", /dropped_offline/);
    assert.equal(broker.state.mailbox.has(targetAlias), false);
  });
});

describe("client: semantic alias continuity", () => {
  it("does not mailbox a semantic peer after broadcast write failure", async (t) => {
    const dirs = makeTempDirs("mesh-semantic-broadcast-online-only-");
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => broker.close());
    const sender = new MeshClient({ alias: "sender", runtimeDir: dirs.runtimeDir, config: {} });
    const target = new MeshClient({ semanticIdentity: { repo: "repo", worktree: "root", role: "agent" }, runtimeDir: dirs.runtimeDir, config: {} });
    t.after(async () => Promise.all([sender.close(), target.close()]));
    await Promise.all([sender.connect(), target.connect()]);
    const targetAlias = target.alias;
    const peer = broker.state.peers.get(targetAlias);
    assert.ok(peer);
    const serverSocket = peer.socket as typeof peer.socket & { write: (...args: unknown[]) => boolean };
    serverSocket.write = ((_chunk: unknown, callback?: (error: Error) => void) => {
      callback?.(new Error("forced broadcast write failure"));
      return true;
    }) as typeof serverSocket.write;
    const result = await sender.send({ broadcast: true, room: "default", message: "must not mailbox" });
    assert.equal(result.status, "error");
    assert.match(result.reason ?? "", /dropped_offline/);
    assert.equal(broker.state.mailbox.has(targetAlias), false);
  });
});

describe("client: semantic alias continuity", () => {
  it("moves designated reply targets when the target agent renames", async (t) => {
    const dirs = makeTempDirs("mesh-semantic-reply-");
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => broker.close());
    const a = new MeshClient({ alias: "sender", runtimeDir: dirs.runtimeDir, config: {} });
    const b = new MeshClient({ alias: "responder", runtimeDir: dirs.runtimeDir, config: {} });
    const c = new MeshClient({
      semanticIdentity: { repo: "repo", worktree: "root", role: "reviewer" },
      runtimeDir: dirs.runtimeDir,
      config: {},
    });
    t.after(async () => Promise.all([a.close(), b.close(), c.close()]));
    await Promise.all([a.connect(), b.connect(), c.connect()]);
    const oldAlias = c.alias;
    const inbound = new Promise<string>((resolve) => {
      b.once("inbound", (frame) => resolve(frame.id));
    });
    const sent = await a.send({ to: b.alias, message: "please review", replyTo: oldAlias });
    assert.equal(sent.status, "delivered");
    const msgId = await inbound;
    const renamed = await c.updateSemanticIdentity({ repo: "repo", worktree: "feature/review", role: "reviewer" });
    assert.equal(renamed.ok, true);
    const reply = await b.reply(msgId, "review complete");
    assert.equal(reply.status, "delivered");
  });
});
