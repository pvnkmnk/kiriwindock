// Everything Dockr asks of Docker, git and herdr-core. Each call runs on the Stack's Machine.
import { exec, hc, readTextFile, window as win } from "herdr";
import { clean, composeArgs, desktopBinds, explain, parseContainers, parseWorktrees, q } from "./model.js";

const on = (machine) => (machine ? { on: machine } : {});
const failed = (e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) });
const said = (r) => (r.stderr || r.stdout || `exited ${r.code}`).trim().split(/\r?\n/).pop();

// Only what Dockr uses. Environment entries are cut to their names inside Docker, so no value reaches Dockr.
const INSPECT = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Created":{{json .Created}},"Path":{{json .Path}},"Args":{{json .Args}},'
  + '"RestartCount":{{json .RestartCount}},"State":{{json .State}},"Mounts":{{json .Mounts}},"Networks":{{json .NetworkSettings.Networks}},'
  + '"HostConfig":{"PortBindings":{{json .HostConfig.PortBindings}}},'
  + '"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}},"Env":[{{range $i, $e := .Config.Env}}{{if $i}},{{end}}{{json (index (split $e "=") 0)}}{{end}}]}}';

/** The last `lines` lines a container wrote, oldest first. Empty when they cannot be read. */
export async function lastLines(machine, id, lines) {
  const r = await exec("sh", ["-c", 'docker logs --tail "$1" "$2" 2>&1', "dockr", String(lines), id], on(machine)).catch(failed);
  return r.code === 0 ? clean(r.stdout).split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-lines) : [];
}

/** Every container on that Machine's Docker: { containers, error? }. */
export async function snapshot(machine) {
  const ps = await exec("docker", ["ps", "-a", "--no-trunc", "--format", "{{json .}}"], on(machine)).catch(failed);
  if (ps.code !== 0) return { containers: [], error: explain(ps.stderr || ps.stdout, machine) };
  const list = ps.stdout.split(/\r?\n/).map((l) => { try { return JSON.parse(l).ID; } catch { return null; } }).filter(Boolean);
  if (!list.length) return { containers: [] };
  // A container removed between the two calls makes inspect exit 1 and still print the rest.
  const r = await exec("docker", ["inspect", "--format", INSPECT, ...list], on(machine)).catch(failed);
  const containers = parseContainers(r.stdout, desktopBinds(ps.stdout));
  return containers.length || r.code === 0 ? { containers } : { containers: [], error: `docker inspect: ${said(r)}` };
}

// $1: where to start from ("" for now), $2: the longest wait in seconds.
// Prints the last event of the burst that ended the wait, or an empty line when nothing happened.
const WAIT = `
set -- "$1" "$2" docker events --format '{{json .}}' --filter type=container --filter event=create --filter event=start --filter event=die --filter event=destroy --filter event=health_status --filter event=rename
since="$1"; max="$2"; shift 2
[ -n "$since" ] && set -- "$@" --since "$since"
coproc D { exec "$@" 2>/dev/null; }
last=""
if IFS= read -r -t "$max" line <&"\${D[0]}"; then
  last="$line"
  while IFS= read -r -t 0.7 line <&"\${D[0]}"; do last="$line"; done
fi
kill "$D_PID" 2>/dev/null
printf '%s\\n' "$last"
`;

/** A decimal string plus one. */
function plusOne(digits) {
  const d = digits.split("");
  for (let i = d.length - 1; i >= 0; i--) {
    if (d[i] !== "9") { d[i] = String(Number(d[i]) + 1); return d.join(""); }
    d[i] = "0";
  }
  return "1" + d.join("");
}

/**
 * Waits until a container is created, starts, stops, goes or changes health, at most ten minutes.
 * Resolves { event: true, since } after one (`since` continues from just after it), { event: false }
 * when nothing happened, or { error } when the wait could not run.
 */
export async function waitEvent(machine, since) {
  const r = await exec("bash", ["-c", WAIT, "dockr", since ?? "", "570"], { ...on(machine), timeout: 600000 }).catch(failed);
  if (r.code !== 0) return { error: said(r) };
  const nano = /"timeNano":(\d{10,})/.exec(r.stdout)?.[1];
  if (!nano) return { event: false };
  const next = plusOne(nano);
  return { event: true, since: `${next.slice(0, -9)}.${next.slice(-9)}` };
}

// $1: container name, $2: the timestamp to continue from ("" starts with a tail), $3: the longest
// wait in seconds, $4: how many lines the first call starts with. Prints the new lines with their
// timestamps as soon as some arrive (at most 0.4 s of them), then "\001ended" when the stream ended.
const LOGS = `
c="$1"; since="$2"; max="$3"; tail="$4"
set -- docker logs -f --timestamps
if [ -n "$since" ]; then set -- "$@" --since "$since"; else set -- "$@" --tail "$tail"; fi
coproc D { exec "$@" "$c" 2>&1; }
n=0
IFS= read -r -t "$max" line <&"\${D[0]}"; rc=$?
if [ $rc -eq 0 ]; then
  printf '%s\\n' "$line"; n=1; end=$(( \${EPOCHREALTIME//[.,]/} + 400000 ))
  while [ $n -lt 4000 ] && [ \${EPOCHREALTIME//[.,]/} -lt $end ]; do
    IFS= read -r -t 0.15 line <&"\${D[0]}"; rc=$?
    [ $rc -eq 0 ] || break
    printf '%s\\n' "$line"; n=$((n+1))
  done
fi
kill "$D_PID" 2>/dev/null
[ $rc -eq 1 ] && printf '\\001ended\\n'
exit 0
`;

/**
 * Waits for a container's next log lines, at most a minute. Resolves { text } with the new lines
 * (each starts with its timestamp, and a last line "\x01ended" says the container stopped writing),
 * or { error } when the wait could not run.
 */
export async function waitLogs(machine, name, since, tail = 300) {
  const r = await exec("bash", ["-c", LOGS, "dockr", name, since ?? "", "60", String(tail)], { ...on(machine), timeout: 90000 }).catch(failed);
  return r.code === 0 ? { text: r.stdout } : { error: said(r) };
}

/** Waits until a container of that name starts, at most ten minutes: { started } or { error }. */
export async function waitStart(machine, name) {
  const script = 'coproc D { exec docker events --filter type=container --filter event=start --filter "container=$1" --format x 2>/dev/null; }; IFS= read -r -t 570 l <&"${D[0]}" && echo started; kill "$D_PID" 2>/dev/null; exit 0';
  const r = await exec("bash", ["-c", script, "dockr", name], { ...on(machine), timeout: 600000 }).catch(failed);
  return r.code === 0 ? { started: r.stdout.includes("started") } : { error: said(r) };
}

// Prints one sample of every running container from Docker's stats stream. $1: the longest wait.
const STATS = `
coproc D { exec docker stats --format '{{.ID}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}' 2>/dev/null; }
out=""; seen=0
while IFS= read -r -t "$1" line <&"\${D[0]}"; do
  case "$line" in *$'\\033[H'*) [ $seen -eq 1 ] && [ -n "$out" ] && break; seen=1; out="" ;; esac
  out="$out$line"$'\\n'
done
kill "$D_PID" 2>/dev/null
printf '%s' "$out"
`;

/** One sample of CPU and memory for every running container: { text } or { error }. Takes about two seconds. */
export async function waitStats(machine) {
  const r = await exec("bash", ["-c", STATS, "dockr", "30"], { ...on(machine), timeout: 60000 }).catch(failed);
  return r.code === 0 ? { text: r.stdout } : { error: said(r) };
}

// $1: the compose project. Sections are separated by "---".
const DISK = `
docker system df --format '{{.Type}}|{{.TotalCount}}|{{.Size}}|{{.Reclaimable}}' || exit 1
echo ---
docker image ls --filter dangling=false --filter "label=com.docker.compose.project=$1" --format '{{.Repository}}:{{.Tag}}|{{.Size}}'
echo ---
docker image ls --filter dangling=true --filter "label=com.docker.compose.project=$1" --format '{{.ID}}|{{.Size}}|{{.CreatedSince}}'
echo ---
docker image ls --filter dangling=true --format '{{.ID}}|{{.Size}}'
echo ---
docker volume ls --filter "label=com.docker.compose.project=$1" --format '{{.Name}}'
echo ---
docker system df -v --format '{{range .Volumes}}{{.Name}}|{{.Size}}|{{.Links}}{{println}}{{end}}'
`;

/** What Docker's disk holds for a compose project and for the whole engine: { text } or { error }. Takes several seconds. */
export async function disk(machine, project) {
  const r = await exec("sh", ["-c", DISK, "dockr", project], { ...on(machine), timeout: 120000 }).catch(failed);
  return r.code === 0 ? { text: r.stdout } : { error: explain(r.stderr || r.stdout, machine) };
}

/**
 * Removes unused images and, when asked, unused build cache. Volumes are never touched.
 * `images`: ids to remove. `allUnused`: every untagged image no container uses. `cache`: unused build cache.
 * Resolves the lines that say what happened.
 */
export async function cleanUp(machine, { images = [], allUnused = false, cache = false }) {
  const said = [];
  const step = async (label, args) => {
    const r = await exec("docker", args, { ...on(machine), timeout: 600000 }).catch(failed);
    const text = (r.stderr || r.stdout).trim().split(/\r?\n/);
    const freed = text.find((l) => /reclaimed space/i.test(l));
    said.push(r.code === 0 ? `${label}: ${freed ?? "done"}` : `${label}: ${explain(r.stderr || r.stdout, machine)}`);
  };
  if (images.length) await step(`${images.length} unused image${images.length === 1 ? "" : "s"} of this Stack`, ["image", "rm", ...images]);
  if (allUnused) await step("Other unused images", ["image", "prune", "-f"]);
  if (cache) await step("Unused build cache", ["builder", "prune", "-f"]);
  return said;
}

/** A Repo's checkouts, the Main checkout first. Empty when git fails there. */
export async function worktrees(machine, main) {
  const r = await exec("git", ["-C", main, "worktree", "list", "--porcelain"], on(machine)).catch(failed);
  return r.code === 0 ? parseWorktrees(r.stdout) : [];
}

/** Which of the Stack's env files exist. Neither is opened. */
export async function envFiles(machine, stack) {
  const r = await exec("sh", ["-c", '[ -f "$1" ] && echo env; [ -f "$2" ] && echo dockr; true', "dockr", `${stack.dir}/.env`, `${stack.dir}/.dockr.env`], on(machine)).catch(failed);
  const has = r.stdout.split(/\s+/);
  return { env: has.includes("env"), dockr: has.includes("dockr") };
}

/** The text of the Stack's .dockr.env, or null when there is none. */
export const readDockrEnv = (machine, stack) => readTextFile(`${stack.dir}/.dockr.env`, on(machine)).catch(() => null);

// $1 the file, $2 the text: written beside it, then moved over it.
const WRITE = 'tmp="$1.dockr-$$" && printf %s "$2" > "$tmp" && mv -f "$tmp" "$1"';

/** Writes the Stack's .dockr.env. Throws with sh's own words on failure. */
export async function writeDockrEnv(machine, stack, text) {
  const r = await exec("sh", ["-c", WRITE, "dockr", `${stack.dir}/.dockr.env`, text], on(machine)).catch(failed);
  if (r.code !== 0) throw new Error(`could not write ${stack.dir}/.dockr.env: ${said(r)}`);
}

const HASH = 'cat "$@" 2>/dev/null | sha256sum | cut -d" " -f1';
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const hashOf = (r) => { const h = r.stdout.trim(); return r.code === 0 && /^[0-9a-f]{64}$/.test(h) && h !== EMPTY ? h : null; };

/** One hash of a checkout's dependency manifests, or null when it has none of them. */
export async function sourceHash(machine, dir, files) {
  return hashOf(await exec("sh", ["-c", `cd "$1" && shift && ${HASH}`, "dockr", dir, ...files], on(machine)).catch(failed));
}

/** The same hash of the manifests inside an image, read from its working directory. */
export async function imageHash(machine, image, files) {
  return hashOf(await exec("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", HASH, "dockr", ...files], { ...on(machine), timeout: 60000 }).catch(failed));
}

/** A short compose command (start, stop, restart) run to its end. Returns an error line or null. */
export async function compose(machine, stack, has, args) {
  const r = await exec("docker", [...composeArgs(stack, has), ...args], { ...on(machine), timeout: 180000 }).catch(failed);
  return r.code === 0 ? null : explain(r.stderr || r.stdout, stack.machine);
}

/**
 * A terminal script that runs `lines` in order. On failure it labels its own terminal `dockr.failed`
 * (so the panel can say so) and waits for Enter, so the output stays to be read.
 */
export function opScript(lines) {
  return `${lines.join(" && ")}; code=$?; if [ "$code" -ne 0 ]; then hc label "$HC_TERMINAL_ID" dockr.failed="$code" >/dev/null 2>&1; printf '\\nFailed with exit code %s. Press Enter to close.\\n' "$code"; read _; fi; exit "$code"`;
}

/** The words of a compose command for a terminal's script. */
export const composeLine = (stack, has, args) => ["docker", ...composeArgs(stack, has), ...args].map(q).join(" ");

/**
 * Starts `script` in a headless herdr-core terminal on the Machine, labelled for Dockr.
 * Returns { address } or { error }. The terminal keeps running with no pane.
 */
export async function terminal(machine, cwd, labels, script) {
  const args = ["run", "--bg", "--no-parent", "--outlive-parent"];
  for (const [k, v] of Object.entries(labels)) args.push("--label", `dockr.${k}=${v}`);
  args.push("--cwd", cwd);
  if (machine) args.push("--on", machine);
  const r = await hc([...args, "--json", "--", "sh", "-c", script]).catch(failed);
  if (r.code !== 0) return { error: said(r) };
  try {
    const address = String(JSON.parse(r.stdout).address);
    return { address: machine && !address.includes("/") ? `${machine}/${address}` : address };
  } catch { return { error: "herdr-core did not say which terminal it started" }; }
}

/** Ends a terminal Dockr started. */
export const kill = (address) => hc(["kill", address]).catch(() => null);

/** The hosts file of the computer the browser runs on. */
export const hostsFile = () => readTextFile(win()?.platform === "windows" ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hosts").catch(() => null);

/** Opens an http or https URL in the system browser. */
export function openUrl(url) {
  if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) return;
  const p = win()?.platform;
  // rundll32 gets the URL as one argument, so nothing in it reaches a shell.
  const [cmd, args] = p === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : p === "macos" ? ["open", [url]] : ["xdg-open", [url]];
  exec(cmd, args).catch(() => null);
}
