// A small menu at the pointer. Each item hands an action to the panel through shared state, or
// copies a text, and the menu closes.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, props, setShared } from "herdr";

/** The height a menu of these items needs. */
export const height = (items) => 12 + items.reduce((n, i) => n + (i.sep ? 9 : i.note ? 22 : 26), 0);

export function init(self) {
  self.menuAt = self.menuing.items.findIndex((i) => !i.sep && !i.note);
  self.handle.focus();
}

function choose(self, cx, item) {
  if (!item || item.sep || item.note) return;
  if (item.copy != null) cx.write_to_clipboard(item.copy);
  else setShared("dockr.request", { n: Date.now(), kind: "act", key: self.menuing.key, action: item.action, arg: item.arg ?? null });
  closeOverlay(props().overlay);
}

export function render(self, t) {
  const m = self.menuing, close = () => closeOverlay(props().overlay);
  return v_flex().id("dockr-menu").track_focus(self.handle).size_full().p(5).bg(t.popover).text_color(t.foreground).text_size(12.5)
    .on_key_down((e, cx) => {
      const step = (by) => { let i = self.menuAt; for (let n = 0; n < m.items.length; n++) { i = (i + by + m.items.length) % m.items.length; if (!m.items[i].sep && !m.items[i].note) break; } self.menuAt = i; };
      if (e.key === "escape" || e.key === "q") close();
      else if (e.key === "down" || e.key === "j" || e.keystroke === "ctrl-n") step(1);
      else if (e.key === "up" || e.key === "k" || e.keystroke === "ctrl-p") step(-1);
      else if (e.key === "enter") choose(self, cx, m.items[self.menuAt]);
      else return;
      cx.stop_propagation();
      cx.notify();
    })
    .children(m.items.map((item, i) => {
      if (item.sep) return div().w_full().h(1).my(4).bg(t.border);
      if (item.note) return div().w_full().h(22).px(8).text_size(10.5).text_color(t.dim).truncate().child(h_flex().h_full().items_center().child(item.note));
      return h_flex().id(`menu-${i}`).w_full().h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .text_color(item.danger ? t.ansi1 : t.foreground).hover((s) => s.bg(t.selected)).when(i === self.menuAt, (el) => el.bg(t.selected))
        .on_click((_e, cx) => choose(self, cx, item))
        .child(div().flex_1().min_w(0).truncate().child(item.label))
        .when(!!item.hint, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(item.hint)));
    }));
}
