// test/workspace-isolation.test.ts — broker-level contracts for workspace-tree isolation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";
import {
  brokerSocketPathOf,
  makeTempDirs,
  RawClient,
  startTestBroker,
} from "./helpers.js";

interface WorkspaceDescriptor {
  projectId: string;
  worktreeId: string;
  path: string[];
}

interface WorkspaceFrame extends MeshFrame {
  workspace: WorkspaceDescriptor;
}

interface DiagnosticStatusFrame extends MeshFrame {
  all: true;
}

const REPO = "git:test-repository";
const MAIN: WorkspaceDescriptor = { projectId: REPO, worktreeId: "root", path: [] };
const LINKED_B: WorkspaceDescriptor = { projectId: REPO, worktreeId: "linked-b", path: [] };
const LINKED_C: WorkspaceDescriptor = { projectId: REPO, worktreeId: "linked-c", path: [] };

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const dirs = makeTempDirs("mesh-workspace-isolation-");
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir);
  t.after(() => broker.close());
  return brokerSocketPathOf(dirs.runtimeDir);
}

async function connectAt(
  t: { after: (fn: () => void) => void },
  socketPath: string,
  alias: string,
  workspace: WorkspaceDescriptor,
  rooms: string[] = ["default"],
): Promise<RawClient> {
  const client = await RawClient.connect(socketPath);
  t.after(() => client.close());
  const hello = buildFrame({ type: "hello", from: alias, rooms }) as WorkspaceFrame;
  hello.workspace = workspace;
  client.sendFrame(hello);
  const response = await client.waitFrame((frame) => frame.id === hello.id);
  assert.equal(response.type, "welcome", `workspace hello for ${alias} must be accepted`);
  return client;
}

async function status(client: RawClient, alias: string, all = false): Promise<MeshFrame> {
  const request = buildFrame({ type: "status_req", from: alias });
  if (all) (request as DiagnosticStatusFrame).all = true;
  client.sendFrame(request);
  return client.waitFrame((frame) => frame.type === "status_res" && frame.id === request.id);
}

async function join(client: RawClient, alias: string, room: string): Promise<void> {
  const request = buildFrame({ type: "join", from: alias, room });
  client.sendFrame(request);
  const response = await client.waitFrame((frame) => frame.id === request.id);
  assert.equal(response.type, "ack");
  assert.equal(response.status, "ok");
}

async function send(
  client: RawClient,
  from: string,
  to: string,
  room: string,
  body: string,
): Promise<MeshFrame> {
  const request = buildFrame({ type: "msg", from, to, room, body });
  client.sendFrame(request);
  return client.waitFrame(
    (frame) => frame.id === request.id && (frame.type === "ack" || frame.type === "error"),
  );
}

function aliases(frame: MeshFrame): string[] {
  return (frame.peers ?? []).map((peer) => peer.alias).sort();
}

describe("workspace peer isolation", () => {
  it("rejects and closes a hello that omits mandatory workspace metadata", async (t) => {
    const socketPath = await fixture(t);
    const client = await RawClient.connect(socketPath);
    t.after(() => client.close());

    const hello = buildFrame({ type: "hello", from: "legacy", rooms: ["default"] });
    client.sendFrame(hello);
    const response = await client.waitFrame(
      (frame) => frame.id === hello.id && (frame.type === "welcome" || frame.type === "error"),
    );

    assert.equal(response.type, "error", "a client without a workspace must not enter the mesh");
    await client.waitClosed();
    assert.equal(client.closed, true);
  });

  it("hides linked-worktree siblings normally while preserving the all-status diagnostic", async (t) => {
    const socketPath = await fixture(t);
    const root = await connectAt(t, socketPath, "root-agent", MAIN);
    const branchB = await connectAt(t, socketPath, "branch-b", LINKED_B);
    await connectAt(t, socketPath, "branch-c", LINKED_C);

    const rootView = await status(root, "root-agent");
    const normalView = await status(branchB, "branch-b");
    const diagnosticView = await status(branchB, "branch-b", true);

    assert.deepEqual(aliases(rootView), ["branch-b", "branch-c", "root-agent"]);
    assert.deepEqual(
      aliases(normalView),
      ["branch-b", "root-agent"],
      "a linked worktree must not discover its sibling through normal status",
    );
    assert.deepEqual(
      aliases(diagnosticView),
      ["branch-b", "branch-c", "root-agent"],
      "all: true remains the sole diagnostic visibility bypass",
    );
    for (const peer of diagnosticView.peers ?? []) {
      assert.equal("workspace" in peer, false, "workspace metadata must not leak into peer snapshots");
    }
  });

  it("rechecks queued delivery authorization when a target reconnects", async (t) => {
    const socketPath = await fixture(t);
    const branchB = await connectAt(t, socketPath, "branch-b", LINKED_B);
    const branchC = await connectAt(t, socketPath, "branch-c", LINKED_C);
    await join(branchB, "branch-b", "review");
    await join(branchC, "branch-c", "review");
    branchC.close();
    await branchC.waitClosed();
    const queued = await send(branchB, "branch-b", "branch-c", "review", "queued");
    assert.equal(queued.type, "ack");
    assert.equal(queued.status, "queued_offline");

    const reconnect = await RawClient.connect(socketPath);
    t.after(() => reconnect.close());
    const hello = buildFrame({ type: "hello", from: "branch-c", rooms: ["default"] }) as WorkspaceFrame;
    hello.workspace = LINKED_C;
    reconnect.sendFrame(hello);
    const welcome = await reconnect.waitFrame((frame) => frame.type === "welcome" && frame.id === hello.id);
    assert.equal(welcome.mailboxCount, 0, "a changed room set must not receive stale queued delivery");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(reconnect.frames.some((frame) => frame.type === "mailbox"), false);
  });

  it("uses a shared non-default room for sibling visibility and delivery without unlocking default", async (t) => {
    const socketPath = await fixture(t);
    const branchB = await connectAt(t, socketPath, "branch-b", LINKED_B);
    const branchC = await connectAt(t, socketPath, "branch-c", LINKED_C);

    await join(branchB, "branch-b", "review");
    await join(branchC, "branch-c", "review");

    const visibleAfterJoin = await status(branchB, "branch-b");
    const blockedInDefault = await send(branchB, "branch-b", "branch-c", "default", "hidden");
    const deliveredInReview = await send(branchB, "branch-b", "branch-c", "review", "shared");

    assert.ok(aliases(visibleAfterJoin).includes("branch-c"));
    assert.equal(blockedInDefault.type, "error");
    assert.equal(
      blockedInDefault.code,
      "peer_not_found",
      "a blocked sibling must look identical to an unavailable alias",
    );
    assert.equal(deliveredInReview.type, "ack");
    assert.equal(deliveredInReview.status, "delivered");
  });
});
