// The dashboard tab of the Dockr dialog: what the containers use now and over the last minutes.
// Everything comes from the stats samples the dialog already reads while it is open, plus one
// read of Docker's disk use the first time the tab shows.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as model from "./model.js";
import * as docker from "./docker.js";

const pct = (n) => `${n >= 10 ? Math.round(n) : n.toFixed(1)}%`;

/** Reads Docker's disk use once per Machine. It takes Docker several seconds. */
export function loadDisk(self, cx) {
  if (self.dashDisk) return;
  const machines = Object.keys(self.store.byMachine);
  if (!machines.length) return;
  self.dashDisk = { loading: true, data: null, error: "" };
  cx.spawn(async (cx) => {
    const r = await docker.disk(machines[0] || null, "");
    self.dashDisk = r.error ? { loading: false, data: null, error: r.error } : { loading: false, data: model.parseDisk(r.text).engine, error: "" };
    cx.notify();
  });
}

export function render(self, t, groups) {
  const d = model.dashboard(groups, self.stats, (c) => self.store.status(c), self.dashSort);
  const T = d.totals, sampled = d.rows.some((r) => r.sampled);
  const tile = (label, value, sub) => v_flex().flex_1().min_w(0).px(10).py(8).gap(2).rounded(8).bg(t.raised)
    .child(div().text_size(10.5).text_color(t.dim).child(label))
    .child(div().text_size(17).font_semibold().truncate().child(value))
    .child(div().text_size(10.5).text_color(t.muted).truncate().child(sub ?? ""));
  const chart = (label, values, top, text, color) => v_flex().flex_1().min_w(0).gap(5)
    .child(h_flex().w_full().gap(8).items_center().child(div().font_semibold().child(label)).child(div().text_color(t.muted).child(text)))
    .child(h_flex().w_full().h(64).px(5).gap(1).items_end().justify_end().overflow_hidden().rounded(6).bg(t.raised).children(values.map((v) =>
      div().w(4).flex_none().rounded(1).h(Math.max(2, Math.round((Math.min(v, top) / top) * 58))).bg(color))));
  const bar = (share, color) => div().w(90).h(6).flex_none().rounded(3).bg(t.raised).child(div().h(6).rounded(3).w(Math.round(90 * Math.max(0, Math.min(1, share)))).bg(color));
  const head = (text) => div().pt(4).text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());

  const out = v_flex().w_full().p(12).gap(12).text_size(12);
  out.child(h_flex().w_full().gap(8)
    .child(tile("Containers", `${T.running} / ${T.total}`, "running"))
    .child(tile("CPU", sampled ? pct(T.cpu) : "…", "100% is one core"))
    .child(tile("Memory", sampled ? model.size(T.mem) : "…", T.limit ? `of ${model.size(T.limit)}` : ""))
    .child(tile("Network", sampled ? `${model.size(T.netIn)} in` : "…", sampled ? `${model.size(T.netOut)} out` : ""))
    .child(tile("Disk", sampled ? `${model.size(T.diskIn)} read` : "…", sampled ? `${model.size(T.diskOut)} written` : "")));

  if (!sampled) out.child(div().text_color(t.dim).child(T.running ? "Waiting for the first sample. It takes about two seconds…" : "Nothing is running, so there is nothing to measure."));
  else out.child(h_flex().w_full().gap(12)
    .child(chart("CPU", d.history.cpu, Math.max(100, ...d.history.cpu), pct(T.cpu), t.ansi4))
    .child(chart("Memory", d.history.mem, Math.max(1, ...d.history.mem) * 1.15, model.size(T.mem), t.ansi5)));

  if (d.attention.length) {
    out.child(head("Needs a look"));
    out.child(v_flex().w_full().gap(2).children(d.attention.map((a) => h_flex().id(`dash-att-${a.key}`).w_full().h(24).px(8).gap(8).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => self.openContainer(a.row))
      .child(div().w(7).h(7).flex_none().rounded(4).bg(a.bad ? t.ansi1 : t.ansi3))
      .child(div().font_semibold().child(a.name))
      .child(div().flex_1().min_w(0).truncate().text_color(a.bad ? t.ansi1 : t.ansi3).child(a.why)))));
  }

  if (d.groups.length > 1) {
    out.child(head("Groups"));
    const topCpu = Math.max(100, T.cpu), topMem = Math.max(1, T.mem);
    out.child(v_flex().w_full().gap(2).children(d.groups.map((g) => h_flex().w_full().h(22).px(8).gap(10).items_center()
      .child(div().flex_1().min_w(0).truncate().child(g.name))
      .child(div().w(46).flex_none().text_color(t.muted).child(`${g.running}/${g.total}`))
      .child(bar(g.cpu / topCpu, t.ansi4)).child(div().w(44).flex_none().text_color(t.muted).child(pct(g.cpu)))
      .child(bar(g.mem / topMem, t.ansi5)).child(div().w(44).flex_none().text_color(t.muted).child(model.size(g.mem))))));
  }

  out.child(head("Containers"));
  const col = (text, w, on) => div().id(`dash-col-${text}`).w(w).flex_none().text_size(10.5).text_color(on ? t.foreground : t.dim).child(on ? `${text} ▾` : text);
  const sortBy = (el, key) => el.cursor_pointer().on_click((_e, cx) => { self.dashSort = key; localStorage.setItem("dashSort", key); cx.notify(); });
  out.child(h_flex().w_full().px(8).gap(10).items_center()
    .child(div().flex_1().min_w(0).text_size(10.5).text_color(t.dim).child("Name"))
    .child(sortBy(col("CPU", 52, self.dashSort !== "mem"), "cpu"))
    .child(sortBy(col("Memory", 150, self.dashSort === "mem"), "mem"))
    .child(col("Net in / out", 96)).child(col("Disk r / w", 96)).child(col("Restarts", 50)).child(col("Up", 34)));
  out.child(v_flex().w_full().gap(1).children(d.rows.map((r) => h_flex().id(`dash-row-${r.key}`).w_full().h(26).px(8).gap(10).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click(() => self.openContainer(r.row))
    .child(h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(div().w(7).h(7).flex_none().rounded(4).bg(r.bad ? t.ansi1 : r.running ? t.ansi2 : t.dim))
      .child(div().min_w(0).truncate().child(r.name))
      .when(!!r.group, (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(r.group))))
    .child(div().w(52).flex_none().text_color(r.sampled ? t.foreground : t.dim).child(r.sampled ? pct(r.cpu) : r.running ? "…" : "-"))
    .child(h_flex().w(150).flex_none().gap(6).items_center()
      .child(div().w(46).flex_none().text_color(r.sampled ? t.foreground : t.dim).child(r.sampled ? model.size(r.mem) : r.running ? "…" : "-"))
      .when(r.sampled && r.limit > 0, (el) => el.child(bar(r.memPct / 100, r.memPct >= 90 ? t.ansi1 : t.ansi5))))
    .child(div().w(96).flex_none().truncate().text_color(t.muted).child(r.sampled ? `${model.size(r.netIn)} / ${model.size(r.netOut)}` : ""))
    .child(div().w(96).flex_none().truncate().text_color(t.muted).child(r.sampled ? `${model.size(r.diskIn)} / ${model.size(r.diskOut)}` : ""))
    .child(div().w(50).flex_none().text_color(r.restarts ? t.ansi3 : t.muted).child(String(r.restarts)))
    .child(div().w(34).flex_none().text_color(t.muted).child(r.up)))));
  if (!d.rows.length) out.child(div().px(8).text_color(t.dim).child("No containers yet."));

  out.child(head("Docker's disk"));
  const D = self.dashDisk;
  if (!D || D.loading) out.child(div().px(8).text_color(t.dim).child("Reading Docker's disk use. It takes a few seconds…"));
  else if (D.error) out.child(div().px(8).text_color(t.ansi3).child(D.error));
  else {
    const part = (label, e) => tile(label, e ? model.size(e.size) : "0", e ? `${e.count} · ${model.size(e.reclaimable)} unused` : "");
    out.child(h_flex().w_full().gap(8).child(part("Images", D.data.images)).child(part("Volumes", D.data.volumes)).child(part("Build cache", D.data.cache)).child(part("Containers", D.data.containers)));
  }
  return div().id("dockr-dash").flex_1().min_h(0).overflow_y_scrollbar().child(out);
}
