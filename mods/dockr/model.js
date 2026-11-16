// Dockr's decisions, with no Herdr or Docker calls: what the config means, which Source a
// container runs from, what a Switch changes, when it rebuilds, and which toasts an event earns.

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DEFAULT_MANIFESTS = ["package.json", "package-lock.json"];

/** One comparable form of a path: forward slashes, no trailing slash, a Windows drive as /mnt/<d>. */
export function norm(p) {
  let s = String(p ?? "").trim().replace(/\\/g, "/");
  const m = /^\/run\/desktop\/mnt\/host\/([a-z])(\/.*)?$/i.exec(s) || /^([A-Za-z]):(\/.*)?$/.exec(s) || /^\/mnt\/([a-z])(\/.*)?$/i.exec(s);
  // Windows drives ignore case, so everything under one compares in lower case.
  if (m) s = `/mnt/${m[1].toLowerCase()}${(m[2] ?? "").toLowerCase()}`;
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

export const dirname = (p) => String(p).replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || "/";
const inside = (path, dir) => path === dir || path.startsWith(dir + "/");

/** { stacks, problems } from dockr.json's text. A null text is no config. Bad entries are dropped and named. */
export function parseConfig(text) {
  const problems = [], stacks = [];
  if (text == null || !String(text).trim()) return { stacks, problems };
  let json;
  try { json = JSON.parse(text); } catch (e) { return { stacks, problems: [`dockr.json is not valid JSON: ${e.message}`] }; }
  if (!Array.isArray(json?.stacks)) return { stacks, problems: ['dockr.json needs { "stacks": [...] }'] };
  const seen = new Set();
  json.stacks.forEach((s, i) => {
    const at = `stacks[${i}]`;
    if (!s || typeof s.name !== "string" || !s.name) return problems.push(`${at} needs a name (the compose project name)`);
    if (seen.has(s.name)) return problems.push(`${at}: "${s.name}" is listed twice`);
    if (typeof s.compose !== "string" || !s.compose) return problems.push(`${s.name}: needs "compose", the compose file's path`);
    if (!/^(\/|[A-Za-z]:[\\/])/.test(s.compose)) return problems.push(`${s.name}: "compose" must be an absolute path`);
    seen.add(s.name);
    const services = {};
    for (const [name, v] of Object.entries(s.services && typeof s.services === "object" ? s.services : {})) {
      if (!v || typeof v.var !== "string" || !VAR_RE.test(v.var)) { problems.push(`${s.name}.${name}: "var" must be a variable name`); continue; }
      const manifests = Array.isArray(v.manifests) && v.manifests.every((m) => typeof m === "string" && m && !m.startsWith("/") && !m.includes("..")) ? v.manifests : null;
      if (v.manifests != null && !manifests) problems.push(`${s.name}.${name}: "manifests" must be relative paths`);
      services[name] = { var: v.var, repo: typeof v.repo === "string" ? v.repo : null, main: typeof v.main === "string" && v.main ? v.main : null, manifests: manifests ?? DEFAULT_MANIFESTS };
    }
    const urls = [];
    for (const [url, v] of Object.entries(s.urls && typeof s.urls === "object" ? s.urls : {})) {
      // A label, or { label, service } to say which Service serves it.
      const o = v && typeof v === "object" ? v : { label: v };
      if (/^https?:\/\/[^\s"'<>]+$/.test(url)) urls.push({ url, label: String(o.label || url), service: typeof o.service === "string" && o.service ? o.service : null });
      else problems.push(`${s.name}: "${url}" is not an http or https URL`);
    }
    stacks.push({ name: s.name, machine: s.machine ? String(s.machine) : null, compose: s.compose, dir: dirname(s.compose), services, urls });
  });
  return { stacks, problems };
}

/** Where Wranglr's config says a Repo's Main checkout is on a Machine, or null. */
export function wranglrMain(wranglr, repo, machine) {
  if (!wranglr || !repo) return null;
  const mk = machine ?? "";
  for (const w of Array.isArray(wranglr.workspaces) ? wranglr.workspaces : []) {
    const p = w?.on?.[mk]?.paths?.[repo];
    if (typeof p === "string" && p) return p;
  }
  const p = wranglr.repos?.[repo]?.on?.[mk]?.path;
  return typeof p === "string" && p ? p : null;
}

/** The stacks with each Service's Main checkout filled in: its own `main`, else Wranglr's. */
export function withMains(stacks, wranglr) {
  const problems = [];
  const out = stacks.map((s) => {
    const services = {};
    for (const [name, v] of Object.entries(s.services)) {
      const main = v.main ?? wranglrMain(wranglr, v.repo, s.machine);
      if (!main) problems.push(`${s.name}.${name}: no Main checkout. Set "main", or list the Repo in wranglr.json.`);
      services[name] = { ...v, main };
    }
    return { ...s, services };
  });
  return { stacks: out, problems };
}

/** The checkouts in `git worktree list --porcelain`: the Main checkout first, then its worktrees. */
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text ?? "").split(/\r?\n\r?\n/)) {
    let path = null, branch = null, head = null, skip = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare" || line.startsWith("prunable")) skip = true;
    }
    if (path && !skip) out.push({ path, branch, head, main: out.length === 0 });
  }
  return out;
}

/** What a checkout is called in the panel: its branch, else a short commit. */
export const sourceName = (s) => (s ? s.branch ?? (s.head ? s.head.slice(0, 8) : "detached") : "unknown");

/** The variables an env file sets, as { NAME: value }. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** The env file's text after `changes` ({ NAME: value | null }, null removes). Other lines are kept. */
export function setEnv(text, changes) {
  const left = { ...changes };
  const lines = String(text ?? "").split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ""));
  const out = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !(m[1] in left)) { out.push(line); continue; }
    if (left[m[1]] != null) out.push(`${m[1]}=${left[m[1]]}`);
    delete left[m[1]];
  }
  for (const [k, v] of Object.entries(left)) if (v != null) out.push(`${k}=${v}`);
  return out.length ? out.join("\n") + "\n" : "";
}

/** The real bind sources Docker Desktop names in `docker ps --format '{{json .}}'` lines, as { id: paths }. */
export function desktopBinds(psText) {
  const out = {};
  for (const line of String(psText ?? "").split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row?.ID || typeof row.Labels !== "string") continue;
    // Labels are one comma-joined string, so a value ends where the next "key=" starts.
    const paths = [...row.Labels.matchAll(/desktop\.docker\.io\/binds\/\d+\/Source=(.*?)(?=,[A-Za-z0-9_.\/-]+=|$)/g)].map((m) => m[1]);
    if (paths.length) out[row.ID] = paths;
  }
  return out;
}

/**
 * Containers from `docker inspect` JSON, with only what Dockr shows.
 * `binds`: desktopBinds() of the same containers. Docker Desktop hides a WSL bind behind an opaque
 * mount path and names the real one in a label that only `docker ps` prints.
 */
export function parseContainers(json, binds = {}) {
  let list;
  try { list = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.map((c) => {
    const labels = c.Config?.Labels ?? {};
    const named = binds[c.Id] ?? [];
    const sources = named.length ? named : (c.Mounts ?? []).filter((m) => m.Type === "bind").map((m) => m.Source);
    const ports = [];
    for (const [key, hosts] of Object.entries(c.HostConfig?.PortBindings ?? {})) {
      for (const h of hosts ?? []) if (h?.HostPort) ports.push({ host: Number(h.HostPort), container: key });
    }
    ports.sort((a, b) => a.host - b.host);
    return {
      id: c.Id, name: String(c.Name ?? "").replace(/^\//, ""), image: c.Config?.Image ?? "", imageId: c.Image ?? "",
      state: c.State?.Status ?? "unknown", exitCode: c.State?.ExitCode ?? 0, health: c.State?.Health?.Status ?? null,
      created: c.Created ?? "", project: labels["com.docker.compose.project"] ?? null, service: labels["com.docker.compose.service"] ?? null,
      binds: sources, ports, command: [c.Path, ...(c.Args ?? [])].filter(Boolean).join(" "),
    };
  });
}

/** The checkout among `sources` that one of the container's bind mounts is in, or null. */
export function sourceOf(container, sources) {
  let best = null, len = -1;
  for (const s of sources ?? []) {
    const dir = norm(s.path);
    if (dir.length > len && (container?.binds ?? []).some((b) => inside(norm(b), dir))) { best = s; len = dir.length; }
  }
  return best;
}

/** The checkout a Stack is set to for one Service: the env file's path, else the Main checkout. */
export function setSource(service, env, sources) {
  const path = env?.[service.var];
  if (!path) return (sources ?? []).find((s) => s.main) ?? (service.main ? { path: service.main, branch: null, head: null, main: true } : null);
  return (sources ?? []).find((s) => norm(s.path) === norm(path)) ?? { path, branch: null, head: null, main: false, missing: true };
}

const up = (c) => !!c && c.state === "running" && (c.health == null || c.health === "healthy");

/**
 * The panel's groups: one per Stack, then the containers in no Stack.
 * `env`: { stack: vars }, `sources`: { "stack/service": checkouts }, `built`: { "stack/service": { imageId, path } }
 * for Services with no bind mount, whose Source only Dockr's own builds can tell.
 * `recorded`: { stack: false } for a Stack with no .dockr.env yet. There, what runs is taken as what
 * the Stack is set to, so a first look never shows Drift.
 */
export function view(stacks, containers, env = {}, sources = {}, built = {}, recorded = {}) {
  const groups = stacks.map((stack) => {
    const mine = containers.filter((c) => c.project === stack.name);
    const names = [...new Set([...mine.map((c) => c.service ?? c.name), ...Object.keys(stack.services)])];
    const rows = names.map((name) => {
      const container = mine.find((c) => (c.service ?? c.name) === name) ?? null;
      const service = stack.services[name] ?? null;
      const row = { key: `${stack.name}/${name}`, stack: stack.name, name, container, service, sources: [], actual: null, set: null, drift: false, mounted: false };
      if (!service) return row;
      row.sources = sources[row.key] ?? [];
      row.set = setSource(service, env[stack.name], row.sources);
      row.mounted = !!container && container.binds.length > 0 && !!sourceOf(container, row.sources);
      if (container) {
        row.actual = sourceOf(container, row.sources);
        const b = built[row.key];
        if (!row.actual && b && b.imageId === container.imageId) row.actual = row.sources.find((s) => norm(s.path) === norm(b.path)) ?? null;
      }
      if (recorded[stack.name] === false && row.actual) row.set = row.actual;
      row.drift = !!row.actual && !!row.set && norm(row.actual.path) !== norm(row.set.path);
      return row;
    });
    return { stack, rows, running: rows.filter((r) => r.container?.state === "running").length };
  });
  const known = new Set(stacks.map((s) => s.name));
  const other = containers.filter((c) => !c.project || !known.has(c.project))
    .map((c) => ({ key: `/${c.name}`, stack: null, name: c.name, container: c, service: null, sources: [], actual: null, set: null, drift: false, mounted: false }));
  return { groups, other };
}

/**
 * The other Services that can move with a Switch: those whose Repo has a worktree on the picked
 * checkout's branch. The Main checkout and a detached worktree bring none.
 */
export function siblings(stack, sources, name, source) {
  if (!source || source.main || !source.branch) return [];
  const out = [];
  for (const other of Object.keys(stack.services)) {
    if (other === name) continue;
    const match = (sources[`${stack.name}/${other}`] ?? []).find((s) => !s.main && s.branch === source.branch);
    if (match) out.push({ name: other, source: match });
  }
  return out;
}

/**
 * What a Switch changes. `targets`: { service: checkout }, the picked Service and any that move with it.
 * Returns { changes: { VAR: path | null }, services: the Services whose set Source changes }.
 */
export function planSwitch(stack, env, targets) {
  const changes = {}, services = [];
  for (const [name, target] of Object.entries(targets)) {
    const service = stack.services[name];
    if (!service || !target) continue;
    const want = target.main ? null : target.path;
    const have = env?.[service.var] || null;
    if ((want == null) === (have == null) && (want == null || norm(want) === norm(have))) continue;
    changes[service.var] = want;
    services.push(name);
  }
  return { changes, services };
}

/** Whether bringing a Service up from a Source must rebuild its image. */
export function needsBuild({ mounted, hostHash, imageHash }) {
  if (!mounted) return true; // Nothing is mounted, so the image is the only copy of the code.
  if (!hostHash || !imageHash) return true;
  return hostHash !== imageHash;
}

/** The compose arguments every Dockr command starts with. `has`: which env files exist. */
export function composeArgs(stack, has = { env: true, dockr: true }) {
  const args = ["compose", "-f", stack.compose];
  if (has.env) args.push("--env-file", `${stack.dir}/.env`);
  if (has.dockr) args.push("--env-file", `${stack.dir}/.dockr.env`);
  return args;
}

/** A word quoted for sh. */
export const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The toasts a change of containers earns. `prev` null (the first look) earns none.
 * `stacks`: names of configured Stacks. `quiet`: container names the user just acted on.
 */
export function toasts(prev, next, stacks, quiet = new Set()) {
  if (!prev) return [];
  const before = new Map(prev.map((c) => [c.name, c]));
  const out = [];
  for (const c of next) {
    if (!c.project || !stacks.includes(c.project) || quiet.has(c.name)) continue;
    const was = before.get(c.name) ?? null;
    const name = c.service ?? c.name;
    if (c.health === "unhealthy" && was?.health !== "unhealthy") out.push({ kind: "unhealthy", name, stack: c.project, title: `${name} is unhealthy`, level: "warning" });
    else if (c.state === "exited" && c.exitCode !== 0 && was && was.state !== "exited") out.push({ kind: "exited", name, stack: c.project, title: `${name} exited ${c.exitCode}`, level: "error" });
    else if (up(c) && !up(was)) out.push({ kind: "started", name, stack: c.project, title: `${name} started`, level: "success" });
  }
  return out;
}

/** The names a hosts file maps to this computer, without localhost itself. */
export function localHosts(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [ip, ...names] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (ip !== "127.0.0.1" && ip !== "::1") continue;
    for (const n of names) if (n && !/^localhost(\.localdomain)?$/i.test(n) && /^[A-Za-z0-9.-]+$/.test(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The host port a localhost URL points at, or null for any other host. */
export function localPort(url) {
  const m = /^(https?):\/\/(localhost|127\.0\.0\.1)(?::(\d+))?(?:[\/?#]|$)/i.exec(url);
  return m ? (m[3] ? Number(m[3]) : m[1].toLowerCase() === "https" ? 443 : 80) : null;
}

/**
 * A Stack's links, each under the Service that serves it: { byService: { name: links }, stack: links }.
 * A link goes to the Service its config entry names, else to the one publishing its localhost port,
 * else it stays with the Stack. Local host names the config does not list go to the Service publishing 443.
 */
export function stackUrls(stack, rows, hostsText) {
  const byService = {}, rest = [];
  const publishing = (port) => rows.find((r) => r.container?.ports.some((p) => p.host === port))?.name ?? null;
  const put = (name, link) => { (byService[name] ??= []).push(link); };
  for (const u of stack.urls) {
    const port = localPort(u.url);
    const name = (u.service && rows.some((r) => r.name === u.service) ? u.service : null) ?? (port == null ? null : publishing(port));
    if (name) put(name, u); else rest.push(u);
  }
  const has = new Set(stack.urls.map((u) => u.url.replace(/\/+$/, "")));
  const tls = rows.find((r) => r.container?.state === "running" && r.container.ports.some((p) => p.host === 443));
  if (tls) for (const n of localHosts(hostsText)) if (!has.has(`https://${n}`)) put(tls.name, { url: `https://${n}`, label: n, service: tls.name });
  return { byService, stack: rest };
}

/** The link for a published port. */
export const portUrl = (port) => (port === 443 ? "https://localhost" : port === 80 ? "http://localhost" : `http://localhost:${port}`);

/** The node showing `mod` in a layout tree is on screen: not hidden, and the active child of any stack above it. */
export function modShown(root, mod) {
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return null;
    const here = shown && !n.hidden;
    if (n.content?.mod === mod) return here;
    let found = null;
    for (const c of n.children ?? []) {
      const r = walk(c, here && (n.type !== "stack" || n.active === c.id));
      if (r === true) return true;
      if (r === false) found = false;
    }
    return found;
  };
  return walk(root, true) ?? true; // Not in the layout (a pane, a window): it is shown when it runs.
}

/**
 * The lines a Stack's first .dockr.env needs besides the Switch itself: every other Service that
 * runs from a worktree keeps it, so writing the file does not put them in Drift.
 */
export function adoptChanges(rows, targets) {
  const out = {};
  for (const r of rows) if (r.service && !(r.name in targets) && r.actual && !r.actual.main) out[r.service.var] = r.actual.path;
  return out;
}

/** What a row says about its container: { kind: "up" | "starting" | "bad" | "off", text }. Text is empty when all is well. */
export function statusOf(c) {
  if (!c) return { kind: "off", text: "not created" };
  if (c.health === "unhealthy") return { kind: "bad", text: "unhealthy" };
  if (c.state === "exited") return c.exitCode !== 0 ? { kind: "bad", text: `exited ${c.exitCode}` } : { kind: "off", text: "stopped" };
  if (c.state === "running") return c.health === "starting" ? { kind: "starting", text: "waiting for healthy" } : { kind: "up", text: "" };
  if (c.state === "restarting") return { kind: "starting", text: "restarting" };
  return { kind: "off", text: c.state };
}

/** The terminals Dockr started that still run, from Herdr's terminal list. */
export function parseOps(terms) {
  const list = (v) => String(v ?? "").split(",").filter(Boolean);
  return (terms ?? []).filter((t) => t?.state === "live" && t.labels?.["dockr.stack"]).map((t) => ({
    address: t.address, stack: t.labels["dockr.stack"], kind: t.labels["dockr.kind"] ?? "op", service: t.labels["dockr.service"] ?? null,
    services: list(t.labels["dockr.services"]), build: list(t.labels["dockr.build"]), verb: t.labels["dockr.verb"] ?? "switch",
    title: t.labels["dockr.title"] ?? "Dockr", at: Number(t.labels["dockr.at"]) || 0, failed: t.labels["dockr.failed"] ?? null,
  }));
}

/** The build or bring-up that is working on a Service, or null. Without a service: any in the Stack. */
export const opFor = (ops, stack, service) =>
  ops.find((o) => o.kind === "op" && o.stack === stack && (service == null || o.services.includes(service))) ?? null;

/** Where a Service is in a running build or bring-up: { text, failed? }, or null with none. */
export function phase(name, op, container) {
  if (!op) return null;
  if (op.failed != null) return { failed: true, text: `failed (exit ${op.failed})` };
  if (op.verb === "down") return { text: "stopping" };
  // A container made after the work began is the new one: the build is over.
  if (container && Date.parse(container.created) >= op.at - 2000) return { text: container.health === "starting" ? "waiting for healthy" : "starting" };
  return { text: op.build.includes(name) ? "building" : op.verb === "up" ? "starting" : "recreating" };
}

/** What switching to a checkout costs: "current", "recreate" (seconds) or "rebuild". */
export function costOf({ current, mounted, hostHash, imageHash }) {
  if (current) return "current";
  return needsBuild({ mounted, hostHash, imageHash }) ? "rebuild" : "recreate";
}

/** The worktree a Service could move to because it is on `branch` (the focused space's), or null. */
export function suggestion(row, branch) {
  if (!row.service || !branch) return null;
  const s = row.sources.find((x) => !x.main && x.branch === branch);
  return s && !(row.set && norm(row.set.path) === norm(s.path)) ? s : null;
}

/** A branch in a few characters: its ticket number, else its start. */
export function shortBranch(b) {
  const m = /^(?:[A-Za-z]+\/)?#?(\d{3,})/.exec(String(b ?? ""));
  return m ? m[1] : String(b ?? "").length > 14 ? `${String(b).slice(0, 13)}…` : String(b ?? "");
}

/** The shipped icon that fits a container's program, by its image and command. */
export function programIcon(c) {
  const text = `${c?.image ?? ""} ${c?.command ?? ""}`.toLowerCase();
  const rules = [[/nginx/, "nginx"], [/postgres/, "psql"], [/redis/, "redis-cli"], [/mongo/, "mongosh"], [/mysql|mariadb/, "mysql"],
    [/dotnet|aspnet/, "dotnet"], [/vite/, "vite"], [/\b(npm|node|yarn|pnpm)\b/, "node"], [/python|uvicorn|gunicorn/, "python"]];
  return `icons/${rules.find(([re]) => re.test(text))?.[1] ?? "docker"}.svg`;
}

/** A Docker or compose error in words that say what to do. Unknown ones keep their last line. */
export function explain(text, machine = null) {
  const s = String(text ?? ""), where = machine ? ` on ${machine}` : "";
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect|dockerDesktopLinuxEngine/i.test(s)) return `Docker is not running${where}. Start Docker Desktop, then press Reload.`;
  if (/port is already allocated|address already in use/i.test(s)) {
    const port = /(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|:::?):(\d+)/.exec(s)?.[1];
    return `Port ${port ?? "it needs"} is already in use. Stop what holds it, then try again.`;
  }
  if (/permission denied.*docker\.sock/i.test(s)) return `No permission to use Docker${where}. Add your user to the docker group.`;
  if (/program not found|command not found|executable file not found|cannot start (docker|bash|sh)\b/i.test(s)) return `Docker's command line was not found${where}.`;
  if (/no such service/i.test(s)) return "The compose file has no service by that name. Check dockr.json.";
  if (/no such file or directory/i.test(s) && /\.ya?ml|compose/i.test(s)) return "The compose file is not where dockr.json says it is.";
  if (/unreachable|not connected|no such machine/i.test(s)) return `Herdr cannot reach${machine ? ` ${machine}` : " that Machine"}. Connect it, then press Reload.`;
  return s.trim().split(/\r?\n/).pop() ?? "";
}
