// The log window: one container's lines, or a whole Stack's in time order. Lines arrive by waiting
// on `docker logs -f`, one wait per container, so nothing here runs on a timer.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { closeOverlay, props, setShared, settings } from "herdr";
import * as model from "./model.js";
import * as docker from "./docker.js";

const ROW = 17, CHAR = 6.7, CAP = 5000;
const icon = (name) => `mods/dockr/icons/${name}.svg`;

export function init(self, cx) {
  const p = self.logging;
  self.log = { lines: [], follow: true, query: "", time: false, off: {}, at: -1, ended: {}, errors: [], jump: null };
  self.logScroll = VirtualListScrollHandle.new();
  self.logInput = InputState.new({ value: "", placeholder: "Search. /regex/ works too" });
  self.logInput.on("change", (_e, cx) => { self.log.query = self.logInput.value(); self.log.at = -1; cx.notify(); });
  self.logInput.on("submit", (_e, cx) => { step(self, 1); cx.notify(); });
  self.handle.focus();
  for (const s of p.sources) {
    cx.spawn(async (cx) => {
      let since = "";
      for (;;) {
        const r = await docker.waitLogs(p.machine, s.name, since);
        if (r.error) { self.log.errors.push(`${s.label}: ${model.explain(r.error, p.machine)}`); cx.notify(); return; }
        const got = model.parseLogs(r.text, s.label);
        self.log.lines = model.addLogs(self.log.lines, got.lines, since, CAP);
        for (const l of got.lines) if (l.at > since) since = l.at;
        if (self.log.follow) self.log.jump = "end";
        if (got.ended) {
          self.log.ended[s.label] = true;
          cx.notify();
          const w = await docker.waitStart(p.machine, s.name);
          if (w.error) { self.log.errors.push(`${s.label}: ${model.explain(w.error, p.machine)}`); cx.notify(); return; }
          delete self.log.ended[s.label];
        }
        cx.notify();
      }
    });
  }
}

/** The lines shown: those of the sources left on. */
const shown = (self) => {
  const off = self.log.off;
  return Object.keys(off).length ? self.log.lines.filter((l) => !off[l.src]) : self.log.lines;
};

/** Moves to the next (1) or previous (-1) matching line. */
function step(self, by) {
  const test = model.matcher(self.log.query), rows = shown(self);
  if (!test || !rows.length) return;
  let i = self.log.at < 0 ? (by > 0 ? -1 : rows.length) : self.log.at;
  for (let n = 0; n < rows.length; n++) {
    i = (i + by + rows.length) % rows.length;
    if (test(rows[i].text)) { self.log.at = i; self.log.follow = false; self.log.jump = i; return; }
  }
}

export function render(self, t) {
  const p = self.logging, L = self.log, rows = shown(self), test = model.matcher(L.query);
  const mono = settings().font_family ?? "JetBrains Mono", close = () => closeOverlay(props().overlay);
  const many = p.sources.length > 1;
  const colors = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1];
  const colorOf = Object.fromEntries(p.sources.map((s, i) => [s.label, colors[i % colors.length]]));
  const labelW = many ? Math.max(...p.sources.map((s) => s.label.length)) * CHAR + 12 : 0;
  const hits = test ? rows.reduce((n, l) => n + (test(l.text) ? 1 : 0), 0) : 0;
  const longest = rows.reduce((n, l) => Math.max(n, l.text.length), 0);
  const width = Math.min(longest, 2000) * CHAR + labelW + (L.time ? 96 : 0) + 24;

  if (L.jump != null && rows.length) {
    try { self.logScroll.scroll_to_item(L.jump === "end" ? rows.length - 1 : L.jump, L.jump === "end" ? undefined : "top"); } catch {}
    L.jump = null;
  }

  const line = (l, i) => {
    const hit = test && test(l.text);
    return h_flex().w_full().h(ROW).px(8).gap(8).items_center()
      .when(i === L.at, (el) => el.bg(t.selected)).when(hit && i !== L.at, (el) => el.bg(t.raised))
      .when(L.time, (el) => el.child(div().w(88).flex_none().text_color(t.dim).child(model.clock(l.at))))
      .when(many, (el) => el.child(div().w(labelW - 12).flex_none().truncate().text_color(colorOf[l.src] ?? t.dim).child(l.src)))
      .child(div().flex_none().text_color(l.level === "error" ? t.ansi1 : l.level === "warn" ? t.ansi3 : t.foreground).child(l.text || " "));
  };
  const toggle = (id, label, on, tip, click) =>
    div().id(id).px(7).h(22).flex_none().rounded(5).text_size(11.5).cursor_pointer().border_1().border_color(on ? t.accent : t.border)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { click(); cx.notify(); })
      .child(h_flex().h_full().items_center().child(label));
  const stopped = Object.keys(L.ended);

  return v_flex().id("dockr-logs").track_focus(self.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
    .on_key_down((e, cx) => {
      if (e.key === "escape") close();
      else if (e.key === "end") { L.follow = true; L.jump = "end"; }
      else if (e.key === "f3" || (e.key === "g" && (e.modifiers?.control || e.modifiers?.platform))) step(self, e.modifiers?.shift ? -1 : 1);
      else return;
      cx.stop_propagation();
      cx.notify();
    })
    .child(h_flex().w_full().h(38).flex_none().pl(12).pr(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(svg(icon("logs")).size(13).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(260).truncate().font_semibold().child(p.title))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${rows.length}${L.lines.length >= CAP ? "+" : ""} lines${stopped.length ? ` · ${many ? stopped.join(", ") : "container"} stopped` : ""}`))
      .child(div().flex_1().min_w(0))
      .child(div().w(240).flex_none().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(self.logInput).h(24).px(8).items_center().rounded(5).border(1).border_color(t.border).bg(t.background).text_color(t.foreground).text_size(11.5)))
      .when(!!test, (el) => el
        .child(div().flex_none().text_size(11).text_color(hits ? t.muted : t.ansi1).child(hits ? `${hits} matches` : "no match"))
        .child(self.iconButton(t, "log-prev", "up", "Previous match (Shift+F3)", () => step(self, -1)))
        .child(self.iconButton(t, "log-next", "down", "Next match (Enter or F3)", () => step(self, 1))))
      .child(toggle("log-time", "Time", L.time, "Show each line's time", () => { L.time = !L.time; }))
      .child(toggle("log-follow", "Follow", L.follow, "Stay at the newest line (End). Scrolling up turns it off.", () => { L.follow = !L.follow; if (L.follow) L.jump = "end"; }))
      .child(self.button(t, "log-copy", "Copy", (cx) => { cx.write_to_clipboard(rows.map((l) => `${L.time ? `${model.clock(l.at)} ` : ""}${many ? `${l.src} | ` : ""}${l.text}`).join("\n")); }, { tip: "Copy the lines shown" }))
      .when(!!p.terminal, (el) => el.child(self.button(t, "log-term", "Open in terminal", () => { setShared("dockr.request", { n: Date.now(), kind: "tail", ...p.terminal }); close(); }, { dim: true, tip: "The raw tail in a terminal, with all of its history" })))
      .child(self.button(t, "log-close", "Close", () => close())))
    .when(many, (el) => el.child(h_flex().w_full().flex_none().px(12).py(5).gap(5).flex_wrap().border_b(1).border_color(t.border)
      .children(p.sources.map((s, i) => {
        const on = !L.off[s.label];
        return h_flex().id(`log-src-${i}`).h(20).px(7).gap(5).flex_none().items_center().rounded(4).text_size(11).cursor_pointer()
          .border_1().border_color(t.border).text_color(on ? t.foreground : t.dim).hover((x) => x.bg(t.hover))
          .tooltip(on ? `Hide ${s.label}` : `Show ${s.label}`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { if (on) L.off[s.label] = true; else delete L.off[s.label]; L.at = -1; cx.notify(); })
          .child(div().w(7).h(7).rounded(4).bg(on ? colorOf[s.label] : t.dim)).child(s.label);
      }))))
    .when(L.errors.length > 0, (el) => el.child(div().w_full().flex_none().px(12).py(4).text_size(11).text_color(t.ansi3).child(L.errors.join("  "))))
    .child(div().id("log-body").flex_1().min_h(0).relative().font_family(mono).text_size(11.5)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_scroll_wheel((e, cx) => { if ((e.delta?.y ?? e.delta_y ?? 0) > 0 && L.follow) { L.follow = false; cx.notify(); } })
      .when(rows.length > 0, (el) => el
        .child(div().id("log-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(width).h_full()
            .child(v_virtual_list("log-rows", rows.length, ROW, (i) => String(i), (range) => rows.slice(range.start, range.end).map((l, k) => line(l, range.start + k)))
              .size_full().track_scroll(self.logScroll))))
        .child(Scrollbar.vertical("log-rows").viewport_from_layout().absolute().inset_0()))
      .when(!rows.length, (el) => el.child(div().p(12).font_family(".SystemUIFont").text_color(t.dim).child(L.lines.length ? "Every service is hidden." : "Waiting for lines…"))));
}
