# Installing the ccpopout mod in Herdr Desktop

Instructions for a coding agent (Claude Code, Codex, ...) asked to install or
remove the ccpopout mod. People can hand this file to their agent: "Install
the ccpopout Herdr Desktop mod by following
https://github.com/EmreErdogan/ccpopout/blob/main/herdr-app/INSTALL.md".

## What it is

ccpopout's `/popout side` and `/popout left` open its side pane in Herdr
Desktop through herdr-core (`hc run`). Desktop always puts such a pane on the
right and leaves the focus where it was. The mod, a 0 px block in Desktop's
layout that draws nothing, reads labels the plugin puts on the pane: it swaps
the pane with Claude Code's when it was asked for on the left
(`ccpopout.side=left`), and focuses it (`ccpopout.focus`). Without the mod the
pane stays on the right and does not take the focus.

The scripts beside this file do the work; do not edit Desktop's files by hand.

- `install.mjs`: copies `ccpopout/` to Desktop's mods folder; where the window
  shows a layout Herdr ships (`main`, `terminals`, `win98`), which take no
  mods, duplicates it as `<name>-ccpopout` and switches to it; adds the mod's
  block to the layout shown; checks the mod. Running it again only updates
  the mod.
- `uninstall.mjs`: switches from `<name>-ccpopout` back to `<name>` (the copy
  is kept), takes the block out of every layout, deletes the mod.

## Before you start

1. **Run on the computer Herdr Desktop runs on.** The scripts talk to the
   open window through `herdr-app`. Check with `herdr-app status`: it prints
   JSON with a `layout` field. If `herdr-app` is not found, you are probably
   on another machine Desktop connects to (Claude Code often runs on a server
   while Desktop runs on a laptop). Stop and tell the person to run you, or
   the command below, on the computer with Desktop. Do not try to reach it
   over ssh unless they ask.
2. **Herdr Desktop must be open.** If `herdr-app status` says there is no
   window, ask the person to open Desktop. Do not launch it yourself.
3. **Node.js 18 or newer** (`node --version`).

## Install

Use this repository where it already is on that computer (a clone, or the
Claude Code plugin under `~/.claude/plugins`, where `herdr-app/install.mjs`
is inside the plugin's folder). Otherwise fetch a copy into a new temporary
folder:

```sh
git clone --depth 1 https://github.com/EmreErdogan/ccpopout "$(mktemp -d)/ccpopout"
```

Then run, with the path to that copy:

```sh
node <ccpopout>/herdr-app/install.mjs
```

It prints each step and ends with `ccpopout: installed`, or exits 1 with
`ccpopout: not installed: <why>`. Tell the person what it did, in particular
when it switched the window to a new layout (`main-ccpopout`): that is
expected, the window looks the same.

To check it works: in a Claude Code session in Desktop with the ccpopout
plugin, `/popout left` opens the side pane on the left within a few seconds,
without the message "Herdr Desktop opened it on the right", and the side pane
has the focus.

## Uninstall

```sh
node <ccpopout>/herdr-app/uninstall.mjs
```

It ends with `ccpopout: uninstalled`. It keeps the duplicated layout file
(`~/.config/herdr-app/layouts/<name>-ccpopout.json`) and says so; delete it
only if the person asks.

## When it fails

- `herdr-app was not found`: see "Before you start", step 1. Where it is
  installed but not on `PATH`, set `HERDR_APP_BIN` to its path.
- `the layout's root is not a row or column`: the person's own layout is
  unusual. Show them the block the message prints, to add to their layout
  file themselves.
- `Herdr Desktop reports: mod ccpopout: ...`: the mod failed to load. Report
  the message; it may mean this Desktop version changed its mod API.
- Desktop's folder is `$HERDR_APP_HOME`, else `$XDG_CONFIG_HOME/herdr-app`,
  else `~/.config/herdr-app`; the scripts find it the same way.
