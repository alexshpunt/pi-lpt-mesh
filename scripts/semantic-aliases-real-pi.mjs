// Deterministic real-Pi smoke for semantic aliases. Run after `npm run build`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const candidates = [
  process.env.PI_CODING_AGENT_TEST,
  path.resolve(repo, "../../../..", "pi-coding-agent-test", "dist", "index.js"),
  "/root/dev/pi/pi-coding-agent-test/dist/index.js",
].filter((candidate) => candidate !== undefined && existsSync(candidate));
const testPackage = candidates[0];
if (testPackage === undefined) throw new Error("pi-coding-agent-test is required; set PI_CODING_AGENT_TEST");
const {
  PiIntegrationTest,
  assistantMessage,
  getToolResultText,
  text,
  toolCall,
} = await import(testPackage);
const ptyPackage = path.resolve(testPackage, "../..", "node_modules", ".pnpm", "node-pty@1.1.0", "node_modules", "node-pty", "lib", "index.js");
if (!existsSync(ptyPackage)) throw new Error(`node-pty is required for literal reload: ${ptyPackage}`);
const { spawn } = await import(ptyPackage);

const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-mesh-semantic-real-pi-"));
const runtimeDir = path.join(workspace, "run");
const stateDir = path.join(workspace, "state");
await mkdir(runtimeDir);
await mkdir(stateDir);
const expectedAlias = `${path.basename(workspace).toLowerCase()}-root-agent`;
try {
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "mesh@example.test"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Mesh Test"], { cwd: workspace });
  execFileSync("git", ["commit", "--allow-empty", "-m", "fixture", "-q"], { cwd: workspace });

  const runStatus = (testName) => new PiIntegrationTest({
    testName,
    artifactsDir: ".agents/tmp/semantic-agent-aliases-real-pi",
    cwd: workspace,
    extensions: [path.join(repo, "dist", "src", "extension", "index.js")],
    tools: { include: ["mesh_status"] },
    environment: {
      ...process.env,
      MESH_RUNTIME_DIR: runtimeDir,
      MESH_STATE_DIR: stateDir,
      PI_SUBAGENT_AGENT: "agent",
    },
    conversation: [
      assistantMessage([toolCall({ id: "mesh-status", name: "mesh_status", arguments: {} })], { stopReason: "toolUse" }),
      assistantMessage([text("semantic alias checked")]),
    ],
  }).run("Check the current mesh status");

  const first = await runStatus("semantic-aliases-real-pi-initial");
  const firstStatus = getToolResultText(first, "mesh-status");
  if (!firstStatus.includes(expectedAlias)) throw new Error(`initial alias mismatch: expected ${expectedAlias}; got ${firstStatus}`);

  // A second real Pi lifecycle must preserve the same semantic alias after the
  // persisted identity is reloaded (the harness starts a fresh process here).
  const reloaded = await runStatus("semantic-aliases-real-pi-reload");
  const reloadedStatus = getToolResultText(reloaded, "mesh-status");
  if (!reloadedStatus.includes(expectedAlias)) throw new Error(`reload alias mismatch: expected ${expectedAlias}; got ${reloadedStatus}`);
  process.stdout.write(`PASS real-Pi semantic alias reload: ${expectedAlias}\n`);
  await runLiteralReload();
} finally {
  await rm(workspace, { recursive: true, force: true });
}


async function runLiteralReload() {
  const root = path.resolve(repo, ".agents", "tmp", "semantic-agent-aliases-real-pi-literal");
  const runtime = path.join(root, ".runtime");
  const session = path.join(runtime, "session");
  await mkdir(session, { recursive: true });
  const configPath = path.join(runtime, "config.json");
  const tracePath = path.join(runtime, "trace.jsonl");
  const conversation = [
    assistantMessage([toolCall({ id: "status-1", name: "mesh_status", arguments: {} })], { stopReason: "toolUse" }),
    assistantMessage([text("initial status checked")]),
    assistantMessage([toolCall({ id: "status-2", name: "mesh_status", arguments: {} })], { stopReason: "toolUse" }),
    assistantMessage([text("reloaded status checked")]),
  ];
  await writeFile(configPath, JSON.stringify({ conversation, providerMode: "scripted", tools: { include: ["mesh_status"] } }));
  await writeFile(tracePath, "");
  const harness = path.resolve(testPackage, "../harness/extension.js");
  const piArgs = ["--no-extensions", "--extension", harness, "--extension", path.join(repo, "dist", "src", "extension", "index.js"), "--model", "scripted/scripted-model", "--session-dir", session, "--approve", "Check the current mesh status"];
  const child = spawn("pi", piArgs, {
    cwd: workspace,
    name: "xterm-256color",
    cols: 160,
    rows: 50,
    env: {
      ...process.env,
      PI_INTEGRATION_TEST_CONFIG: configPath,
      PI_INTEGRATION_TEST_TRACE: tracePath,
      PI_INTEGRATION_TEST_RAW_TOOL_OUTPUT: "0",
      MESH_RUNTIME_DIR: runtimeDir,
      MESH_STATE_DIR: stateDir,
      PI_SUBAGENT_AGENT: "agent",
    },
  });
  let terminal = "";
  child.onData((data) => { terminal += data; });
  const readTrace = async () => {
    try { return (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  };
  const waitFor = async (predicate, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const events = await readTrace();
      if (predicate(events)) return events;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`literal reload timed out; terminal=${terminal}`);
  };
  try {
    await waitFor((events) => events.filter((event) => event.type === "provider_request").length >= 2);
    child.write("/reload\r");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    child.write("Check the current mesh status after reload\r");
    await waitFor((events) => events.filter((event) => event.type === "provider_request").length >= 4);
    const occurrences = terminal.toLowerCase().split(expectedAlias).length - 1;
    if (occurrences < 2) throw new Error(`literal reload did not show exact alias twice: ${terminal}`);
    process.stdout.write(`PASS literal /reload exact semantic alias: ${expectedAlias}\n`);
  } finally {
    child.kill();
  }
}
