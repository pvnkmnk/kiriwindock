// Dockr: Docker containers in a side panel, grouped by Stack, with the Source each Service runs from.
// The config is ~/.config/herdr-app/dockr.json. Nothing here runs on a timer: container state comes
// from waiting on `docker events`, and files are read when the panel shows and before each action.
//
// Faces, chosen by props: the panel, the Source picker (a popup), the bar over a peeked terminal
// and the Diagnose dialog (diagnose.js).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, focused, layout, nextCommand, notify, openOverlay, panes, props, run, setShared, settings, shared, spaces, terminals, theme } from "herdr";
import * as model from "./model.js";
import * as docker from "./docker.js";
import { Store } from "./store.js";
import * as diagnose from "./diagnose.js";

const icon = (name) => `mods/dockr/icons/${name}.svg`;
const REQUEST = "dockr.request"; // the picker's ask, handed to the panel through shared state
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };
const idOf = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
const mainTag = (s) => (s?.main ? "  · Main checkout" : "");

export default class Dockr extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.peeked = props()?.peek ?? null;
    this.picking = props()?.picker ?? null;
    if (this.peeked) { this.handle.focus(); return; }
    if (this.picking) return this.initPicker(cx);
    this.diagnosing = props()?.diagnose ?? null;
    if (this.diagnosing) return diagnose.init(this, cx);

    this.store = new Store(load("built", {}), (built) => localStorage.setItem("built", JSON.stringify(built)));
    this.watching = new Set(); // machines with an event wait running
    this.watchErrors = {};     // machine -> why its wait stopped
    this.busy = {};            // row or stack key -> what a short action is doing to it
    this.note = "";            // the last action's outcome, shown until the next one
    this.undo = null;          // { stack, targets, label }: puts back what the last Switch changed
    this.open = null;          // the row showing its details
    this.hover = null;         // the row under the pointer
    this.pendingDown = null;   // the Stack a confirm dialog is asking about
    this.told = new Set();     // failed builds already announced
    this.folded = load("folded", { "": true });
    this.startStopped = localStorage.getItem("start") === "1";
    this.seenRequest = shared(REQUEST)?.n ?? 0;
    this.wasShown = model.modShown(layout(), "dockr");

    cx.spawn(async (cx) => { await this.reload(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "reload") await this.reload(cx);
        else if (c === "downConfirmed" && this.pendingDown) { const name = this.pendingDown; this.pendingDown = null; await this.runOp(cx, await this.store.prepareStack(name, "down")); }
        cx.notify();
      }
    });
  }

  // The panel: loading

  post(toasts) {
    if (model.modShown(layout(), "dockr")) return;
    for (const t of toasts) notify({ title: t.title, body: t.body ? `${t.stack}: ${t.body}` : t.stack, level: t.level, action: { name: "layout.show", args: { id: "dockr" } } });
  }

  async reload(cx) {
    this.post(await this.store.reload());
    for (const m of this.store.machines()) this.watch(cx, m);
    cx.notify();
  }

  /** One wait on Docker's events per Machine. It ends for good when the wait cannot run there. */
  watch(cx, machine) {
    if (this.watching.has(machine)) return;
    this.watching.add(machine);
    delete this.watchErrors[machine];
    cx.spawn(async (cx) => {
      let since = "";
      for (;;) {
        const r = await docker.waitEvent(machine || null, since);
        if (r.error) {
          this.watching.delete(machine);
          this.watchErrors[machine] = `Not watching Docker${machine ? ` on ${machine}` : ""}: ${model.explain(r.error, machine || null)} Reload tries again.`;
          cx.notify();
          return;
        }
        if (!r.event) continue;
        since = r.since;
        this.post(await this.store.look(machine));
        cx.notify();
      }
    });
  }

  // The panel: actions

  ops() { return model.parseOps(terminals()); }

  /** The branch of the pane the user is in, for suggesting a worktree. */
  branch() {
    const f = focused();
    return (f?.pane ? panes().find((p) => p.pane === f.pane)?.branch : null) ?? spaces().find((s) => s.active)?.branch ?? null;
  }

  peek(address, title, stop) {
    openOverlay({
      kind: "dialog", width: 0.85, height: 0.8,
      layout: { type: "column", children: [
        { type: "block", size: { px: 34 }, content: { mod: "dockr", props: { peek: { address, title, stop } } } },
        { type: "block", content: { terminal: address } },
      ] },
    });
  }

  /** Starts a prepared action's script in a background terminal. The row shows its progress. */
  async runOp(cx, p, show = false) {
    if (p.undo !== undefined) this.undo = Object.keys(p.undo.targets).length ? { ...p.undo, label: Object.values(p.undo.targets).map(model.sourceName).join(", ") } : null;
    if (p.error || !p.script) { this.note = p.error ?? p.note ?? ""; cx.notify(); return; }
    const r = await docker.terminal(p.stack.machine, p.stack.dir, { stack: p.stack.name, ...p.labels }, p.script);
    this.note = r.error ? `${p.title}: ${model.explain(r.error, p.stack.machine)}` : p.note ?? "";
    if (!r.error && show) this.peek(r.address, p.title, true);
    cx.notify();
  }

  async doSwitch(cx, name, targets, start, title) {
    const key = Object.keys(targets).length === 1 ? `${name}/${Object.keys(targets)[0]}` : name;
    if (this.busy[key]) return;
    this.busy[key] = "checking";
    cx.notify();
    try { await this.runOp(cx, await this.store.prepareSwitch(name, targets, start, title)); }
    finally { delete this.busy[key]; cx.notify(); }
  }

  async quick(cx, row, args, word) {
    if (this.busy[row.key]) return;
    this.busy[row.key] = word;
    this.undo = null;
    cx.notify();
    try { this.note = (await this.store.quick(row, args)) ?? ""; }
    finally { delete this.busy[row.key]; cx.notify(); }
  }

  async tail(cx, row, kind) {
    const live = this.ops().find((o) => o.stack === row.stack && o.kind === kind && o.service === row.name);
    if (live) return this.peek(live.address, live.title, true);
    await this.runOp(cx, await this.store.prepareTail(row, kind), true);
  }

  /** Opens the Diagnose dialog for a container that is not well, with the text an agent would get. */
  async openDiagnose(cx, r) {
    const c = r.container;
    if (!c) return;
    const stack = r.stack ? this.store.stack(r.stack) : null;
    const machine = stack ? stack.machine ?? null : this.store.machineOf(c);
    const lines = await docker.lastLines(machine, c.id, 100);
    const src = r.actual ?? r.set ?? null;
    openOverlay({
      mod: "dockr", kind: "dialog", width: 720, height: 560,
      props: { diagnose: {
        service: r.name, machine, folder: src?.path ?? stack?.dir ?? null, branch: src?.branch ?? null,
        why: model.why(c) || this.store.status(c).text,
        brief: model.brief({ stack, row: r, container: c, lines, loop: this.store.looping(c) }),
      } },
    });
    cx.notify();
  }

  askDown(name) {
    this.pendingDown = name;
    openOverlay({ mod: "confirm", kind: "dialog", width: 380, props: { title: `Stop and remove the ${name} containers?`, detail: "Volumes are kept, so the database stays.", command: { name: "dockr.downConfirmed", args: {} } } });
  }

  /** Opens the Source picker at the pointer, with what it needs to work on its own. */
  async openPicker(cx, r) {
    const stack = this.store.stack(r.stack);
    if (!stack) return;
    await this.store.loadStack(stack); // Worktrees come and go: read them as the list opens.
    const row = this.store.rows(r.stack).find((x) => x.name === r.name) ?? r;
    const others = {};
    for (const s of row.sources) { const o = model.siblings(stack, this.store.sources, row.name, s); if (o.length) others[s.path] = o; }
    openOverlay({
      mod: "dockr", kind: "popup", width: 420, height: Math.min(520, 176 + Math.max(row.sources.length, 1) * 28),
      props: { picker: {
        stack: { name: stack.name, machine: stack.machine }, others, start: this.startStopped,
        row: { name: row.name, sources: row.sources, set: row.set?.path ?? null, runs: row.actual?.path ?? null, drift: row.drift, mounted: row.mounted,
          image: row.container?.image ?? null, manifests: row.service.manifests, running: row.container?.state === "running" },
      } },
    });
    cx.notify();
  }

  /** The picker asked for something. Shared state carries the ask, since the popup closes itself. */
  takeRequest(cx) {
    const req = shared(REQUEST);
    if (!req?.n || req.n === this.seenRequest) return;
    this.seenRequest = req.n;
    this.startStopped = !!req.start;
    localStorage.setItem("start", this.startStopped ? "1" : "0");
    cx.spawn(async (cx) => {
      if (req.kind === "rebuild") {
        const row = this.store.rows(req.stack).find((r) => r.name === req.service);
        if (row) await this.runOp(cx, await this.store.prepareRebuild(row));
      } else await this.doSwitch(cx, req.stack, req.targets, req.start, req.title);
    });
  }

  /** A build that failed while nobody watched gets one toast, which opens its output. */
  announce(ops) {
    for (const o of ops) {
      if (o.failed == null || this.told.has(o.address)) continue;
      this.told.add(o.address);
      notify({ title: `${o.title} failed`, body: "Click to see the output.", level: "error", action: { name: "terminal.peek", args: { terminal: o.address } } });
    }
  }

  // Drawing: shared pieces

  button(t, id, label, onClick, o = {}) {
    return h_flex().id(id).h(24).px(9).flex_none().items_center().rounded(6).text_size(11.5)
      .border_1().border_color(o.primary ? t.accent : t.border).bg(o.primary ? t.accent : t.raised)
      .text_color(o.primary ? t.accent_foreground : o.dim ? t.dim : t.foreground).cursor_pointer().hover((s) => s.opacity(0.85))
      .when(!!o.tip, (el) => el.tooltip(o.tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.spawn(async (cx) => { await onClick(cx); cx.notify(); }); })
      .child(label);
  }

  iconButton(t, id, name, tip, onClick, color) {
    return h_flex().id(id).w(22).h(22).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(color ?? t.muted).hover((s) => s.bg(t.selected)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.spawn(async (cx) => { await onClick(cx); cx.notify(); }); })
      .child(svg(icon(name)).size(13));
  }

  check(t, id, on, label, toggle) {
    return h_flex().id(id).h(22).gap(6).items_center().cursor_pointer().text_size(11.5).text_color(t.muted)
      .on_click((_e, cx) => { toggle(); cx.notify(); })
      .child(h_flex().w(13).h(13).flex_none().items_center().justify_center().rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
        .when(on, (el) => el.child(svg(icon("check")).size(10).text_color(t.accent_foreground))))
      .child(div().min_w(0).truncate().child(label));
  }

  statusColor(t, kind) { return kind === "up" ? t.ansi2 : kind === "starting" ? t.ansi3 : kind === "bad" ? t.ansi1 : t.dim; }

  /** A solid dot when up, a turning ring while starting, red when wrong, hollow when off. */
  status(t, st, working) {
    const box = h_flex().w(12).h(12).flex_none().items_center().justify_center();
    if (working || st.kind === "starting") return box.child(svg(icon("spinner")).size(11).text_color(working ? t.working : t.ansi3).spin(900));
    if (st.kind === "off") return box.child(div().w(8).h(8).rounded(4).border_1().border_color(t.dim));
    return box.child(div().w(8).h(8).rounded(4).bg(this.statusColor(t, st.kind)));
  }

  links(t, id, urls) {
    return h_flex().w_full().gap(4).flex_wrap().children(urls.map((u, i) =>
      div().id(`url-${id}-${i}`).px(6).h(18).rounded(4).text_size(10.5).bg(t.raised).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(u.url).on_click(() => docker.openUrl(u.url)).child(u.label)));
  }

  // Drawing: the panel

  renderRow(t, r, urls, ops, branch) {
    const c = r.container, id = idOf(r.key), open = this.open === r.key, managed = !!r.stack;
    const st = this.store.status(c), running = c?.state === "running";
    const cause = st.kind === "bad" ? model.why(c) || st.text : "";
    const op = managed ? model.opFor(ops, r.stack, r.name) : null;
    const ph = model.phase(r.name, op, c);
    const busy = this.busy[r.key] ?? (ph && !ph.failed ? ph.text : null);
    const hovered = this.hover === r.key && managed && !busy;
    const hint = model.suggestion(r, branch);
    const shownSource = r.service ? (c ? r.actual : r.set) : null;
    const gone = !!r.set?.missing;

    const head = h_flex().id(`row-${id}`).w_full().h(30).pl(10).pr(6).gap(7).items_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(open, (el) => el.bg(t.raised))
      .on_hover((h, cx) => { if (h) this.hover = r.key; else if (this.hover === r.key) this.hover = null; cx.notify(); })
      .on_click((_e, cx) => { this.open = open ? null : r.key; cx.notify(); })
      .child(this.status(t, st, !!busy))
      .child(svg(model.programIcon(c)).size(17).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(130).truncate().text_color(c ? t.foreground : t.muted).child(r.name));

    if (r.service) {
      head.child(h_flex().id(`src-${id}`).min_w(0).h(20).px(5).gap(4).items_center().rounded(4).cursor_pointer()
        .text_color(gone ? t.ansi1 : r.drift ? t.ansi3 : t.muted).hover((s) => s.bg(t.selected))
        .tooltip(gone ? `${r.set.path} is no longer a worktree. Click to pick another.` : `${shownSource?.path ?? "Built outside Dockr, so its Source is not known."}\nClick to change.`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.openPicker(cx, r); }); })
        .child(svg(icon("branch")).size(11).flex_none())
        .child(div().min_w(0).truncate().child(gone ? "worktree is gone" : c && !r.actual ? "unknown" : model.sourceName(shownSource))));
      if (r.drift) {
        head.child(div().id(`drift-${id}`).flex_none().px(5).h(16).rounded(3).text_size(10).bg(t.ansi3).text_color(t.background).cursor_pointer()
          .tooltip(`Runs from ${model.sourceName(r.actual)}, set to ${model.sourceName(r.set)}. Click to bring it back to ${model.sourceName(r.set)}.`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.doSwitch(cx, r.stack, { [r.name]: r.set }, false, `Apply ${r.name}`); }); })
          .child("drift"));
      } else if (hint && !busy) {
        head.child(div().id(`hint-${id}`).flex_none().px(5).h(16).rounded(3).text_size(10).border_1().border_color(t.accent).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.selected))
          .tooltip(`This space is on ${hint.branch}, and ${r.name} has a worktree there. Click to switch.`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.doSwitch(cx, r.stack, { [r.name]: hint }, this.startStopped, `Switch ${r.name} to ${hint.branch}`); }); })
          .child(`Use ${model.shortBranch(hint.branch)}?`));
      }
    }
    head.child(div().flex_1().min_w(0));

    if (ph?.failed) {
      head.child(div().id(`failed-${id}`).flex_none().px(6).h(18).rounded(4).text_size(10.5).bg(t.ansi1).text_color(t.background).cursor_pointer()
        .tooltip("Click to see the output. Dismiss it there to clear this.")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.peek(op.address, op.title, true)).child(ph.text));
    } else if (hovered) {
      const acts = h_flex().flex_none().gap(1).items_center();
      if (running) acts.child(this.iconButton(t, `stop-${id}`, "stop", "Stop", (cx) => this.quick(cx, r, ["stop"], "stopping")));
      else acts.child(this.iconButton(t, `start-${id}`, "play", c ? "Start" : "Create and start", (cx) => this.quick(cx, r, c ? ["start"] : ["up", "-d"], "starting")));
      if (running) acts.child(this.iconButton(t, `restart-${id}`, "restart", "Restart", (cx) => this.quick(cx, r, ["restart"], "restarting")));
      if (r.service) acts.child(this.iconButton(t, `rebuild-${id}`, "rebuild", "Rebuild the image from the Source it is set to", async (cx) => this.runOp(cx, await this.store.prepareRebuild(r))));
      if (c) acts.child(this.iconButton(t, `logs-${id}`, "logs", "Logs", (cx) => this.tail(cx, r, "logs")));
      if (running) acts.child(this.iconButton(t, `shell-${id}`, "shell", "Shell", (cx) => this.tail(cx, r, "shell")));
      head.child(acts);
    } else if (busy) {
      head.child(h_flex().flex_none().gap(2).items_center()
        .child(div().text_size(11).text_color(t.working).child(busy))
        .when(!!op, (el) => el.child(this.iconButton(t, `out-${id}`, "output", "Show the output", () => this.peek(op.address, op.title, true)))));
    } else if (st.text) {
      head.child(div().flex_none().pr(4).text_size(11).text_color(st.kind === "bad" ? t.ansi1 : t.dim).child(st.text));
    }

    if (!open && !urls.length && !cause) return head;
    return v_flex().w_full().child(head)
      .when(!!cause, (el) => el.child(this.renderFailure(t, r, cause).when(open, (x) => x.bg(t.raised))))
      .when(urls.length > 0, (el) => el.child(this.links(t, id, urls).pl(49).pr(10).pb(4).when(open, (x) => x.bg(t.raised))))
      .when(open, (el) => el.child(this.renderDetail(t, r)));
  }

  /** Under a row whose container is not well: why, its last lines, and what to do about it. */
  renderFailure(t, r, cause) {
    const id = idOf(r.key), lines = this.store.tail(r.container).slice(-3);
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().w_full().pl(49).pr(10).pb(5).gap(3)
      .when(cause !== this.store.status(r.container).text, (el) => el.child(div().w_full().text_size(11).text_color(t.ansi1).truncate().tooltip(cause).child(cause)))
      .when(lines.length > 0, (el) => el.child(v_flex().w_full().px(6).py(3).rounded(4).bg(t.surface).font_family(mono).text_size(10.5).text_color(t.muted)
        .children(lines.map((l) => div().w_full().truncate().tooltip(l).child(l)))))
      .child(h_flex().w_full().gap(5)
        .child(this.button(t, `diag-${id}`, "Diagnose", (cx) => this.openDiagnose(cx, r), { tip: "Show what an agent would be told about this failure, then send it" }))
        .child(this.button(t, `faillogs-${id}`, "Logs", (cx) => this.tail(cx, r, "logs"), { dim: true })));
  }

  /** What the row has no room for. Actions are on the row itself. */
  renderDetail(t, r) {
    const c = r.container, id = idOf(r.key);
    const line = (label, value, color) => h_flex().gap(6).text_size(11)
      .child(div().w(58).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().tooltip(value).text_color(color ?? t.muted).child(value));
    const out = v_flex().w_full().pl(49).pr(10).pb(8).pt(2).gap(4).bg(t.raised);
    if (c) out.child(line("Image", c.image));
    if (c) out.child(line("State", `${c.health ? `${c.state} · ${c.health}` : c.state}${c.restarts ? ` · ${c.restarts} restarts` : ""}`));
    if (c?.healthOutput) out.child(line("Health", c.healthOutput.split(/\r?\n/).filter(Boolean).pop() ?? "", c.health === "unhealthy" ? t.ansi1 : undefined));
    if (r.service) {
      out.child(line("Runs", c ? (r.actual ? `${r.actual.path}${mainTag(r.actual)}` : "unknown: built outside Dockr") : "nothing yet", r.drift ? t.ansi3 : undefined));
      if (r.set && (r.drift || !c || !r.actual)) out.child(line("Set to", `${r.set.path}${mainTag(r.set)}${r.set.missing ? "  · no such worktree" : ""}`));
    }
    if (c?.ports.length) {
      out.child(h_flex().gap(6).items_center().text_size(11)
        .child(div().w(58).flex_none().text_color(t.dim).child("Ports"))
        .child(h_flex().flex_1().min_w(0).gap(4).flex_wrap().children(c.ports.map((p) =>
          div().id(`port-${id}-${p.host}`).px(5).rounded(3).bg(t.surface).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
            .tooltip(`${model.portUrl(p.host)} (container ${p.container})`)
            .on_click(() => docker.openUrl(model.portUrl(p.host))).child(String(p.host))))));
    }
    // Lists: the row shows them on one line, the tooltip one per line.
    const list = (label, items) => items.length && out.child(h_flex().gap(6).text_size(11)
      .child(div().w(58).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().tooltip(items.join("\n")).text_color(t.muted).child(items.join(", "))));
    if (c) {
      list("Mounts", c.mounts.map((m) => `${m.source} → ${m.target}${m.rw ? "" : " (read only)"}`));
      list("Networks", c.networks.map((n) => (n.ip ? `${n.name} ${n.ip}` : n.name)));
      list("Env", c.env); // names only: Dockr never reads the values
      list("Labels", Object.entries(c.labels).filter(([k]) => !k.startsWith("com.docker.compose.")).map(([k, v]) => `${k}=${v}`));
    }
    return out;
  }

  renderGroup(t, g, ops, branch) {
    const name = g.stack.name, id = idOf(name), folded = !!this.folded[name];
    const urls = model.stackUrls(g.stack, g.rows, this.store.hosts);
    const op = model.opFor(ops, name), down = g.rows.some((r) => r.container?.state !== "running");
    const head = h_flex().w_full().h(34).pl(8).pr(8).gap(6).items_center()
      .child(h_flex().id(`fold-${id}`).flex_1().min_w(0).gap(7).items_center().cursor_pointer()
        .on_click((_e, cx) => this.fold(cx, name))
        .child(svg(icon(folded ? "right" : "down")).size(12).flex_none().text_color(t.dim))
        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(name))
        .child(h_flex().flex_none().gap(2).items_center().children(g.rows.map((r) =>
          div().w(9).h(4).rounded(2).bg(this.statusColor(t, this.store.status(r.container).kind)))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${g.running} up${g.stack.machine ? ` · ${g.stack.machine}` : ""}`)))
      .when(!!this.busy[name] || (!!op && op.failed == null), (el) => el.child(svg(icon("spinner")).size(12).flex_none().text_color(t.working).spin(900)))
      .when(down, (el) => el.child(this.button(t, `up-${id}`, "Up", async (cx) => this.runOp(cx, await this.store.prepareStack(name, "up")), { primary: true, tip: "Start every Service that is not running" })))
      .when(g.running > 0, (el) => el.child(this.iconButton(t, `down-${id}`, "power", "Down: stop and remove the containers. Volumes are kept.", () => this.askDown(name), t.dim)));
    const out = v_flex().w_full().child(head);
    if (folded) return out;
    if (urls.stack.length) out.child(this.links(t, id, urls.stack).px(10).pb(4));
    return out.children(g.rows.map((r) => this.renderRow(t, r, urls.byService[r.name] ?? [], ops, branch)));
  }

  fold(cx, name) {
    this.folded[name] = !this.folded[name];
    localStorage.setItem("folded", JSON.stringify(this.folded));
    cx.notify();
  }

  renderOther(t, rows) {
    const folded = !!this.folded[""];
    const out = v_flex().w_full().child(
      h_flex().id("fold-other").w_full().h(34).px(8).gap(7).items_center().cursor_pointer()
        .on_click((_e, cx) => this.fold(cx, ""))
        .child(svg(icon(folded ? "right" : "down")).size(12).flex_none().text_color(t.dim))
        .child(div().font_semibold().text_color(t.muted).child("Other containers"))
        .child(div().text_size(11).text_color(t.dim).child(String(rows.length))));
    return folded ? out : out.children(rows.map((r) => this.renderRow(t, r, [], [], null)));
  }

  renderPanel(t, cx) {
    // Shown again after being hidden: read the files and Docker once.
    const shown = model.modShown(layout(), "dockr");
    if (shown && !this.wasShown) cx.spawn(async (cx) => { await this.reload(cx); });
    this.wasShown = shown;
    this.takeRequest(cx);

    const ops = this.ops(), branch = this.branch();
    this.announce(ops);
    const v = this.store.view();
    const warnings = [...this.store.problems, ...Object.values(this.store.errors), ...Object.values(this.watchErrors)];
    const body = v_flex().w_full().pb(8);
    for (const g of v.groups) body.child(this.renderGroup(t, g, ops, branch));
    if (v.other.length) body.child(this.renderOther(t, v.other));
    if (!v.groups.length && !v.other.length) {
      body.child(div().p(12).text_size(12).text_color(t.dim).child(Object.keys(this.store.byMachine).length ? "No containers. Add a Stack to dockr.json to manage one." : "Reading Docker…"));
    }
    const undo = this.undo;

    return v_flex().id("dockr").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12.5)
      .child(h_flex().w_full().h(36).pl(10).pr(6).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
        .child(svg("icons/docker.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().font_semibold().child("Dockr"))
        .child(this.iconButton(t, "reload", "restart", "Reload: read dockr.json, the worktrees and Docker again", (cx) => this.reload(cx))))
      .when(warnings.length > 0, (el) => el.child(
        div().w_full().flex_none().px(10).py(5).text_size(11).text_color(t.ansi3).bg(t.raised).tooltip(warnings.join("\n"))
          .child(warnings.length === 1 ? warnings[0] : `${warnings.length} problems. ${warnings[0]}`)))
      .when(!!this.note || !!undo, (el) => el.child(
        h_flex().w_full().flex_none().pl(10).pr(6).py(3).gap(6).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_1().min_w(0).truncate().tooltip(this.note).child(this.note))
          .when(!!undo, (x) => x.child(this.button(t, "undo", `Back to ${undo.label}`, async (cx) => {
            const u = this.undo;
            this.undo = null;
            await this.doSwitch(cx, u.stack, u.targets, false, `Back to ${u.label}`);
          }, { tip: "Undo the last Switch" })))))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }

  // The Source picker: a popup for one Service.

  initPicker(cx) {
    const p = this.picking;
    this.text = "";
    this.at = Math.max(0, p.row.sources.findIndex((s) => p.row.set && model.norm(s.path) === model.norm(p.row.set)));
    this.also = {};
    this.start = !!p.start;
    this.costs = null;
    this.input = InputState.new({ value: "", placeholder: "Filter by branch or ticket" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.ask("switch"); cx.notify(); });
    this.handle.focus();
    this.input.focus();
    // What each checkout costs, worked out once the list is open.
    cx.spawn(async (cx) => {
      try { this.costs = await new Store().costs(p.stack, p.row); } catch { this.costs = {}; }
      cx.notify();
    });
  }

  matches() {
    const words = this.text.toLowerCase().split(/\s+/).filter(Boolean);
    return this.picking.row.sources.filter((s) => words.every((w) => `${s.branch ?? ""} ${s.path}`.toLowerCase().includes(w)));
  }

  /** Hands the ask to the panel and closes. */
  ask(kind) {
    const p = this.picking, s = this.matches()[this.at];
    if (kind === "switch" && !s) return;
    const req = { n: Date.now(), kind, stack: p.stack.name, service: p.row.name, start: this.start };
    if (kind === "switch") {
      req.targets = { [p.row.name]: s };
      for (const o of p.others[s.path] ?? []) if (this.also[o.name] !== false) req.targets[o.name] = o.source;
      req.title = `Switch ${Object.keys(req.targets).join(", ")} to ${model.sourceName(s)}`;
    }
    setShared(REQUEST, req);
    closeOverlay(props().overlay);
  }

  renderPicker(t) {
    const p = this.picking, list = this.matches(), picked = list[this.at] ?? null;
    const others = picked ? p.others[picked.path] ?? [] : [];
    const costText = { current: "current", recreate: "recreate · seconds", rebuild: "rebuild" };
    const rows = v_flex().w_full().gap(1);
    list.forEach((s, i) => {
      const cost = p.row.runs && model.norm(p.row.runs) === model.norm(s.path) ? "current" : this.costs ? this.costs[s.path] : null;
      const on = i === this.at;
      rows.child(h_flex().id(`pick-${i}`).w_full().h(28).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .hover((x) => x.bg(t.hover)).when(on, (el) => el.bg(t.selected))
        .on_click((_e, cx) => { this.at = i; this.also = {}; cx.notify(); })
        .child(svg(icon("branch")).size(11).flex_none().text_color(on ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().tooltip(s.path).text_color(on ? t.foreground : t.muted).child(`${model.sourceName(s)}${mainTag(s)}`))
        .child(div().flex_none().text_size(10.5).text_color(cost === "rebuild" ? t.ansi3 : t.dim).child(cost ? costText[cost] : "…")));
    });
    if (!list.length) rows.child(div().p(8).text_size(11.5).text_color(t.dim).child(p.row.sources.length ? "No checkout matches." : "No checkouts found for this Service."));

    const runs = p.row.runs ? p.row.sources.find((s) => model.norm(s.path) === model.norm(p.row.runs)) : null;
    const idle = !picked || (p.row.set && model.norm(p.row.set) === model.norm(picked.path) && !p.row.drift && !others.some((o) => this.also[o.name] !== false));
    return v_flex().id("dockr-picker").track_focus(this.handle).size_full().min_h(0).p(10).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = Math.min(list.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else if (e.key === "enter") this.ask("switch");
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        this.also = {};
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().w_full().flex_none().gap(6).items_center()
        .child(div().font_semibold().child(p.row.name))
        .child(div().text_size(11).text_color(t.dim).child(`runs from ${runs ? model.sourceName(runs) : "an unknown checkout"}`)))
      .child(Input.new(this.input).flex_none().h(30).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().child(rows))
      .when(others.length > 0, (el) => el.child(v_flex().w_full().flex_none().px(4).children(others.map((o) =>
        this.check(t, `also-${idOf(o.name)}`, this.also[o.name] !== false, `also move ${o.name}`, () => { this.also[o.name] = this.also[o.name] === false; })))))
      .child(h_flex().w_full().flex_none().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(this.check(t, "start", this.start, "Start if stopped", () => { this.start = !this.start; })))
        .child(this.button(t, "rebuild", "Rebuild", () => this.ask("rebuild"), { tip: "Rebuild the image from the Source it is set to" }))
        .child(this.button(t, "switch", "Switch", () => this.ask("switch"), { primary: !idle, dim: idle, tip: p.row.running ? "Enter. The Service is recreated from this checkout." : "Enter. The Service stays stopped unless Start if stopped is ticked." })));
  }

  // The bar over a peeked terminal.

  renderBar(t) {
    const p = this.peeked;
    const term = terminals().find((x) => x.address === p.address);
    const live = term?.state === "live", failed = term?.labels?.["dockr.failed"];
    const close = () => closeOverlay(props().overlay);
    return h_flex().id("dockr-bar").track_focus(this.handle).size_full().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .on_click(() => this.handle.focus())
      .child(div().w(8).h(8).rounded(4).flex_none().bg(failed != null ? t.ansi1 : live ? t.ansi2 : t.dim))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(p.title))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(failed != null ? `failed with exit code ${failed}` : live ? "keeps running when closed" : "ended"))
      .when(!!p.stop && live, (el) => el.child(this.button(t, "bar-stop", failed != null ? "Dismiss" : "Stop", async () => { await docker.kill(p.address); close(); })))
      .when(live, (el) => el.child(this.button(t, "bar-keep", "Keep as tab", () => { close(); run("terminal.keep", { terminal: p.address, place: "tab" }); })))
      .child(this.button(t, "bar-close", "Close", () => close()));
  }

  render(cx) {
    const t = theme();
    if (this.peeked) return this.renderBar(t);
    if (this.picking) return this.renderPicker(t);
    if (this.diagnosing) return diagnose.render(this, t);
    return this.renderPanel(t, cx);
  }
}
