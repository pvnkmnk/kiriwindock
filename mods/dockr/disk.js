// The Disk dialog: what a Stack and the engine hold on disk, and a clean-up that removes unused
// images and, when ticked, unused build cache. It never removes a volume.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, props } from "herdr";
import * as model from "./model.js";
import * as docker from "./docker.js";

async function load(self, cx) {
  const d = self.disking;
  self.disk.loading = true;
  cx.notify();
  const r = await docker.disk(d.machine, d.stack);
  self.disk.loading = false;
  if (r.error) self.disk.error = r.error; else { self.disk.data = model.parseDisk(r.text); self.disk.error = ""; }
  cx.notify();
}

export function init(self, cx) {
  self.disk = { data: null, error: "", loading: true, own: true, all: false, cache: false, confirm: false, working: false, said: [] };
  self.handle.focus();
  cx.spawn(async (cx) => { await load(self, cx); });
}

export function render(self, t) {
  const d = self.disking, D = self.disk, data = D.data, close = () => closeOverlay(props().overlay);
  const sum = (list) => list.reduce((n, x) => n + x.size, 0);
  const row = (label, value, note, color) => h_flex().w_full().h(22).gap(8).items_center().text_size(11.5)
    .child(div().flex_1().min_w(0).truncate().tooltip(label).text_color(color ?? t.muted).child(label))
    .when(!!note, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(note)))
    .child(div().w(64).flex_none().text_color(t.foreground).child(h_flex().w_full().justify_end().child(value)));
  const title = (text) => div().w_full().pt(6).text_size(10.5).text_color(t.dim).child(text.toUpperCase());
  const body = v_flex().w_full().gap(1);

  if (data) {
    const e = data.engine;
    body.child(title(`${d.stack}: images`));
    for (const i of data.images) body.child(row(i.name, model.size(i.size)));
    if (!data.images.length) body.child(row("None built by compose", "0"));
    body.child(row(`Left behind by rebuilds (${data.unused.length})`, model.size(sum(data.unused)), data.unused.length ? "unused" : "", data.unused.length ? t.ansi3 : undefined));
    body.child(title(`${d.stack}: volumes, never removed here`));
    for (const v of data.volumes) body.child(row(v.name, model.size(v.size), v.used ? "in use" : "not in use"));
    if (!data.volumes.length) body.child(row("None", "0"));
    body.child(title(`Everything on ${d.machine ?? "this computer"}'s Docker`));
    if (e.images) body.child(row(`Images (${e.images.count})`, model.size(e.images.size), `${model.size(e.images.reclaimable)} not in use`));
    // Their sizes share layers, so a sum would overstate what removing them frees.
    body.child(row("Untagged images no container uses", String(data.allUnused.count)));
    if (e.volumes) body.child(row(`Volumes (${e.volumes.count})`, model.size(e.volumes.size), `${model.size(e.volumes.reclaimable)} not in use`));
    if (e.cache) body.child(row("Build cache", model.size(e.cache.size), `${model.size(e.cache.reclaimable)} not in use`));
  }

  const others = data ? Math.max(0, data.allUnused.count - data.unused.length) : 0;
  const picked = data && ((D.own && data.unused.length > 0) || (D.all && others > 0) || D.cache);
  const what = !data ? "" : [
    D.own && data.unused.length ? `${data.unused.length} unused image${data.unused.length === 1 ? "" : "s"} of ${d.stack} (${model.size(sum(data.unused))})` : null,
    D.all && others ? `${others} other untagged image${others === 1 ? "" : "s"}, which may belong to other projects` : null,
    D.cache && data.engine.cache ? `unused build cache (${model.size(data.engine.cache.reclaimable)}), shared by every project` : null,
  ].filter(Boolean).join(", ");

  return v_flex().id("dockr-disk").track_focus(self.handle).size_full().min_h(0).p(12).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5)
    .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
    .child(h_flex().w_full().flex_none().gap(8).items_center()
      .child(div().font_semibold().child(`Disk · ${d.stack}`))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(D.loading ? "Asking Docker. This takes a few seconds…" : D.working ? "Cleaning up…" : "")))
    .when(!!D.error, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(D.error)))
    .child(div().id("disk-body").flex_1().min_h(0).overflow_y_scrollbar().child(body))
    .when(D.said.length > 0, (el) => el.child(v_flex().w_full().flex_none().p(6).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).children(D.said.map((l) => div().child(l)))))
    .when(!!data, (el) => el.child(v_flex().w_full().flex_none().gap(0)
      .child(self.check(t, "disk-own", D.own, `Remove the images ${d.stack}'s rebuilds left behind (${data.unused.length})`, () => { D.own = !D.own; D.confirm = false; }))
      .child(self.check(t, "disk-all", D.all, `Also remove the other untagged images no container uses (${others})`, () => { D.all = !D.all; D.confirm = false; }))
      .child(self.check(t, "disk-cache", D.cache, "Also remove unused build cache. The next builds of every project are slower.", () => { D.cache = !D.cache; D.confirm = false; }))))
    .when(D.confirm && !!picked, (el) => el.child(div().w_full().flex_none().text_size(11).text_color(t.ansi3).child(`This removes ${what}. No volume is removed. It cannot be undone.`)))
    .child(h_flex().w_full().flex_none().gap(6).items_center()
      .child(div().flex_1())
      .child(self.button(t, "disk-refresh", "Refresh", (cx) => load(self, cx), { dim: true }))
      .child(self.button(t, "disk-close", "Close", () => close()))
      .when(!!data && !D.working, (el) => el.child(self.button(t, "disk-clean", D.confirm && picked ? "Remove them" : "Clean up", async (cx) => {
        if (!picked) return;
        if (!D.confirm) { D.confirm = true; return; }
        D.confirm = false; D.working = true; cx.notify();
        try { D.said = await docker.cleanUp(d.machine, { images: D.own ? data.unused.map((u) => u.id) : [], allUnused: D.all && others > 0, cache: D.cache }); }
        finally { D.working = false; }
        await load(self, cx);
      }, { primary: !!picked, dim: !picked, tip: picked ? "Shows what will be removed first" : "Nothing is ticked that can be removed" }))));
}
