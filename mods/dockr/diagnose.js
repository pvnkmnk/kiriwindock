// The Diagnose dialog: shows the exact text an agent will get about a failing container, then
// starts that agent in a new tab. Nothing is sent until the person presses Send.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, knownAgents, props, run, settings, spaces } from "herdr";
import * as model from "./model.js";

export function init(self, cx) {
  const d = self.diagnosing;
  self.agents = null;   // the agents that can be started on that Machine
  self.agentAt = 0;
  self.sendError = "";
  self.handle.focus();
  cx.spawn(async (cx) => {
    try { self.agents = (await knownAgents(d.machine ? { on: d.machine } : {})).filter((a) => a.installed !== false && a.run); }
    catch (e) { self.agents = []; self.sendError = `Could not list agents: ${String(e?.message ?? e)}`; }
    cx.notify();
  });
}

function send(self) {
  const d = self.diagnosing, agent = self.agents?.[self.agentAt];
  if (!agent) return;
  const space = model.pickSpace(spaces(), d.machine, d.folder, d.branch);
  const name = `Diagnose ${d.service}`;
  if (space) run("tab.new", { name, space: space.id, folder: d.folder ?? undefined, argv: agent.run, task: d.brief });
  else run("space.new", { name, folder: d.folder ?? undefined, machine: d.machine ?? "", argv: agent.run, task: d.brief });
  closeOverlay(props().overlay);
}

export function render(self, t) {
  const d = self.diagnosing, close = () => closeOverlay(props().overlay);
  const agents = self.agents, agent = agents?.[self.agentAt];
  const space = model.pickSpace(spaces(), d.machine, d.folder, d.branch);
  const mono = settings().font_family ?? "JetBrains Mono";
  return v_flex().id("dockr-diagnose").track_focus(self.handle).size_full().min_h(0).p(12).gap(8).bg(t.popover).text_color(t.foreground).text_size(12.5)
    .on_key_down((e, cx) => {
      if (e.key === "escape") close();
      else if (e.key === "enter") send(self);
      else return;
      cx.stop_propagation();
    })
    .child(h_flex().w_full().flex_none().gap(8).items_center()
      .child(div().font_semibold().child(`Diagnose ${d.service}`))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(d.why)))
    .child(div().flex_none().text_size(11).text_color(t.muted)
      .child("An agent gets the text below as its first message. It holds no environment values. Read the log lines before sending: a program can print a secret."))
    .child(div().id("brief").flex_1().min_h(0).overflow_y_scrollbar().rounded(6).border_1().border_color(t.border).bg(t.background).p(8)
      .child(v_flex().w_full().font_family(mono).text_size(11).text_color(t.muted)
        .children(d.brief.split("\n").map((l) => div().w_full().min_h(15).child(l || " ")))))
    .when(!!self.sendError, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(self.sendError)))
    .child(h_flex().w_full().flex_none().gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).gap(4).items_center().flex_wrap()
        .when(agents == null, (el) => el.child(div().text_size(11).text_color(t.dim).child("Looking for agents…")))
        .when(agents != null && !agents.length, (el) => el.child(div().text_size(11).text_color(t.ansi3).child(`No agent is installed${d.machine ? ` on ${d.machine}` : ""}.`)))
        .children((agents ?? []).map((a, i) =>
          div().id(`agent-${i}`).px(7).h(22).flex_none().rounded(5).text_size(11.5).cursor_pointer().border_1()
            .border_color(i === self.agentAt ? t.accent : t.border).text_color(i === self.agentAt ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { self.agentAt = i; cx.notify(); })
            .child(h_flex().h_full().items_center().child(a.name ?? a.id ?? String(a.run?.[0] ?? "agent")))))
        .child(div().text_size(11).text_color(t.dim).child(space ? `new tab in ${space.name ?? "that branch's space"}` : "new space")))
      .child(self.button(t, "diag-cancel", "Cancel", () => close()))
      .child(self.button(t, "diag-send", agent ? `Send to ${agent.name ?? "agent"}` : "Send", () => send(self), { primary: !!agent, dim: !agent, tip: "Enter" })));
}
