# Changelog

What changed in each release of ccpopout. The same notes are on the
[releases page](https://github.com/EmreErdogan/ccpopout/releases).

## Unreleased

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
