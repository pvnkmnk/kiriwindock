// Every action, run for real against a throwaway compose project: two tiny services, one with a bind
// mount ("web") and one without ("api"), each from its own git repo with worktrees.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { state } from "./herdr-shim.mjs";
import { Store } from "../mods/dockr/store.js";
import * as docker from "../mods/dockr/docker.js";
import * as model from "../mods/dockr/model.js";

const hasDocker = !process.env.DOCKR_SKIP_DOCKER && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const opts = { skip: hasDocker ? false : "Docker is not running" };

const NAME = `dockr-test-${process.pid}`;
let root, store, compose;
const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (cwd, ...args) => sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args);
/** Runs an action's script as its terminal would, with no keyboard: a failure does not wait for Enter. */
const run = (op) => spawnSync("sh", ["-c", op.script], { cwd: op.stack.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HC_TERMINAL_ID: "" } });
const row = (name) => store.rows(NAME).find((r) => r.name === name);
const look = () => store.look("");
const source = (name, branch) => row(name).sources.find((s) => s.branch === branch);
const who = () => sh(root, "docker", "exec", `${NAME}-web-1`, "cat", "/app/src/who.txt").trim();

function repo(name, files) {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function worktree(repoDir, branch, files) {
  const dir = join(root, "wt", branch, repoDir.split("/").pop());
  git(repoDir, "worktree", "add", "-q", "-b", branch, dir);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

before(() => {
  if (!hasDocker) return;
  root = mkdtempSync(join(tmpdir(), "dockr-"));
  const web = repo("web", {
    Dockerfile: 'FROM busybox:1.36\nWORKDIR /app\nCOPY package.json package-lock.json ./\nCOPY src ./src\nCMD ["sh", "-c", "while true; do sleep 1; done"]\n',
    "package.json": '{"name":"web","version":"1.0.0"}\n', "package-lock.json": "{}\n", "src/who.txt": "main\n",
  });
  worktree(web, "feat", { "src/who.txt": "feat\n" });
  worktree(web, "deps", { "src/who.txt": "deps\n", "package.json": '{"name":"web","version":"2.0.0"}\n' });
  const api = repo("api", { Dockerfile: 'FROM busybox:1.36\nWORKDIR /app\nCOPY src ./src\nCMD ["sh", "-c", "while true; do sleep 1; done"]\n', "src/who.txt": "main\n" });
  worktree(api, "feat", { "src/who.txt": "feat\n" });
  const dir = join(root, "stack");
  mkdirSync(dir);
  compose = join(dir, "compose.yml");
  writeFileSync(compose, `name: ${NAME}
services:
  web:
    build:
      context: \${WEB_PATH:-../web}
    stop_grace_period: 0s
    volumes:
      - \${WEB_PATH:-../web}/src:/app/src
  api:
    build:
      context: \${API_PATH:-../api}
    stop_grace_period: 0s
    environment:
      DOCKR_SECRET: hunter2-value
`);
  state.appHome = join(root, "home");
  mkdirSync(state.appHome);
  writeFileSync(join(state.appHome, "dockr.json"), JSON.stringify({ stacks: [{ name: NAME, compose, services: { web: { var: "WEB_PATH", main: web }, api: { var: "API_PATH", main: api, manifests: ["src/who.txt"] } } }] }));
  store = new Store();
});

after(() => {
  if (!hasDocker || !root) return;
  spawnSync("docker", ["compose", "-f", compose, "down", "-v", "--rmi", "local", "--remove-orphans"], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
});

test("Up brings the Stack up from the Main checkouts, with no Drift and no .dockr.env", opts, async () => {
  await store.reload();
  assert.deepEqual(store.problems, []);
  assert.equal(row("web").container, null);
  const op = await store.prepareStack(NAME, "up");
  assert.equal(op.labels.verb, "up");
  const r = run(op);
  assert.equal(r.status, 0, r.stderr);
  await look();
  assert.equal(row("web").container.state, "running");
  assert.equal(row("web").actual.branch, "main");
  assert.equal(row("web").mounted, true);
  assert.equal(row("web").drift, false);
  assert.equal(row("api").actual, null); // Not mounted and not built by Dockr yet: unknown.
  assert.equal(existsSync(join(root, "stack", ".dockr.env")), false);
  assert.equal(who(), "main");
});

test("no environment value reaches Dockr, only the names", opts, async () => {
  const r = await docker.snapshot(null);
  const api = r.containers.find((c) => c.name === `${NAME}-api-1`);
  assert.ok(api.env.includes("DOCKR_SECRET"));
  assert.equal(JSON.stringify(r).includes("hunter2-value"), false);
  assert.ok(api.networks.length > 0);
  const web = r.containers.find((c) => c.name === `${NAME}-web-1`);
  assert.ok(web.mounts.some((x) => x.target === "/app/src"));
});

test("a container that fails says why, with its last lines", opts, async () => {
  const name = `${NAME}-crash`;
  sh(root, "docker", "run", "-d", "--name", name, "--label", `com.docker.compose.project=${NAME}`, "--label", "com.docker.compose.service=crash", "busybox:1.36", "sh", "-c", "echo one; echo two; echo boom >&2; exit 3");
  try {
    spawnSync("docker", ["wait", name], { stdio: "ignore" });
    await look();
    const c = row("crash").container;
    assert.equal(model.why(c), "exited 3");
    assert.deepEqual(store.tail(c).sort(), ["boom", "one", "two"]);
    const sick = `${NAME}-sick`;
    sh(root, "docker", "run", "-d", "--name", sick, "--label", `com.docker.compose.project=${NAME}`, "--label", "com.docker.compose.service=sick",
      "--health-cmd", "echo no database; exit 1", "--health-interval", "1s", "--health-retries", "1", "busybox:1.36", "sh", "-c", "while true; do sleep 1; done");
    try {
      for (let i = 0; i < 40 && row("sick")?.container?.health !== "unhealthy"; i++) { spawnSync("sleep", ["0.5"]); await look(); }
      assert.equal(model.why(row("sick").container), "health check: no database");
    } finally { spawnSync("docker", ["rm", "-f", sick], { stdio: "ignore" }); }
  } finally { spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }); }
  await look();
});

test("the log wait returns new lines without losing or repeating any, and says when the container stops", opts, async () => {
  const name = `${NAME}-chatty`;
  sh(root, "docker", "run", "-d", "--name", name, "busybox:1.36", "sh", "-c", "i=0; while [ $i -lt 3000 ]; do i=$((i+1)); echo line $i; [ $((i % 500)) -eq 0 ] && sleep 0.3; done");
  try {
    let all = [], since = "", ended = false;
    for (let k = 0; k < 60 && !ended; k++) {
      const r = await docker.waitLogs(null, name, since, 100000);
      assert.equal(r.error, undefined);
      const got = model.parseLogs(r.text, "chatty");
      all = model.addLogs(all, got.lines, since, 100000);
      for (const l of got.lines) if (l.at > since) since = l.at;
      ended = got.ended;
    }
    assert.equal(ended, true);
    assert.deepEqual(all.map((l) => l.text), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`));
    const wait = docker.waitStart(null, name);
    spawnSync("sleep", ["1"]);
    sh(root, "docker", "start", name);
    assert.equal((await wait).started, true);
  } finally { spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }); }
});

test("a checkout whose dependencies changed is marked as needing a rebuild, until it is rebuilt", opts, async () => {
  const file = join(root, "web", "package.json"), before = readFileSync(file, "utf8");
  await store.checkStale();
  assert.deepEqual(store.stale, {});
  const rebuild = async () => { const r = run(await store.prepareRebuild(row("web"))); assert.equal(r.status, 0, r.stderr); await look(); await store.checkStale(); };
  try {
    writeFileSync(file, '{"name":"web","version":"9.9.9"}\n');
    await store.checkStale();
    assert.deepEqual(store.stale, { [`${NAME}/web`]: true });
    await rebuild();
    assert.deepEqual(store.stale, {});
  } finally { writeFileSync(file, before); }
  await store.checkStale();
  assert.deepEqual(store.stale, { [`${NAME}/web`]: true });
  await rebuild();
  assert.deepEqual(store.stale, {});
});

test("the picker's list is the Repo's worktrees plus the branches no checkout is on", opts, async () => {
  git(join(root, "web"), "branch", "idea");
  const [list, all] = await Promise.all([docker.worktrees(null, join(root, "web")), docker.branches(null, join(root, "web"))]);
  assert.deepEqual(list.map((s) => s.branch).sort(), ["deps", "feat", "main"]);
  assert.deepEqual(model.looseBranches(all, list), ["idea"]);
});

test("the stats wait returns one sample that names the running containers", opts, async () => {
  const r = await docker.waitStats(null);
  assert.equal(r.error, undefined);
  const s = model.parseStats(r.text);
  assert.ok(s[`${NAME}-web-1`], Object.keys(s).join(","));
  assert.ok(s[`${NAME}-web-1`].mem > 0);
  assert.ok(s[`${NAME}-web-1`].cpu >= 0);
});

test("costs says which checkouts need a rebuild before anything is switched", opts, async () => {
  const r = row("web");
  const costs = await store.costs(store.stack(NAME), { sources: r.sources, runs: r.actual.path, mounted: r.mounted, image: r.container.image, manifests: r.service.manifests });
  assert.deepEqual(Object.fromEntries(r.sources.map((s) => [s.branch, costs[s.path]])), { main: "current", feat: "recreate", deps: "rebuild" });
});

test("a Switch with the same dependencies recreates the container and does not rebuild", opts, async () => {
  const image = row("web").container.imageId;
  const op = await store.prepareSwitch(NAME, { web: source("web", "feat") }, false, "Switch web to feat");
  assert.equal(op.error, undefined);
  assert.deepEqual(op.labels.build, "");
  assert.equal(op.labels.services, "web");
  assert.doesNotMatch(op.script, / 'build' /);
  assert.equal(run(op).status, 0);
  await look();
  assert.equal(row("web").actual.branch, "feat");
  assert.equal(row("web").drift, false);
  assert.equal(row("web").container.imageId, image);
  assert.equal(who(), "feat");
  assert.equal(readFileSync(join(root, "stack", ".dockr.env"), "utf8"), `# Written by Dockr: the checkout each Service runs from.\nWEB_PATH=${source("web", "feat").path}\n`);
  assert.equal(op.undo.targets.web.branch, "main");
});

test("a Switch to a checkout with other dependencies rebuilds, and its undo goes back", opts, async () => {
  const image = row("web").container.imageId;
  const op = await store.prepareSwitch(NAME, { web: source("web", "deps") }, false, "Switch web to deps");
  assert.equal(op.labels.build, "web");
  assert.match(op.script, / 'build' 'web'/);
  assert.equal(run(op).status, 0);
  await look();
  assert.equal(row("web").actual.branch, "deps");
  assert.notEqual(row("web").container.imageId, image);
  assert.equal(op.undo.targets.web.branch, "feat");
  const back = await store.prepareSwitch(NAME, op.undo.targets, false, "Back to feat");
  assert.equal(run(back).status, 0);
  await look();
  assert.equal(row("web").actual.branch, "feat");
});

test("a compose run by hand shows as Drift, and Apply brings the Service back", opts, async () => {
  sh(root, "docker", "compose", "-f", compose, "up", "-d", "web");
  await look();
  assert.equal(row("web").actual.branch, "main");
  assert.equal(row("web").set.branch, "feat");
  assert.equal(row("web").drift, true);
  const op = await store.prepareSwitch(NAME, { web: row("web").set }, false, "Apply web");
  assert.equal(run(op).status, 0);
  await look();
  assert.equal(row("web").drift, false);
  assert.equal(who(), "feat");
});

test("a branch with no worktree is checked out in the Main checkout, and its undo goes back", opts, async () => {
  const main = join(root, "web");
  git(main, "switch", "-q", "-c", "solo");
  writeFileSync(join(main, "src/who.txt"), "solo\n");
  git(main, "commit", "-qam", "solo");
  git(main, "switch", "-q", "main");
  const target = { ...source("web", "main"), branch: "solo" };
  const op = await store.prepareSwitch(NAME, { web: target }, false, "Check out solo for web", { main, branch: "solo" });
  assert.equal(op.error, undefined);
  assert.equal(run(op).status, 0);
  assert.equal(git(main, "branch", "--show-current").trim(), "solo");
  assert.equal(who(), "solo");
  assert.deepEqual(op.undo.checkout, { main, branch: "main" });
  assert.equal(op.undo.targets.web.branch, "feat");
  // Git refuses when uncommitted work would be overwritten, and Dockr changes nothing.
  writeFileSync(join(main, "src/who.txt"), "dirty\n");
  const refused = await store.prepareSwitch(NAME, { web: target }, false, "Check out main for web", { main, branch: "main" });
  assert.match(refused.error, /Git kept the branch/);
  assert.equal(git(main, "branch", "--show-current").trim(), "solo");
  git(main, "checkout", "--", "src/who.txt");
  const back = await store.prepareSwitch(NAME, op.undo.targets, false, "Back to feat", op.undo.checkout);
  assert.equal(run(back).status, 0);
  assert.equal(git(main, "branch", "--show-current").trim(), "main");
  await look();
  assert.equal(who(), "feat");
});

test("Stop, Start and Restart run to their end, and a stopped Service is only set unless started", opts, async () => {
  assert.equal(await store.quick(row("web"), ["stop"]), null);
  assert.equal(row("web").container.state, "exited");
  const set = await store.prepareSwitch(NAME, { web: source("web", "main") }, false, "Switch web to main");
  assert.equal(set.script, undefined);
  assert.match(set.note, /Nothing was running/);
  assert.equal(model.parseEnv(readFileSync(join(root, "stack", ".dockr.env"), "utf8")).WEB_PATH, undefined);
  const op = await store.prepareSwitch(NAME, { web: source("web", "feat") }, true, "Switch web to feat");
  assert.equal(run(op).status, 0);
  await look();
  assert.equal(row("web").container.state, "running");
  assert.equal(who(), "feat");
  assert.equal(await store.quick(row("web"), ["restart"]), null);
  assert.equal(row("web").container.state, "running");
  assert.match(await store.quick({ ...row("web"), name: "nope" }, ["start"]), /no service by that name/);
});

test("a Service with no bind mount always rebuilds, and Dockr then knows its Source", opts, async () => {
  const op = await store.prepareSwitch(NAME, { api: source("api", "feat") }, false, "Switch api to feat");
  assert.equal(op.labels.build, "api");
  assert.equal(run(op).status, 0);
  await look();
  assert.equal(row("api").actual.branch, "feat");
  assert.equal(row("api").drift, false);
  assert.equal(sh(root, "docker", "exec", `${NAME}-api-1`, "cat", "/app/src/who.txt").trim(), "feat");
  assert.equal(row("web").actual.branch, "feat"); // The other Service kept its Source.
});

test("Rebuild, the log tail and the shell produce commands that run", opts, async () => {
  const rebuild = await store.prepareRebuild(row("web"));
  assert.equal(run(rebuild).status, 0);
  const logs = await store.prepareTail(row("web"), "logs");
  assert.match(logs.script, /'logs' '-f' '--tail' '200' 'web'$/);
  const once = spawnSync("sh", ["-c", logs.script.replace("'logs' '-f' ", "'logs' ")], { cwd: logs.stack.dir, encoding: "utf8" });
  assert.equal(once.status, 0, once.stderr);
  const shell = await store.prepareTail(row("web"), "shell");
  const probe = spawnSync("sh", ["-c", shell.script.replace("exec -it", "exec -i")], { input: "cat /app/src/who.txt\n", encoding: "utf8" });
  assert.equal(probe.stdout.trim(), "feat", probe.stderr);
});

test("the wait returns when a container changes, and continues from just after it", opts, async () => {
  await look();
  const waiting = docker.waitEvent(null, "");
  await new Promise((ok) => setTimeout(ok, 1500));
  sh(root, "docker", "restart", "-t", "0", `${NAME}-web-1`);
  const r = await waiting;
  assert.equal(r.event, true);
  assert.match(r.since, /^\d{10}\.\d{9}$/);
  const quiet = await Promise.race([docker.waitEvent(null, r.since), new Promise((ok) => setTimeout(() => ok("still waiting"), 4000))]);
  assert.equal(quiet, "still waiting"); // Nothing is replayed.
});

test("a failing action exits with its code and labels its terminal", opts, async () => {
  const op = store.op(store.stack(NAME), "Fail", "switch", ["web"], [], ["sh -c 'exit 7'"]);
  // hc is looked for in its usual places: a background terminal's PATH may lack it.
  assert.match(op.script, /for h in hc "\$HOME\/\.local\/bin\/hc" hc\.exe; do "\$h" label "\$HC_TERMINAL_ID" dockr\.failed="\$code"/);
  assert.equal(run(op).status, 7);
});

test("a container outside every Stack starts, stops and restarts by name, and a Stack stops as a whole", opts, async () => {
  const name = `${NAME}-loose`;
  sh(root, "docker", "run", "-d", "--name", name, "--stop-timeout", "0", "busybox:1.36", "sh", "-c", "while true; do sleep 1; done");
  try {
    await look();
    const find = () => store.view().other.find((r) => r.name === name);
    assert.equal(find().container.state, "running");
    assert.deepEqual(model.groupOther(store.view().other).filter((g) => g.rows.some((r) => r.key === find().key)).map((g) => g.name), [null]);
    assert.equal(await store.plain("stop", [find().container]), null);
    assert.equal(find().container.state, "exited");
    assert.equal(await store.plain("start", [find().container]), null);
    assert.equal(find().container.state, "running");
    assert.equal(await store.plain("restart", [find().container]), null);
    assert.equal(find().container.state, "running");
    const shell = store.prepareShell(find());
    assert.match(shell.script, new RegExp(`docker exec -it '${name}'`));
    assert.match(await store.plain("start", [{ ...find().container, name: `${name}-nope` }]), /^start: /);
  } finally { spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }); }
  await look();
  if (!row("web").container || row("web").container.state !== "running") { const r = run(await store.prepareStack(NAME, "up")); assert.equal(r.status, 0, r.stderr); await look(); }
  assert.equal(await store.stopStack(NAME), null);
  assert.ok(store.rows(NAME).every((r) => r.container && r.container.state === "exited"));
  const r = run(await store.prepareStack(NAME, "up"));
  assert.equal(r.status, 0, r.stderr);
  await look();
  assert.ok(store.rows(NAME).every((r) => r.container.state === "running"));
});

test("a booting container's newest log line is read for its row", opts, async () => {
  const name = `${NAME}-boot`;
  sh(root, "docker", "run", "-d", "--name", name, "busybox:1.36", "sh", "-c", "echo step one; echo 'Now listening on 80'; echo; sleep 30");
  try {
    await look();
    const c = store.containers().find((x) => x.name === name);
    assert.equal(model.booting(c), true);
    const r = await docker.waitLogs(null, name, "", 5);
    assert.equal(r.error, undefined);
    assert.equal(model.bootLine(model.parseLogs(r.text).lines), "Now listening on 80");
  } finally { sh(root, "docker", "rm", "-f", name); }
});

test("Clean up removes the images a rebuild left behind and keeps the volume", opts, async () => {
  const volume = `${NAME}_keep`;
  sh(root, "docker", "volume", "create", "--label", `com.docker.compose.project=${NAME}`, volume);
  try {
    const read = async () => { const r = await docker.disk(null, NAME); assert.equal(r.error, undefined); return model.parseDisk(r.text); };
    // An untagged image with the Stack's label: what a rebuild leaves on engines that keep the old image.
    const ctx = join(root, "left");
    mkdirSync(ctx);
    writeFileSync(join(ctx, "Dockerfile"), "FROM busybox:1.36\nRUN echo left > /left\n");
    sh(ctx, "docker", "build", "-q", "--label", `com.docker.compose.project=${NAME}`, ".");
    const d = await read();
    assert.ok(d.engine.images.count > 0);
    assert.ok(d.images.length > 0, "the Stack's own images are listed");
    assert.equal(d.unused.length, 1);
    assert.ok(d.allUnused.count >= 1);
    assert.deepEqual(d.volumes.map((v) => v.name), [volume]);
    const said = await docker.cleanUp(null, { images: d.unused.map((u) => u.id) });
    assert.equal(said.length, 1);
    const after = await read();
    assert.deepEqual(after.unused, []);
    assert.deepEqual(after.volumes.map((v) => v.name), [volume]);
    assert.equal(after.images.length, d.images.length);
  } finally { spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" }); }
});

test("Down stops and removes the containers and keeps .dockr.env", opts, async () => {
  const op = await store.prepareStack(NAME, "down");
  assert.equal(run(op).status, 0);
  await look();
  assert.equal(row("web").container, null);
  assert.equal(row("web").set.branch, "feat"); // The record survives: the next Up starts from it.
});
