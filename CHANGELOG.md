# Changelog

What changed in each release of ccpopout. The same notes are on the
[releases page](https://github.com/EmreErdogan/ccpopout/releases).

## Unreleased

### Both panes

- The row being read, where `↑` and `↓` bring an item and scrolling picks the cursor's item, is about a third of the way down the window (35% of its rows), not two rows above its middle.

## v0.9.1 — 2026-11-26

### Both panes

- `j` and the wheel no longer jump past a long reply at the top of a turn: where the next item starts below the row being read, they scroll a row, so the reply is read from its start.

## v0.9.0 — 2026-11-25

### Commands

- `/popout keys add` adds keys for ccpopout to your `keybindings.json`: `ctrl+x r` (`/popout`), `ctrl+x t` (`/popout-side`) and `ctrl+x l` (`/popout-left`). A key you already use for something else stays yours. `/popout keys remove` takes them out again.

### Side pane

- Tables draw a rule between every two rows, not only under the header.
- In Herdr Desktop it opens on the left too, with the ccpopout mod in Desktop: Desktop opens it on the right, and the mod swaps it with Claude Code's pane. Without the mod it stays on the right, and says so.
- In Herdr Desktop the side pane takes the focus when it opens, as in herdr, and `/popout side` gives it the focus again while it is open. This also needs the ccpopout mod.
- `node herdr-app/install.mjs` installs the mod and `node herdr-app/uninstall.mjs` removes it, run where Herdr Desktop runs; `herdr-app/INSTALL.md` walks an agent through either.

## v0.8.2 — 2026-11-23

### Side pane

- Times in the side pane follow the session's time zone (`TZ`) in herdr and Herdr Desktop too, where the pane starts without the shell profile that sets it.

## v0.8.1 — 2026-11-20

### Side pane

- It follows the session where Claude Code runs with its own `CLAUDE_CONFIG_DIR`, in Herdr Desktop too: the pane, started by `hc` with hc's environment, looked for the transcript in `~/.claude` and, not finding it there, stayed as it was when opened.

## v0.8.0 — 2026-11-16

### Side pane

- `/popout side` opens the side pane in Herdr Desktop too, through herdr-core (`hc`): in Claude Code's tab, on the right. There it opens only on the right, at half the width however narrow the terminal is, and says so when the left is asked for. `HC_BIN_PATH` names the `hc` program.

## v0.7.1 — 2026-11-14

### Side pane

- What Claude wrote before a question it asks shows while the question is open when the transcript keeps it as thinking too.
- The plugin hands the side pane the turn only when a dialog is put to you, not on every tool call whose permission auto mode settles.

## v0.7.0 — 2026-11-14

### Both panes

- They open in the clean view, tool calls hidden. A `clean` setting (`/config`, or `pluginConfigs` in settings.json) opens them in the full view instead.
- The view chosen with `z` is kept, for every pane opened after, in every session; in the side pane so is whether the thinking is hidden (`t`).
- Going to another message (`p`, `n`) and back, the turn is where it was left: the cursor on its item, the item on its row of the screen.
- The row being read, where `↑` and `↓` bring an item, is two rows above the window's middle.
- At the top of a turn `j` and the wheel down take the cursor item by item, the window still, until it has come to the row being read; `k` and the wheel up take it to the item before.
- The header is shorter: no blank row under the keys, and at most two rows of the message.
- The whole message (`e`) shows on the header's ground, set apart from the turn. In the side pane a press on it folds it again.
- The rule under the header counts the items the turn shows, and says which one the cursor is on: `▌ 3/12`.
- What Claude wrote before a question it asks (AskUserQuestion), or before a call waiting for a permission, shows while the dialog is open, not only once it is answered.

### Side pane

- The wheel scrolls a row for each step the terminal sends, about three to a notch, not three rows for each.
- A double click selects the word under the mouse, and copies it.
- The header's message ends with the time it was sent.

## v0.6.0 — 2026-10-22

### Side pane

- It opens on the left of Claude Code too: `/popout left` or `/popout-left`. `/popout right` and `/popout-right` open it on the right.
- A `side` setting (`/config`, or `pluginConfigs` in settings.json) and the `CCPOPOUT_SIDE` environment variable set the side `/popout side` and `/popout-side` open it on; the default is still the right.

## v0.5.1 — 2026-10-20

### Side pane

- After a rewind (esc esc, then restore), the conversation goes on from the point it was rewound to: what came after it leaves the pane once the next message is sent.
- Claude's thinking is drawn in a lighter gray, near the replies' own.

## v0.5.0 — 2026-10-13

### Side pane, and the in-app pane in the fullscreen layout

- The first row of the item the cursor moves to comes to the middle of the window, as far as the turn's start allows, however long the item is.
- Scrolling (`j`/`k`, `d`/`u`, the wheel) takes the cursor to the item at the window's middle row, or the one nearest it, not only when its item leaves the screen.
- Half a window of blank rows follows the turn's end, so the last items come to the middle too. While `G` follows new output the window stays at the turn's last row.
- A turn the window holds whole shows no scroll bar and no position in the rule, though those blank rows can be scrolled to.

## v0.4.1 — 2026-10-09

### Side pane

- The times at the rows' edge say no day, so the day is named where it is not
  today: the rule under the header names the day the window's top row was
  written on, a rule across the turn names the day that begins where the turn
  went past midnight, and a run of hidden calls that did ends with `+1`.

## v0.4.0 — 2026-10-09

### Both panes

- The cursor stays in sight as the window scrolls: when its item leaves the screen it comes to the nearest one still there, so `o` and `c` act on what is being read.
- The turn keeps its place when its rows change: after the clean view (`z`), a fold of many (`a`, `f`, `b`, `r`) or a new width, the cursor's item is on the row of the screen it was on. `z` pressed again with nothing done between returns exactly to where the turn was, and so does closing the whole message (`e`) or the help.
- The page keys scroll half the window, not a whole one.

### Side pane

- `g` and `G` take the cursor to the first and the last item; while `G` follows new output, the cursor stays on the last item.
- `J` and `K` scroll a page down and up.
- A selection copies the text itself, without what the layout put around it (indents, marks, line numbers, times); a line the pane wrapped is whole again, and only what will be copied is lit.
- In the clean view the row standing for a run of hidden tool calls ends with the time of its first and of its last.
- Hiding the thinking (`t`) keeps the turn's place as `z` does.

## v0.3.0 — 2026-10-09

### Fixed

- A session begun with a slash command sent to Claude (a skill or a custom command, `/name args`) showed "No messages yet." with no header, and `q` did not close the pane. Such a command is now a message, shown as it was typed; the empty pane has its header and closes on `q`.

### Added

- The help (`h`) names the version the session runs: `ccpopout 0.3.0 · Keys · …`. The side program answers `--version` too.
- Side pane: dragging the mouse selects text, copied when the button is let go. A click answers on release.

## v0.2.1 — 2026-10-05

### Side pane

- Thinking and the scroll position in the rule are drawn in colors that read on a dark terminal.

## v0.2.0 — 2026-10-05

### Side pane

- Claude's thinking between its tool calls is shown; `t` hides it.
- Each reply and each tool call ends with the time it was written.
- The keys in the header light up under the mouse.

### Both panes

- `a` and `A` open and fold everything that folds: replies and thinking too, not the tool calls alone.

### README

- The in-app `/plugin` install and update commands, and `/reload-plugins` for sessions already open.

## v0.1.0 — 2026-10-05

Initial release: read a Claude Code session one message at a time, in a pane inside Claude Code (`/popout`) or in a herdr or tmux pane beside it (`/popout side`).
