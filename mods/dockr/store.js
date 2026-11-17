// What Dockr knows and what each action does, with no drawing. The panel asks this for rows and
// for the script of an action, then starts the script in a terminal.
import { appHome, readTextFile } from "herdr";
import * as model from "./model.js";
import * as docker from "./docker.js";

const QUIET_MS = 30000;
const HEADER = "# Written by Dockr: the checkout each Service runs from.\n";

export class Store {
  /** `saved`: the build records kept from last time. `save(built)`: keeps them. */
  constructor(saved = {}, save = () => {}) {
    this.stacks = [];          // configured Stacks, Main checkouts filled in
    this.problems = [];        // config problems
    this.env = {};             // stack name -> the variables .dockr.env sets
    this.has = {};             // stack name -> which env files exist
    this.sources = {};         // "stack/service" -> checkouts
    this.hosts = null;         // the hosts file's text
    this.byMachine = {};       // machine ("" for this computer) -> containers
    this.errors = {};          // machine -> why Docker could not be read there
    this.prev = null;          // the containers at the last look, for toasts
    this.quiet = {};           // container name -> when the user last acted on it
    this.exits = {};           // container name -> { finishedAt, restarts, times }: its exits, for restart loops
    this.loops = new Set();    // container names in a restart loop at the last look
    this.stale = {};           // "stack/service" -> true: its checkout's manifests differ from its image
    this.imageHashes = {};     // "image id|manifests" -> the manifests' hash inside that image
    this.tails = {};           // container id -> { key, lines }: the last lines of one that is not well
    this.pendingBuilt = {};    // "stack/service" -> { path, at }: a build of an unmounted Service under way
    this.built = saved;
    this.save = save;
  }

  machines() {
    const list = [...new Set(this.stacks.map((s) => s.machine ?? ""))];
    return list.length ? list : [""];
  }

  stack(name) { return this.stacks.find((s) => s.name === name) ?? null; }

  /** dockr.json and wranglr.json. Read at start, when the panel shows and before every action. */
  async loadConfig() {
    const read = (name) => readTextFile(`${appHome()}/${name}`).catch(() => null);
    const [text, wranglrText] = await Promise.all([read("dockr.json"), read("wranglr.json")]);
    let wranglr = null;
    try { wranglr = wranglrText ? JSON.parse(wranglrText) : null; } catch {}
    const parsed = model.parseConfig(text);
    const filled = model.withMains(parsed.stacks, wranglr);
    this.stacks = filled.stacks;
    this.problems = [...parsed.problems, ...filled.problems];
  }

  /** A Stack's env file state and each Service's checkouts. Returns .dockr.env's text, or null. */
  async loadStack(stack) {
    const m = stack.machine;
    const [has, text] = await Promise.all([docker.envFiles(m, stack), docker.readDockrEnv(m, stack)]);
    this.has[stack.name] = has;
    this.env[stack.name] = model.parseEnv(text);
    await Promise.all(Object.entries(stack.services).map(async ([name, service]) => {
      if (service.main) this.sources[`${stack.name}/${name}`] = await docker.worktrees(m, service.main);
    }));
    return text;
  }

  /** Everything again. Returns the toasts the change of containers earns. */
  async reload() {
    await this.loadConfig();
    const machines = this.machines();
    for (const m of Object.keys(this.byMachine)) if (!machines.includes(m)) delete this.byMachine[m];
    const looks = await Promise.all([
      Promise.all(machines.map((m) => this.look(m))),
      ...this.stacks.map((s) => this.loadStack(s)),
      docker.hostsFile().then((t) => { this.hosts = t; }),
    ]);
    return looks[0].flat();
  }

  containers() {
    const seen = new Set(), out = [];
    for (const list of Object.values(this.byMachine)) for (const c of list) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reads every container on a Machine. Returns the toasts the change earns. */
  async look(machine) {
    const r = await docker.snapshot(machine || null);
    if (r.error) this.errors[machine] = r.error; else delete this.errors[machine];
    this.byMachine[machine] = r.containers;
    const next = this.containers();
    this.recordBuilds(next);
    const now = Date.now();
    const quiet = new Set(Object.keys(this.quiet).filter((n) => now - this.quiet[n] < QUIET_MS));
    const names = new Set(next.map((c) => c.name));
    for (const n of Object.keys(this.exits)) if (!names.has(n)) delete this.exits[n];
    for (const c of next) this.exits[c.name] = model.noteExits(this.exits[c.name], c);
    const loops = new Set(next.filter((c) => this.looping(c, now)).map((c) => c.name));
    const out = model.toasts(this.prev, next, this.stacks.map((s) => s.name), quiet, loops, this.loops);
    this.loops = loops;
    this.prev = next;
    await this.readTails(machine, r.containers);
    return out;
  }

  /**
   * Marks each mounted Service whose checkout's dependency manifests differ from its image, so it
   * needs a rebuild. An image is looked into once, then remembered by its id.
   */
  async checkStale() {
    const stale = {};
    await Promise.all(this.view().groups.flatMap((g) => g.rows.map(async (r) => {
      if (!r.service || !r.container || !r.mounted || !r.actual) return;
      const m = g.stack.machine, files = r.service.manifests;
      const key = `${r.container.imageId}|${files.join("|")}`;
      if (!(key in this.imageHashes)) {
        const h = await docker.imageHash(m, r.container.imageId, files);
        if (h) this.imageHashes[key] = h; else return;
      }
      const host = await docker.sourceHash(m, r.actual.path, files);
      if (host && host !== this.imageHashes[key]) stale[r.key] = true;
    })));
    this.stale = stale;
  }

  /** The Machine a container was read from, null for this computer. */
  machineOf(c) {
    for (const [m, list] of Object.entries(this.byMachine)) if (list.some((x) => x.id === c.id)) return m || null;
    return null;
  }

  looping(c, now = Date.now()) { return !!c && model.looping(this.exits[c.name]?.times, now); }

  /** What a row says about its container, restart loops included. */
  status(c) { return model.statusOf(c, this.looping(c)); }

  /** Reads the last lines of each container that is not well, once per failure. */
  async readTails(machine, containers) {
    const ids = new Set(containers.map((c) => c.id));
    for (const id of Object.keys(this.tails)) if (!ids.has(id) && this.tails[id].machine === machine) delete this.tails[id];
    await Promise.all(containers.map(async (c) => {
      if (!model.why(c) && !this.looping(c)) { delete this.tails[c.id]; return; }
      const key = `${c.finishedAt}/${c.health}/${c.restarts}`;
      if (this.tails[c.id]?.key === key) return;
      this.tails[c.id] = { key, machine, lines: await docker.lastLines(machine || null, c.id, 20) };
    }));
  }

  /** The last lines of a container that is not well. Empty for one that is. */
  tail(c) { return (c && this.tails[c.id]?.lines) || []; }

  /** A build of an unmounted Service has made a new container: remember which Source its image came from. */
  recordBuilds(containers) {
    let changed = false;
    for (const [key, p] of Object.entries(this.pendingBuilt)) {
      const [stack, service] = key.split("/");
      const c = containers.find((x) => x.project === stack && x.service === service);
      if (!c || !(Date.parse(c.created) >= p.at - 5000)) continue;
      this.built[key] = { imageId: c.imageId, path: p.path };
      delete this.pendingBuilt[key];
      changed = true;
    }
    if (changed) this.save(this.built);
  }

  view() {
    const recorded = Object.fromEntries(this.stacks.map((s) => [s.name, this.has[s.name]?.dockr !== false]));
    return model.view(this.stacks, this.containers(), this.env, this.sources, this.built, recorded);
  }

  rows(name) { return this.view().groups.find((g) => g.stack.name === name)?.rows ?? []; }
  hush(rows) { for (const r of rows) if (r.container) this.quiet[r.container.name] = Date.now(); }

  /** A terminal's labels and script for a build or bring-up. */
  op(stack, title, verb, services, build, lines) {
    return {
      stack, title,
      labels: { kind: "op", verb, title, services: services.join(","), build: build.join(","), at: String(Date.now()) },
      script: docker.opScript(lines),
    };
  }

  /**
   * Sets each Service in `targets` ({ service: checkout }) to its checkout and says how to bring up
   * the ones that run (or all of them with `start`). An image is rebuilt only where the new Source's
   * dependencies differ. Returns { error }, { note } when nothing needs to run, or an op with
   * `note` and `undo` ({ stack, targets } that puts the old Sources back).
   */
  /** `checkout` ({ main, branch }): the Main checkout is first put on that branch, for a branch with no worktree. */
  async prepareSwitch(name, targets, start, title, checkout = null) {
    try {
      await this.loadConfig();
      const stack = this.stack(name);
      if (!stack) return { error: `${name} is no longer in dockr.json.` };
      let was = null;
      if (checkout) {
        was = (await docker.worktrees(stack.machine, checkout.main)).find((s) => s.main)?.branch ?? null;
        const refused = await docker.checkout(stack.machine, checkout.main, checkout.branch);
        if (refused) return { error: `${title}: ${refused}` };
      }
      const text = await this.loadStack(stack);
      const before = this.rows(name);
      const plan = model.planSwitch(stack, this.env[name], targets);
      // The first write also records the Services already on a worktree, so they do not turn into Drift.
      const changes = this.has[name].dockr ? plan.changes : { ...model.adoptChanges(before, targets), ...plan.changes };
      const undo = { stack: name, targets: Object.fromEntries(before.filter((r) => plan.services.includes(r.name) && r.set && !r.set.missing).map((r) => [r.name, r.set])) };
      if (checkout && was && was !== checkout.branch) undo.checkout = { main: checkout.main, branch: was };
      if (Object.keys(changes).length) {
        await docker.writeDockrEnv(stack.machine, stack, model.setEnv(text ?? HEADER, changes));
        await this.loadStack(stack);
      }
      const rows = this.rows(name).filter((r) => r.service && targets[r.name]);
      const bring = rows.filter((r) => start || r.container?.state === "running");
      if (!bring.length) return { note: `${title}: set. Nothing was running, so nothing was started.`, undo };
      const build = [];
      for (const r of bring) {
        const target = targets[r.name];
        // Already there. After a checkout the path is the same and the files are not, so the image is checked.
        if (!checkout && r.container && r.actual && model.norm(r.actual.path) === model.norm(target.path)) continue;
        const [hostHash, imageHash] = r.mounted
          ? await Promise.all([docker.sourceHash(stack.machine, target.path, r.service.manifests), docker.imageHash(stack.machine, r.container.image, r.service.manifests)])
          : [null, null];
        if (!model.needsBuild({ mounted: r.mounted, hostHash, imageHash })) continue;
        build.push(r.name);
        if (!r.mounted) this.pendingBuilt[r.key] = { path: target.path, at: Date.now() };
      }
      const has = this.has[name], names = bring.map((r) => r.name);
      const lines = [];
      if (build.length) lines.push(docker.composeLine(stack, has, ["build", ...build]));
      lines.push(docker.composeLine(stack, has, ["up", "-d", ...names]));
      this.hush(bring);
      return { ...this.op(stack, title, "switch", names, build, lines), undo, note: build.length ? `${title}: rebuilding ${build.join(", ")}.` : `${title}: recreating, no rebuild needed.` };
    } catch (e) {
      return { error: `${title}: ${model.explain(e?.message ?? e)}` };
    }
  }

  /** Start, stop or restart one Service, run to its end. `args`: the compose words before its name. Returns an error or null. */
  async quick(row, args) {
    await this.loadConfig();
    const stack = this.stack(row.stack);
    if (!stack) return `${row.stack} is no longer in dockr.json.`;
    this.has[stack.name] = await docker.envFiles(stack.machine, stack);
    this.hush([row]);
    const error = await docker.compose(stack.machine, stack, this.has[stack.name], [...args, row.name]);
    await this.look(stack.machine ?? "");
    return error ? `${args[0]} ${row.name}: ${error}` : null;
  }

  /** Start, stop or restart containers that are in no configured Stack, by name. Returns an error line or null. */
  async plain(verb, containers) {
    if (!containers.length) return null;
    const machine = this.machineOf(containers[0]);
    for (const c of containers) this.quiet[c.name] = Date.now();
    const error = await docker.plain(machine, verb, containers.map((c) => c.name));
    await this.look(machine ?? "");
    return error ? `${verb}: ${error}` : null;
  }

  /** Stop every Service of a Stack, keeping its containers. Returns an error line or null. */
  async stopStack(name) {
    await this.loadConfig();
    const stack = this.stack(name);
    if (!stack) return `${name} is no longer in dockr.json.`;
    this.has[name] = await docker.envFiles(stack.machine, stack);
    this.hush(this.rows(name));
    const error = await docker.compose(stack.machine, stack, this.has[name], ["stop"]);
    await this.look(stack.machine ?? "");
    return error ? `stop ${name}: ${error}` : null;
  }

  /** A terminal inside a container that is in no configured Stack. */
  prepareShell(row) {
    const title = `Terminal · ${row.name}`;
    return { stack: { name: "-", machine: this.machineOf(row.container), dir: "/" }, title, labels: { kind: "shell", service: row.name, title },
      script: `docker exec -it ${model.q(row.container.name)} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'` };
  }

  /** Rebuild one Service from the Source it is set to. */
  async prepareRebuild(row) {
    await this.loadConfig();
    const stack = this.stack(row.stack);
    if (!stack) return { error: `${row.stack} is no longer in dockr.json.` };
    this.has[stack.name] = await docker.envFiles(stack.machine, stack);
    if (!row.mounted && row.set) this.pendingBuilt[row.key] = { path: row.set.path, at: Date.now() };
    this.hush([row]);
    return this.op(stack, `Rebuild ${row.name}`, "switch", [row.name], [row.name], [docker.composeLine(stack, this.has[stack.name], ["up", "-d", "--build", row.name])]);
  }

  /** Stack up or down. Down never removes volumes. */
  async prepareStack(name, verb) {
    await this.loadConfig();
    const stack = this.stack(name);
    if (!stack) return { error: `${name} is no longer in dockr.json.` };
    this.has[name] = await docker.envFiles(stack.machine, stack);
    const rows = this.rows(name);
    this.hush(rows);
    return this.op(stack, `${verb === "up" ? "Up" : "Down"} ${name}`, verb, rows.map((r) => r.name), [], [docker.composeLine(stack, this.has[name], verb === "up" ? ["up", "-d"] : ["down"])]);
  }

  /** The log tail or the shell of one Service. */
  async prepareTail(row, kind) {
    await this.loadConfig();
    const stack = this.stack(row.stack);
    if (!stack) return { error: `${row.stack} is no longer in dockr.json.` };
    this.has[stack.name] = await docker.envFiles(stack.machine, stack);
    const title = `${kind === "logs" ? "Logs" : "Terminal"} · ${row.name}`;
    const script = kind === "logs"
      ? docker.composeLine(stack, this.has[stack.name], ["logs", "-f", "--tail", "200", row.name])
      : `docker exec -it ${model.q(row.container.name)} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
    return { stack, title, labels: { kind, service: row.name, title }, script };
  }

  /**
   * What switching one Service to each of its checkouts costs: { path: "current" | "recreate" | "rebuild" }.
   * One look inside the image, one hash per checkout.
   */
  async costs(stack, row) {
    const out = {};
    const imageHash = row.mounted && row.image ? await docker.imageHash(stack.machine, row.image, row.manifests) : null;
    await Promise.all(row.sources.map(async (s) => {
      const current = !!row.runs && model.norm(row.runs) === model.norm(s.path);
      const hostHash = current || !row.mounted ? null : await docker.sourceHash(stack.machine, s.path, row.manifests);
      out[s.path] = model.costOf({ current, mounted: row.mounted, hostHash, imageHash });
    }));
    return out;
  }
}
