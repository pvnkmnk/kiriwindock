// Dockr: Docker containers in a side panel, grouped by Stack, with the Source each Service runs from.
// The config is ~/.config/herdr-app/dockr.json. Nothing here runs on a timer: container state comes
// from waiting on `docker events`, and files are read when the panel shows and before each action.
//
// Faces, chosen by props: the panel, the Source picker (a popup), the bar over a peeked terminal
// the Diagnose dialog (diagnose.js), the container and log window (logs.js), the Disk dialog
// (disk.js) and the action menu (menu.js).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { closeOverlay, focused, hc, layout, nextCommand, notify, openOverlay, panes, props, run, setShared, settings, shared, spaces, terminals, theme } from "herdr";
import * as model from "./model.js";
import * as docker from "./docker.js";
import { Store } from "./store.js";
import * as diagnose from "./diagnose.js";
import * as logs from "./logs.js";
import * as disk from "./disk.js";
import * as menu from "./menu.js";
import { legend } from "./kit/legend.js";
import { assignLetters, letterBadge, navigateByLetter } from "./kit/letters.js";

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
    this.logging = props()?.logs ?? null;
    if (this.logging) return logs.init(this, cx);
    this.menuing = props()?.menu ?? null;
    if (this.menuing) return menu.init(this);
    this.disking = props()?.disk ?? null;
    if (this.disking) return disk.init(this, cx);

    // Opened by its key (mod.open): this copy only passes the key on to the panel and closes.
    // A hidden panel hears no commands, and Herdr's mod.open is the one key action that always runs.
    this.passing = props()?.overlay != null;
    if (this.passing) {
      if (!model.modShown(layout(), "dockr")) run("layout.show", { id: "dockr" });
      setShared(REQUEST, { n: Date.now(), kind: "keys" });
      closeOverlay(props().overlay);
      return;
    }

    this.store = new Store(load("built", {}), (built) => localStorage.setItem("built", JSON.stringify(built)));
    this.watching = new Set(); // machines with an event wait running
    this.watchErrors = {};     // machine -> why its wait stopped
    this.busy = {};            // row or stack key -> what a short action is doing to it
    this.note = "";            // the last action's outcome, shown until the next one
    this.undo = null;          // { stack, targets, label }: puts back what the last Switch changed
    this.query = "";           // the search box's text
    this.onlyRunning = localStorage.getItem("running") === "1";
    this.search = InputState.new({ value: "", placeholder: "Search containers" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.enterKeys(); cx.notify(); });
    this.typing = false;       // the search box has the keyboard
    this.heldAt = 0;           // when the panel was last drawn holding the keyboard
    this.help = false;         // every key is listed, after "?"
    this.gone = false;         // the keyboard left: a press outside the panel, or a key that hands it back
    this.kb = false;           // the panel has the keyboard, asked of its focus handle at each render: letters, selection and the legend show
    this.sel = null;           // the selected item's key
    this.typed = "";           // the hint letters typed so far
    this.items = [];           // the list the keys move through, from the last render
    this.links = {};           // row key -> the first link or port it shows
    this.reveal = null;        // an item key to scroll into view
    this.scroll = ScrollHandle.new();
    this.hover = null;         // the row under the pointer
    this.pendingDown = null;   // the Stack a confirm dialog is asking about
    this.told = new Set();     // failed builds already announced
    this.stats = {};           // container name -> its last CPU and memory samples, while the panel shows
    this.sampling = new Set(); // machines with a stats wait running
    this.statsOff = new Set(); // machines whose stats wait could not run
    this.folded = load("folded2", {});
    this.startStopped = localStorage.getItem("start") === "1";
    this.seenRequest = shared(REQUEST)?.n ?? 0;
    this.wasShown = model.modShown(layout(), "dockr");

    cx.spawn(async (cx) => { await this.reload(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.noteHidden();
        if (c === "reload") await this.reload(cx);
        else if (c === "focus") { this.gotFocus = true; this.enterKeys(); }
        else if (c === "keys") this.keysCommand(cx);
        else if (c === "hide") this.hidePanel();
        else if (c === "disk" || c === "logs") { const g = this.groups().find((x) => x.managed) ?? this.groups().find((x) => x.name); if (g) await this.doAction(cx, g.key, c); }
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
    this.note = "";
    this.undo = null;
    this.statsOff.clear();
    this.post(await this.store.reload());
    for (const m of this.store.machines()) this.watch(cx, m);
    cx.notify();
    await this.store.checkStale();
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
        this.noteHidden();
        if (!r.event) continue;
        since = r.since;
        this.post(await this.store.look(machine));
        cx.notify();
        await this.store.checkStale();
        cx.notify();
      }
    });
  }

  /** CPU and memory samples from one Machine, only while the panel is shown. Each wait is one sample. */
  sample(cx, machine) {
    if (this.sampling.has(machine) || this.statsOff.has(machine)) return;
    this.sampling.add(machine);
    cx.spawn(async (cx) => {
      try {
        while (model.modShown(layout(), "dockr")) {
          const r = await docker.waitStats(machine || null);
          if (r.error) { this.statsOff.add(machine); return; } // Reload tries again
          const now = model.parseStats(r.text);
          const mine = new Set((this.store.byMachine[machine] ?? []).map((c) => c.name));
          const rest = Object.fromEntries(Object.entries(this.stats).filter(([n]) => !mine.has(n)));
          const here = Object.fromEntries(Object.entries(this.stats).filter(([n]) => mine.has(n)));
          this.stats = { ...rest, ...model.addStats(here, now) };
          cx.notify();
        }
      } finally { this.sampling.delete(machine); this.noteHidden(); }
    });
  }

  /**
   * Nothing draws while the panel is hidden, so drawing cannot notice that it was. The loops that
   * keep running do: they call this, and the next draw then knows the panel has just been shown.
   */
  noteHidden() { if (!model.modShown(layout(), "dockr")) this.wasShown = false; }

  // The panel: keys, as CodeyPacker's run mod has them

  /** Herdr has handed this panel the keyboard (its "focus" command), or the search box gave it back. */
  enterKeys() {
    this.gone = false;
    this.typed = "";
    this.handle.focus();
  }

  /**
   * The panel's key (ctrl-shift-d): hidden, it shows and takes the keyboard. Shown without the
   * keyboard, it takes it. Holding the keyboard, it gives it back and hides.
   */
  keysCommand(cx) {
    // While the panel holds the keyboard its own key section hides it (hidePanel), so this is
    // reached only without it. Should that section be missing, the key's popup has just taken the
    // keyboard off the panel: ask whether the panel held it a moment ago.
    if (Date.now() - this.heldAt < 1500) return this.hidePanel();
    cx.spawn(async (cx) => { await this.grabKeys(cx); });
  }

  /** Gives the keyboard back to the pane and hides the panel. */
  hidePanel() {
    this.gone = true;
    this.heldAt = 0;
    this.typed = "";
    this.help = false;
    run("pane.go", { direction: "left" });
    run("layout.hide", { id: "dockr" });
  }

  /**
   * Asks Herdr for the keyboard. Only Herdr can move it off a terminal, and it does so with
   * pane.go, one step at a time: step toward the panel until its "focus" command arrives.
   */
  async grabKeys(cx) {
    if (this.grabbing) return;
    this.grabbing = true;
    this.gotFocus = false;
    try {
      for (let i = 0; i < 6 && !this.gotFocus; i++) {
        run("pane.go", { direction: "right" });
        await hc(["--version"]).catch(() => null); // lets the "focus" command arrive before the next step
      }
    } finally { this.grabbing = false; cx.notify(); }
  }

  /** Hands the keyboard back to the pane beside the panel. */
  leaveKeys() {
    this.gone = true;
    this.typed = "";
    run("pane.go", { direction: "left" });
  }

  /** What the keys need to know about the selected item. */
  facts(item) {
    if (!item) return {};
    const gs = item.group.state, group = { anyDown: gs.running < gs.total, anyUp: gs.running > 0 };
    if (item.kind !== "row") return group;
    const r = item.row, c = r.container;
    return { ...group, running: c?.state === "running", created: !!c, service: !!r.service, bad: !!c && this.store.status(c).kind === "bad", link: !!this.links[r.key] };
  }

  panelKey(e, cx) {
    if (this.typing) {
      if (e.key === "escape") { this.enterKeys(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (!this.kb) return;
    const items = this.items;
    const state = { at: Math.max(0, items.findIndex((i) => i.key === this.sel)), typed: this.typed };
    const nav = navigateByLetter(state, e, items);
    this.typed = state.typed;
    const pick = (i) => { const it = items[Math.max(0, Math.min(items.length - 1, i))]; if (it) { this.sel = it.key; this.reveal = it.key; } };
    pick(state.at);
    if (nav === "close" && this.help) { this.help = false; cx.stop_propagation(); cx.notify(); return; }
    if (nav === "close") { this.leaveKeys(); cx.stop_propagation(); cx.notify(); return; }
    if (nav === "done" || nav === "hit") { cx.stop_propagation(); cx.notify(); return; }
    if (!nav && (e.modifiers.control || e.modifiers.alt || e.modifiers.platform)) return;
    const item = items[state.at] ?? null;
    const a = model.keyAction(nav === "act" ? "enter" : e.keystroke, item, this.facts(item));
    if (!a) return;
    cx.stop_propagation();
    if (a.on === "panel") {
      if (a.action === "leave") this.leaveKeys();
      else if (a.action === "help") this.help = !this.help;
      else if (a.action === "search") this.search.focus();
      else pick(a.action === "first" ? 0 : items.length - 1);
    } else if (a.on === "group") {
      const g = item.group;
      if (a.action === "menu") this.openMenu(g.key, this.groupItems(g));
      else if (a.action === "fold" || a.action === "unfold" || a.action === "toggle") {
        const want = a.action === "fold" ? true : a.action === "unfold" ? false : !this.folded[g.key];
        if (!!this.folded[g.key] !== want) this.fold(cx, g.key);
        this.sel = want ? g.key : this.sel;
      } else cx.spawn(async (cx) => { await this.doAction(cx, g.key, a.action); cx.notify(); });
    } else {
      const r = item.row;
      if (a.action === "menu") this.openMenu(r.key, this.menuItems(r));
      else if (a.action === "copy") { cx.write_to_clipboard(r.container.name); this.note = `Copied ${r.container.name}`; }
      else cx.spawn(async (cx) => { await this.doAction(cx, r.key, a.action, a.action === "browser" ? this.links[r.key] : null); cx.notify(); });
    }
    cx.notify();
  }

  /** The hint letter of an item, and whether it is the selected one, while the panel has the keyboard. */
  mark(t, key) {
    if (!this.kb) return null;
    const it = this.items.find((i) => i.key === key);
    return it ? letterBadge(t, it.hint ?? "", this.typed, this.sel === key) : null;
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

  /** Opens the log window for one container, or for every container of a Stack. */
  openLogs(title, key, machine, rows, terminal) {
    const sources = rows.filter((r) => r.container).map((r) => ({ name: r.container.name, label: r.name }));
    if (!sources.length) { this.note = "Nothing has been created yet, so there are no logs."; return; }
    openOverlay({ mod: "dockr", kind: "window", key: `dockr-logs-${idOf(key)}`, width: 1100, height: 680, props: { logs: { title, machine: machine ?? null, sources, terminal } } });
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
    // Opens at once with the checkouts already known. The picker reads them again itself.
    const row = this.store.rows(r.stack).find((x) => x.name === r.name) ?? r;
    const others = {};
    for (const s of row.sources) { const o = model.siblings(stack, this.store.sources, row.name, s); if (o.length) others[s.path] = o; }
    openOverlay({
      mod: "dockr", kind: "popup", at: "top", offset: 70, width: 520, height: 480,
      props: { picker: {
        stack: { name: stack.name, machine: stack.machine }, others, start: this.startStopped,
        row: { name: row.name, main: row.service.main ?? null, sources: row.sources, set: row.set?.path ?? null, runs: row.actual?.path ?? null, drift: row.drift, mounted: row.mounted,
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
    if (req.kind === "keys") return this.keysCommand(cx);
    if (req.kind !== "tail" && req.kind !== "act") {
      this.startStopped = !!req.start;
      localStorage.setItem("start", this.startStopped ? "1" : "0");
    }
    cx.spawn(async (cx) => {
      if (req.kind === "act") await this.doAction(cx, req.key, req.action, req.arg);
      else if (req.kind === "tail") {
        const row = this.store.rows(req.stack).find((r) => r.name === req.service);
        if (row) await this.tail(cx, row, "logs");
      } else if (req.kind === "rebuild") {
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

  /** A row by its key, among every group. */
  findRow(key) {
    for (const g of this.groups()) { const r = g.rows.find((x) => x.key === key); if (r) return r; }
    return null;
  }

  openContainer(r) {
    const c = r.container;
    if (!c) { this.note = `${r.name} has no container yet. Start it first.`; return; }
    const stack = r.stack ? this.store.stack(r.stack) : null;
    openOverlay({ mod: "dockr", kind: "window", key: `dockr-c-${idOf(r.key)}`, width: 1100, height: 680, props: { logs: {
      title: r.name, machine: stack ? stack.machine ?? null : this.store.machineOf(c), sources: [{ name: c.name, label: r.name }],
      terminal: stack ? { stack: r.stack, service: r.name } : null,
      info: { key: r.key, container: c, running: c.state === "running", why: model.why(c), runs: r.service ? r.actual?.path ?? null : null, set: r.service ? r.set?.path ?? null : null, drift: r.drift },
    } } });
  }

  openDisk(name) {
    const stack = this.store.stack(name);
    if (stack) openOverlay({ mod: "dockr", kind: "dialog", width: 560, height: 600, props: { disk: { stack: name, machine: stack.machine ?? null } } });
  }

  /** A short docker command on containers outside every Stack. */
  async plain(cx, key, containers, verb, word) {
    if (this.busy[key]) return;
    this.busy[key] = word;
    this.undo = null;
    cx.notify();
    try { this.note = (await this.store.plain(verb, containers)) ?? ""; }
    finally { delete this.busy[key]; cx.notify(); }
  }

  /** Every action of a row, a group, a menu or a container window ends up here. */
  async doAction(cx, key, action, arg) {
    const g = this.groups().find((x) => x.key === key);
    if (g) {
      const live = g.rows.map((r) => r.container).filter(Boolean);
      if (action === "logs") return this.openLogs(`Logs · ${g.name}`, g.key, g.managed ? g.machine : live[0] && this.store.machineOf(live[0]), g.rows, null);
      if (action === "disk") return this.openDisk(g.name);
      if (action === "down") return this.askDown(g.name);
      if (!g.managed) return this.plain(cx, g.key, action === "up" ? live.filter((c) => c.state !== "running") : live.filter((c) => c.state === "running"), action === "up" ? "start" : "stop", action === "up" ? "starting" : "stopping");
      if (action === "up") return this.runOp(cx, await this.store.prepareStack(g.name, "up"));
      if (action === "stop") {
        if (this.busy[g.key]) return;
        this.busy[g.key] = "stopping";
        cx.notify();
        try { this.note = (await this.store.stopStack(g.name)) ?? ""; } finally { delete this.busy[g.key]; cx.notify(); }
      }
      return;
    }
    const r = this.findRow(key);
    if (!r) return;
    const c = r.container, managed = !!r.stack;
    if (action === "open") return this.openContainer(r);
    if (action === "browser") return docker.openUrl(arg);
    if (action === "diagnose") return this.openDiagnose(cx, r);
    if (action === "source") return this.openPicker(cx, r);
    if (action === "rebuild") return this.runOp(cx, await this.store.prepareRebuild(r));
    if (action === "terminal") {
      if (managed) return this.tail(cx, r, "shell");
      const live = this.ops().find((o) => o.kind === "shell" && o.service === r.name && o.stack === "-");
      return live ? this.peek(live.address, live.title, true) : this.runOp(cx, this.store.prepareShell(r), true);
    }
    if (action === "start" || action === "stop" || action === "restart") {
      const word = action === "start" ? "starting" : action === "stop" ? "stopping" : "restarting";
      if (managed) return this.quick(cx, r, action === "start" && !c ? ["up", "-d"] : [action], word);
      if (c) return this.plain(cx, r.key, [c], action, word);
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

  chipLine(t, id, urls) {
    return h_flex().w_full().gap(4).flex_wrap().children(urls.map((u, i) =>
      div().id(`url-${id}-${i}`).px(6).h(18).rounded(4).text_size(10.5).bg(t.raised).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(u.url).on_click(() => docker.openUrl(u.url)).child(u.label)));
  }

  // Drawing: the panel

  /** What a container offers, in the order Docker Desktop lists it. */
  menuItems(r) {
    const c = r.container, running = c?.state === "running", items = [];
    if (c) items.push({ label: "Open", action: "open", hint: "Logs · Inspect · Stats" });
    if (running) items.push({ label: "Open terminal", action: "terminal" });
    for (const p of (c?.ports ?? []).slice(0, 3)) items.push({ label: `Open localhost:${p.host} in browser`, action: "browser", arg: model.portUrl(p.host) });
    if (items.length) items.push({ sep: true });
    if (running) items.push({ label: "Stop", action: "stop" }, { label: "Restart", action: "restart" });
    else items.push({ label: c ? "Start" : "Create and start", action: "start" });
    if (r.service) items.push({ sep: true }, { label: "Change checkout…", action: "source", hint: "branch or worktree" }, { label: "Rebuild image", action: "rebuild" });
    if (c && (model.why(c) || this.store.looping(c))) items.push({ sep: true }, { label: "Diagnose with an agent…", action: "diagnose" });
    if (c) items.push({ sep: true }, { label: "Copy name", copy: c.name }, { label: "Copy ID", copy: c.id.slice(0, 12) }, { label: "Copy image", copy: c.image });
    return items;
  }

  groupItems(g) {
    const items = [];
    if (g.rows.some((r) => r.container)) items.push({ label: "Logs of every container", action: "logs" });
    if (g.managed) items.push({ label: "Disk and clean-up…", action: "disk" });
    if (items.length) items.push({ sep: true });
    if (g.state.running < g.state.total) items.push({ label: "Start all", action: "up" });
    if (g.state.running > 0) items.push({ label: "Stop all", action: "stop" });
    if (g.managed && g.rows.some((r) => r.container)) items.push({ sep: true }, { label: "Remove containers…", action: "down", danger: true, hint: "compose down" });
    if (!g.managed) items.push({ sep: true }, { note: "Not in dockr.json: checkouts cannot be switched" });
    return items;
  }

  openMenu(key, items) {
    openOverlay({ mod: "dockr", kind: "popup", width: 270, height: menu.height(items), props: { menu: { key, items } } });
  }

  /** The panel's groups: each configured Stack, each other compose project, then the containers in none. */
  groups() {
    const v = this.store.view();
    const make = (key, name, rows, managed, machine) => ({ key, name, rows, managed, machine, state: model.groupState(rows, (c) => this.store.status(c)) });
    return [
      ...v.groups.map((g) => make(`stack:${g.stack.name}`, g.stack.name, g.rows, true, g.stack.machine ?? null)),
      ...model.groupOther(v.other).map((g) => make(g.name ? `project:${g.name}` : "loose", g.name, g.rows, false, null)),
    ];
  }

  notice(t, id, text, color, buttons) {
    return v_flex().w_full().pl(this.kb ? 78 : 49).pr(10).pb(6).gap(4)
      .child(div().w_full().text_size(11).text_color(color).child(text))
      .child(h_flex().w_full().gap(5).children(buttons.map(([label, onClick, primary], i) => this.button(t, `${id}-${i}`, label, onClick, { primary }))));
  }

  renderRow(t, r, urls, ops, branch) {
    const c = r.container, id = idOf(r.key), managed = !!r.stack;
    const st = this.store.status(c), running = c?.state === "running";
    const cause = st.kind === "bad" ? model.why(c) || st.text : "";
    const op = managed ? model.opFor(ops, r.stack, r.name) : null;
    const ph = model.phase(r.name, op, c);
    const busy = this.busy[r.key] ?? (ph && !ph.failed ? ph.text : null);
    const hovered = this.hover === r.key && !busy;
    const hint = model.suggestion(r, branch);
    const shownSource = r.service ? (c ? r.actual : r.set) : null;
    const gone = !!r.set?.missing;
    const act = (action, arg) => (cx) => this.doAction(cx, r.key, action, arg);

    const right = h_flex().flex_none().gap(1).items_center();
    if (ph?.failed) {
      right.child(div().id(`failed-${id}`).flex_none().px(6).h(18).rounded(4).text_size(10.5).bg(t.ansi1).text_color(t.background).cursor_pointer()
        .tooltip("Click to see the output. Dismiss it there to clear this.")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.peek(op.address, op.title, true)).child(ph.text));
    } else if (busy) {
      right.child(div().text_size(11).text_color(t.working).child(busy))
        .when(!!op, (el) => el.child(this.iconButton(t, `out-${id}`, "output", "Show the output", () => this.peek(op.address, op.title, true))));
    } else if (hovered) {
      if (c) right.child(this.iconButton(t, `logs-${id}`, "logs", "Logs", act("open")));
      if (running) right.child(this.iconButton(t, `shell-${id}`, "shell", "Open terminal", act("terminal")));
      if (running) right.child(this.iconButton(t, `restart-${id}`, "restart", "Restart", act("restart")));
      if (running) right.child(this.iconButton(t, `stop-${id}`, "stop", "Stop", act("stop")));
      else right.child(this.iconButton(t, `start-${id}`, "play", c ? "Start" : "Create and start", act("start")));
      right.child(this.iconButton(t, `more-${id}`, "more", "More actions", () => this.openMenu(r.key, this.menuItems(r))));
    } else if (st.text) {
      right.child(div().pr(4).text_size(11).text_color(st.kind === "bad" ? t.ansi1 : t.dim).child(st.text));
    } else if (running && this.stats[c.name]?.length) {
      const now = this.stats[c.name][this.stats[c.name].length - 1];
      right.child(div().pr(4).text_size(10.5).text_color(now.cpu >= 90 ? t.ansi3 : t.dim).tooltip("CPU · memory").child(model.usage(now)));
    }

    const second = h_flex().w_full().pl(this.kb ? 78 : 49).pr(10).pb(5).gap(5).items_center().flex_wrap();
    if (r.service) {
      second.child(h_flex().id(`src-${id}`).max_w(250).min_w(0).h(19).pl(5).pr(3).gap(4).items_center().rounded(4).cursor_pointer()
        .border_1().border_color(gone ? t.ansi1 : r.drift ? t.ansi3 : t.border).text_size(11).text_color(gone ? t.ansi1 : r.drift ? t.ansi3 : t.muted).hover((s) => s.bg(t.selected))
        .tooltip(`The checkout this service runs from${shownSource?.path ? `: ${shownSource.path}` : " is not known, because it was built outside Dockr"}.\nClick to pick a branch or worktree.`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.openPicker(cx, r); }); })
        .child(svg(icon("branch")).size(11).flex_none())
        .child(div().min_w(0).truncate().child(gone ? "worktree is gone" : c && !r.actual ? "unknown checkout" : model.sourceName(shownSource)))
        .child(svg(icon("chevron")).size(11).flex_none().text_color(t.dim)));
      if (hint && !r.drift && !busy) {
        second.child(div().id(`hint-${id}`).flex_none().px(6).h(19).rounded(4).text_size(10.5).border_1().border_color(t.accent).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.selected))
          .tooltip(`The pane you are in is on ${hint.branch}, and ${r.name} has a worktree for it.`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.doSwitch(cx, r.stack, { [r.name]: hint }, this.startStopped, `Switch ${r.name} to ${hint.branch}`); }); })
          .child(h_flex().h_full().items_center().child(`Switch to ${model.shortBranch(hint.branch)}`)));
      }
    } else if (c) {
      second.child(div().max_w(220).min_w(0).truncate().text_size(10.5).text_color(t.dim).tooltip(c.image).child(c.image));
    }
    const chips = urls.length ? urls : (c?.ports ?? []).map((p) => ({ label: `:${p.host}`, url: model.portUrl(p.host) }));
    if (chips.length) this.links[r.key] = chips[0].url; else delete this.links[r.key];
    const badge = this.mark(t, r.key), selected = this.kb && this.sel === r.key;
    for (const [i, u] of chips.slice(0, 6).entries()) {
      second.child(div().id(`url-${id}-${i}`).flex_none().px(6).h(19).rounded(4).text_size(10.5).bg(t.raised).text_color(running ? t.accent : t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`Open ${u.url}`).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => docker.openUrl(u.url)).child(h_flex().h_full().items_center().child(u.label)));
    }

    const out = v_flex().id(`row-${id}`).w_full().cursor_pointer().hover((s) => s.bg(t.hover)).when(selected, (el) => el.bg(t.selected))
      .on_hover((h, cx) => { if (h) this.hover = r.key; else if (this.hover === r.key) this.hover = null; cx.notify(); })
      .on_click((_e, cx) => { cx.spawn(async (cx) => { await this.doAction(cx, r.key, "open"); }); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(r.key, this.menuItems(r)); })
      .child(h_flex().w_full().h(28).pl(10).pr(6).gap(7).items_center()
        .when(!!badge, (el) => el.child(badge))
        .child(this.status(t, st, !!busy))
        .child(svg(model.programIcon(c)).size(17).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(c ? t.foreground : t.muted).child(r.name))
        .child(right))
      .child(second);
    if (cause) out.child(this.renderFailure(t, r, cause));
    if (gone) out.child(this.notice(t, `gone-${id}`, "The worktree this service is set to no longer exists.", t.ansi1, [["Pick another", (cx) => this.openPicker(cx, r), true]]));
    else if (r.drift && !busy) {
      const a = model.sourceName(r.actual), b = model.sourceName(r.set);
      out.child(this.notice(t, `drift-${id}`, `It runs from ${a}, but Dockr has it set to ${b}. A compose command run outside Dockr does this.`, t.ansi3, [
        [`Switch to ${model.shortBranch(b)}`, (cx) => this.doSwitch(cx, r.stack, { [r.name]: r.set }, false, `Apply ${r.name}`), true],
        [`Keep ${model.shortBranch(a)}`, (cx) => this.doSwitch(cx, r.stack, { [r.name]: r.actual }, false, `Keep ${r.name} on ${a}`)],
      ]));
    } else if (this.store.stale[r.key] && !busy) {
      out.child(this.notice(t, `stale-${id}`, "Its dependency files changed since the image was built.", t.ansi3, [["Rebuild", act("rebuild"), true]]));
    }
    return out;
  }

  /** Under a row whose container is not well: why, its last lines, and what to do about it. */
  renderFailure(t, r, cause) {
    const id = idOf(r.key), lines = this.store.tail(r.container).slice(-3);
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().w_full().pl(this.kb ? 78 : 49).pr(10).pb(6).gap(4)
      .when(cause !== this.store.status(r.container).text, (el) => el.child(div().w_full().text_size(11).text_color(t.ansi1).truncate().tooltip(cause).child(cause)))
      .when(lines.length > 0, (el) => el.child(v_flex().w_full().px(6).py(3).rounded(4).bg(t.surface).font_family(mono).text_size(10.5).text_color(t.muted)
        .children(lines.map((l) => div().w_full().truncate().tooltip(l).child(l)))))
      .child(h_flex().w_full().gap(5)
        .child(this.button(t, `diag-${id}`, "Diagnose", (cx) => this.doAction(cx, r.key, "diagnose"), { primary: true, tip: "Show what an agent would be told about this failure, then send it" }))
        .child(this.button(t, `faillogs-${id}`, "Logs", (cx) => this.doAction(cx, r.key, "open")))
        .child(this.button(t, `failstart-${id}`, r.container?.state === "running" ? "Restart" : "Start", (cx) => this.doAction(cx, r.key, r.container?.state === "running" ? "restart" : "start"))));
  }

  renderGroup(t, g, rows, ops, branch) {
    const id = idOf(g.key), folded = !!this.folded[g.key], gs = g.state;
    const stack = g.managed ? this.store.stack(g.name) : null;
    const urls = stack ? model.stackUrls(stack, g.rows, this.store.hosts) : { byService: {}, stack: [] };
    const op = g.managed ? model.opFor(ops, g.name) : null;
    const color = gs.kind === "bad" ? t.ansi1 : gs.kind === "up" ? t.ansi2 : gs.kind === "part" ? t.ansi3 : t.dim;
    const act = (action) => (cx) => this.doAction(cx, g.key, action);
    const badge = this.mark(t, g.key);
    const head = h_flex().id(`head-${id}`).w_full().h(34).pl(8).pr(6).gap(6).items_center().when(this.kb && this.sel === g.key, (el) => el.bg(t.selected))
      .when(!!badge, (el) => el.child(badge))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (g.name) this.openMenu(g.key, this.groupItems(g)); })
      .child(h_flex().id(`fold-${id}`).flex_1().min_w(0).gap(7).items_center().cursor_pointer()
        .on_click((_e, cx) => this.fold(cx, g.key))
        .child(svg(icon(folded ? "right" : "down")).size(12).flex_none().text_color(t.dim))
        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(g.name ?? "Containers"))
        .child(div().flex_none().text_size(11).text_color(color).child(gs.text))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${g.machine ? `${g.machine}` : ""}${this.totals(g.rows)}`)))
      .when(!!this.busy[g.key] || (!!op && op.failed == null), (el) => el.child(svg(icon("spinner")).size(12).flex_none().text_color(t.working).spin(900)));
    if (g.name) {
      if (gs.running < gs.total) head.child(this.button(t, `up-${id}`, gs.running ? "Start all" : "Start", act("up"), { primary: true, tip: g.managed ? "docker compose up -d: create and start every service" : "Start every container of this project" }));
      if (gs.running > 0) head.child(this.iconButton(t, `stopall-${id}`, "stop", "Stop all. The containers are kept.", act("stop")));
      head.child(this.iconButton(t, `more-${id}`, "more", "More: logs, disk, remove containers", () => this.openMenu(g.key, this.groupItems(g))));
    }
    // Flat, so the scroll area can bring any header or row into view: [key, element] pairs.
    const out = [[g.key, head]];
    if (folded) return out;
    if (urls.stack.length) out.push([null, this.chipLine(t, id, urls.stack).px(10).pb(4)]);
    for (const r of rows) out.push([r.key, this.renderRow(t, r, urls.byService[r.name] ?? [], ops, branch)]);
    return out;
  }

  /** A Stack's CPU and memory in all, for its header. Empty before the first sample. */
  totals(rows) {
    let cpu = 0, mem = 0, any = false;
    for (const r of rows) {
      const s = r.container && this.stats[r.container.name];
      if (!s?.length) continue;
      any = true; cpu += s[s.length - 1].cpu; mem += s[s.length - 1].mem;
    }
    return any ? ` · ${Math.round(cpu)}% · ${model.size(mem)}` : "";
  }

  fold(cx, key) {
    this.folded[key] = !this.folded[key];
    localStorage.setItem("folded2", JSON.stringify(this.folded));
    cx.notify();
  }

  renderPanel(t, cx) {
    // Shown again after being hidden: read the files and Docker once.
    const shown = model.modShown(layout(), "dockr");
    if (shown && !this.wasShown) cx.spawn(async (cx) => { await this.reload(cx); });
    this.wasShown = shown;
    if (shown) for (const m of Object.keys(this.store.byMachine)) this.sample(cx, m);
    this.takeRequest(cx);

    // The handle still answers "focused" in the render that follows a press elsewhere or a leave,
    // and nothing draws the panel again once the keyboard has moved, so those two say so themselves.
    this.kb = (this.handle.is_focused() && !this.gone) || this.typing;
    if (this.kb) this.heldAt = Date.now();
    const ops = this.ops(), branch = this.branch();
    this.announce(ops);
    const groups = this.groups(), filtering = !!this.query.trim() || this.onlyRunning;
    const warnings = [...this.store.problems, ...Object.values(this.store.errors), ...Object.values(this.watchErrors)];
    const shownRows = (g) => g.rows.filter((r) => model.rowMatches(r, this.query) && (!this.onlyRunning || r.container?.state === "running"));
    this.items = model.panelItems(groups, this.folded, shownRows, filtering);
    const hints = assignLetters(this.items.length, model.KEY_LETTERS);
    this.items.forEach((it, i) => { it.hint = hints[i]; });
    if (this.items.length && !this.items.some((i) => i.key === this.sel)) this.sel = (this.items.find((i) => i.kind === "row") ?? this.items[0]).key;
    const body = v_flex().id("dockr-body").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pb(8);
    const order = [];
    for (const g of groups) {
      if (!this.items.some((i) => i.kind === "group" && i.key === g.key)) continue;
      for (const [key, el] of this.renderGroup(t, g, shownRows(g), ops, branch)) { order.push(key); body.child(el); }
    }
    const any = order.length > 0;
    if (this.reveal != null) {
      const at = order.indexOf(this.reveal);
      this.reveal = null;
      if (at >= 0) { try { this.scroll.scroll_to_item(at); } catch {} }
    }
    const current = this.items.find((i) => i.key === this.sel) ?? null;
    if (!any) {
      const read = Object.keys(this.store.byMachine).length > 0;
      body.child(div().p(12).text_size(12).text_color(t.dim).child(!read ? "Reading Docker…" : filtering ? "No container matches." : "No containers yet. Start one with docker run or docker compose up and it shows here."));
    }
    if (!this.store.stacks.length && !this.store.problems.length && Object.keys(this.store.byMachine).length) {
      body.child(div().px(12).pt(10).text_size(11).text_color(t.dim).child("To pick the branch or worktree each service runs from, list its compose project in dockr.json. The README shows how."));
    }
    const undo = this.undo;

    return v_flex().id("dockr").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(this.kb ? t.accent : t.border).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => this.panelKey(e, cx))
      .on_mouse_down("left", (_e, cx) => { this.gone = false; cx.notify(); })
      .on_mouse_down_out((_e, cx) => { if (!this.gone) { this.gone = true; this.help = false; cx.notify(); } })
      .child(h_flex().w_full().h(40).pl(10).pr(6).gap(6).flex_none().items_center().border_b(1).border_color(t.border)
        .child(svg("icons/docker.svg").size(15).flex_none().text_color(t.muted))
        .child(h_flex().flex_1().min_w(0).h(26).pl(7).gap(5).items_center().rounded(6).border_1().border_color(t.border).bg(t.surface)
          .child(svg(icon("search")).size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().min_w(0).h(24).text_size(12).text_color(t.foreground)))
        .child(div().id("only-running").px(7).h(24).flex_none().rounded(5).text_size(11.5).cursor_pointer().border_1()
          .border_color(this.onlyRunning ? t.accent : t.border).text_color(this.onlyRunning ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .tooltip("Only show running containers")
          .on_click((_e, cx) => { this.onlyRunning = !this.onlyRunning; localStorage.setItem("running", this.onlyRunning ? "1" : "0"); cx.notify(); })
          .child(h_flex().h_full().items_center().child("Running")))
        .child(this.iconButton(t, "reload", "restart", "Refresh: read Docker, the worktrees and dockr.json again", (cx) => this.reload(cx))))
      .when(warnings.length > 0, (el) => el.child(
        div().w_full().flex_none().px(10).py(5).text_size(11).text_color(t.ansi3).bg(t.raised).tooltip(warnings.join("\n"))
          .child(warnings.length === 1 ? warnings[0] : `${warnings.length} problems. ${warnings[0]}`)))
      .when(!!this.note || !!undo, (el) => el.child(
        h_flex().w_full().flex_none().pl(10).pr(6).py(3).gap(6).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_1().min_w(0).truncate().tooltip(this.note).child(this.note))
          .when(!!undo, (x) => x.child(this.button(t, "undo", `Undo: back to ${undo.label}`, async (cx) => {
            const u = this.undo;
            this.undo = null;
            await this.doSwitch(cx, u.stack, u.targets, false, `Back to ${u.label}`);
          }, { tip: "Undo the last Switch" })))
          .child(div().id("note-close").flex_none().px(5).py(1).rounded(4).cursor_pointer().hover((x) => x.bg(t.raised)).tooltip("Dismiss").child("✕")
            .on_click((_e, cx) => { this.note = ""; this.undo = null; cx.notify(); }))))
      .child(body)
      .when(this.kb && this.help && !this.typing, (el) => el.child(this.renderKeys(t, model.keyHints(current, this.facts(current)))))
      .when(this.kb && !(this.help && !this.typing), (el) => el.child(div().w_full().flex_none().px(12).py(8).border_t(1).border_color(t.border)
        .child(legend(t, this.typing ? [["enter", "back to the list"], ["esc", "back to the list"]] : model.coreHints(current, this.facts(current))))));
  }

  /** Every key that works on the selected item, in two columns, after "?". */
  renderKeys(t, hints) {
    const all = [...hints.filter(([k]) => k !== "q"), ["g / G", "first / last"], ["h / l", "fold / unfold group"], ["a letter", "jump to that row"], ["q", "leave"], ["?", "hide this list"]];
    const half = Math.ceil(all.length / 2);
    const col = (list) => v_flex().flex_1().min_w(0).gap(3).children(list.map(([k, what]) => h_flex().w_full().h(18).gap(8).items_center().text_size(11)
      .child(div().w(46).flex_none().font_semibold().text_color(t.accent).child(k))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(what))));
    return h_flex().w_full().flex_none().px(12).py(10).gap(14).items_start().border_t(1).border_color(t.border).bg(t.raised)
      .child(col(all.slice(0, half))).child(col(all.slice(half)));
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
    this.loose = [];      // local branches with no checkout
    this.reading = !!p.row.main;
    // The list opens with what the panel knew. Worktrees come and go, so they are read again here,
    // with the branches no checkout is on, and then what each checkout costs.
    cx.spawn(async (cx) => {
      if (p.row.main) {
        const [list, all] = await Promise.all([docker.worktrees(p.stack.machine, p.row.main), docker.branches(p.stack.machine, p.row.main)]);
        if (list.length) {
          const picked = this.matches()[this.at]?.path;
          p.row.sources = list;
          const again = this.matches().findIndex((s) => s.path === picked);
          this.at = again >= 0 ? again : 0;
        }
        this.loose = model.looseBranches(all, p.row.sources);
        this.reading = false;
        cx.notify();
      }
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
    if (!list.length) rows.child(div().p(8).text_size(11.5).text_color(t.dim).child(p.row.sources.length ? "No checkout matches." : this.reading ? "Reading the worktrees…" : "No checkouts found for this Service."));
    const words = this.text.toLowerCase().split(/\s+/).filter(Boolean);
    const loose = this.loose.filter((b) => words.every((w) => b.toLowerCase().includes(w)));
    if (loose.length) {
      rows.child(div().w_full().px(8).pt(8).pb(2).text_size(10.5).text_color(t.dim).child("BRANCHES WITH NO WORKTREE"));
      for (const b of loose.slice(0, 30)) {
        rows.child(h_flex().w_full().h(24).px(8).gap(8).items_center().tooltip(`Nothing is checked out on ${b}. Add a worktree for it, and it shows above.`)
          .child(svg(icon("branch")).size(11).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(b))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child("add a worktree to run it")));
      }
    }

    const runs = p.row.runs ? p.row.sources.find((s) => model.norm(s.path) === model.norm(p.row.runs)) : null;
    const idle = !picked || (p.row.set && model.norm(p.row.set) === model.norm(picked.path) && !p.row.drift && !others.some((o) => this.also[o.name] !== false));
    return v_flex().id("dockr-picker").track_focus(this.handle).w_full().p(10).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        // A filter box takes the plain letters, so actions are ctrl chords, as in CodeyPacker's branch mod.
        const k = e.keystroke;
        if (e.key === "down" || k === "ctrl-j" || k === "ctrl-n") this.at = Math.min(list.length - 1, this.at + 1);
        else if (e.key === "up" || k === "ctrl-k" || k === "ctrl-p") this.at = Math.max(0, this.at - 1);
        else if (e.key === "enter") this.ask("switch");
        else if (k === "ctrl-r") this.ask("rebuild");
        else if (k === "ctrl-s") this.start = !this.start;
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        this.also = {};
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().w_full().flex_none().gap(6).items_center()
        .child(div().font_semibold().child(p.row.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`runs from ${runs ? model.sourceName(runs) : "an unknown checkout"}`))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.reading ? "reading…" : `${p.row.sources.length} checkouts`)))
      .child(Input.new(this.input).flex_none().h(30).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
      // A popup is as tall as its content, so the list states its own height.
      .child(div().id("pick-list").w_full().flex_none().h(Math.min(330, Math.max(40, list.length * 29 + (loose.length ? 26 + Math.min(loose.length, 30) * 24 : 0) + 4))).overflow_y_scrollbar().child(rows))
      .when(others.length > 0, (el) => el.child(v_flex().w_full().flex_none().px(4).children(others.map((o) =>
        this.check(t, `also-${idOf(o.name)}`, this.also[o.name] !== false, `also move ${o.name}`, () => { this.also[o.name] = this.also[o.name] === false; })))))
      .child(h_flex().w_full().flex_none().gap(6).items_center()
        .child(div().flex_1().min_w(0).child(this.check(t, "start", this.start, "Start if stopped", () => { this.start = !this.start; })))
        .child(this.button(t, "rebuild", "Rebuild", () => this.ask("rebuild"), { tip: "Rebuild the image from the Source it is set to" }))
        .child(this.button(t, "switch", "Switch", () => this.ask("switch"), { primary: !idle, dim: idle, tip: p.row.running ? "Enter. The Service is recreated from this checkout." : "Enter. The Service stays stopped unless Start if stopped is ticked." })))
      .child(legend(t, [["↑/↓", "move"], ["ctrl-j/k", "move"], ["enter", "switch"], ["ctrl-r", "rebuild"], ["ctrl-s", "start if stopped"], ["esc", "close"]]));
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
    if (this.passing) return div();
    if (this.peeked) return this.renderBar(t);
    if (this.picking) return this.renderPicker(t);
    if (this.diagnosing) return diagnose.render(this, t);
    if (this.logging) return logs.render(this, t);
    if (this.menuing) return menu.render(this, t);
    if (this.disking) return disk.render(this, t);
    return this.renderPanel(t, cx);
  }
}
