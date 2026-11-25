// ccpopout for Herdr Desktop: puts ccpopout's side pane where it was asked
// for, and gives it the focus, as herdr does.
//
// Desktop adds a terminal that `hc run` starts with its space and tab labels
// on the right of the tab, and leaves the focus where it was. The plugin
// labels the popout terminal:
//
// - `ccpopout.side=left` and `ccpopout.from=<Claude Code's terminal>` for
//   `/popout left`: once both have panes in one tab, this mod swaps them and
//   labels the popout terminal `ccpopout.placed=left`, which the plugin waits for.
// - `ccpopout.focus=<time>`, set again when `/popout side` finds the pane open:
//   each new value focuses the popout pane.
//
// It draws nothing: a block 0 px wide, alive while it is in the layout.

import { View, div } from "gpui-kit";
import { checking, hc, panes, run, terminals } from "herdr";

const POLL_MS = 250;

export default class CcpopoutPlacer extends View {
  init(_props, cx) {
    // Terminals already swapped, so a failed label does not swap them back.
    this.swapped = new Set();
    // The `ccpopout.focus` value each terminal was last focused for. Those there
    // when the mod starts (a reload, an app start) count as done: no focus taken.
    this.focused = new Map();
    for (const t of terminals()) {
      const asked = t.labels?.["ccpopout.focus"];
      if (typeof t.address === "string" && asked) this.focused.set(t.address, asked);
    }
    if (checking()) return;
    cx.timer.every(POLL_MS, () => this.place());
  }

  place() {
    const shown = panes();
    for (const t of terminals()) {
      const labels = t.labels ?? {};
      const address = t.address;
      if (typeof address !== "string" || t.state === "finished") continue;
      // Not adopted into a pane yet: try again next time.
      const popout = shown.find((p) => p.terminal === address);
      if (!popout) continue;

      if (labels["ccpopout.side"] === "left" && !labels["ccpopout.placed"] && !this.swapped.has(address)) {
        // A terminal on another machine is `<machine>/t9`; its labels name terminals there bare.
        const slash = address.indexOf("/");
        const from = `${slash < 0 ? "" : address.slice(0, slash + 1)}${labels["ccpopout.from"] ?? ""}`;
        const claude = shown.find((p) => p.terminal === from);
        if (claude && popout.tab === claude.tab) {
          this.swapped.add(address);
          run("pane.swap", { pane: popout.pane, target: claude.pane });
          hc(["label", address, "ccpopout.placed=left"]).catch(() => {});
        }
      }

      const asked = labels["ccpopout.focus"];
      if (asked && this.focused.get(address) !== asked) {
        this.focused.set(address, asked);
        run("pane.focus", { pane: popout.pane });
      }
    }
  }

  render() {
    return div();
  }
}
