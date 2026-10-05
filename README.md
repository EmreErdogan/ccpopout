# ccpopout

Read a Claude Code session one message at a time.

Long sessions bury Claude's answers between diffs and command output. ccpopout
pops the session out of the transcript into a view of its own: pick one of your
messages and see what Claude did since, with every tool call folded to one line
until you open it.

```
 p ◂ older  n newer ▸  e expand  a open all  A fold all  z clean  ? help  q close

 7/12 › the header disappears when I scroll to the bottom
──────────────────────────────────────────────────────────────── top · ↓ 31 ──
▌ ● You're right. I'll run the pane in a real terminal first and read the      ┃
▌   screen, then fix it there.                                                 ┃
                                                                               ┃
  ▸ Bash(tmux new-session -d -s qt -x 100 -y 40 …) · 20 lines                  │
  ▸ Edit(hooks/register.tsx) · +14 −6                                          │
  ▾ Bash(claude plugin test .) · error                                         │
      1 fail                                                                   │
```

It comes in two forms that behave the same:

- **In-app pane** (`/popout`): a pane inside Claude Code.
- **Side pane** (`/popout side`): a separate terminal program in a
  herdr or tmux pane next to Claude Code, at full height, following the
  session live.

## Requirements

- Claude Code with plugin hooks modules. Developed and tested on 2.1.288; the
  API it uses is new and may change between releases.
- For the side pane: Node.js 20 or newer on `PATH`, and Claude Code running
  inside herdr or tmux. Without a multiplexer `/popout side` opens the in-app
  pane instead.
- Mouse support in the in-app pane needs Claude Code's fullscreen layout.

## Install

From inside Claude Code:

```
/plugin marketplace add EmreErdogan/ccpopout
/plugin install ccpopout@ccpopout
```

Or from a shell:

```sh
claude plugin marketplace add EmreErdogan/ccpopout
claude plugin install ccpopout@ccpopout
```

If a session that was already open answers `Unknown command: /popout`, run
`/reload-plugins` there, or start a new session.

### Update

From inside Claude Code, refresh the marketplace and then update the plugin
from the `/plugin` menu:

```
/plugin marketplace update ccpopout
```

Or from a shell:

```sh
claude plugin marketplace update ccpopout
claude plugin update ccpopout@ccpopout
```

If an open session still shows the old version, run `/reload-plugins` there,
or start a new session.

## Commands

| Command | What it does |
| --- | --- |
| `/popout` | Opens the in-app pane on your newest message. |
| `/popout side` | Opens the side pane in herdr or tmux. Beside Claude Code when the terminal is at least 140 columns wide, otherwise zoomed over it. |
| `/popout close` | Closes the side pane. |
| `/popout-side` | The same as `/popout side`, as a command of its own so a key can be bound to it. |

### Key bindings

A plugin cannot add key bindings for you. To open ccpopout with a key, add this
to `~/.claude/keybindings.json` (merge it with what is already there):

```json
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+x r": "command:popout",
        "ctrl+x t": "command:popout-side"
      }
    }
  ]
}
```

If the prompt box holds text when the in-app pane opens, Claude Code keeps the
keyboard at the prompt. Press `ctrl+x tab` to hand it to the pane.

## Keys

The cursor (`▌`) moves over the items of a turn: each reply of Claude's and
each tool call.

| | Side pane | In-app pane |
| --- | --- | --- |
| Older / newer message of yours | `p` / `n` | `p` / `n` |
| Show the whole message | `e` | `e` |
| Previous / next item | `↑` / `↓`, `shift+tab` / `tab` | `↑` / `↓` |
| Open / fold the item | `→` / `←`, `o`, `enter`, click | `o`, click |
| Copy the item | `c` | `c` |
| Scroll a row | `k` / `j`, wheel | `k` / `j`, wheel |
| Scroll a page | `u` / `d`, `PgUp` / `PgDn`, `space` | `u` / `d` |
| Top / bottom | `g` / `G` (`G` also follows new output) | |
| Open / fold every tool call | `a` / `A` | `a` (toggles) |
| Open / fold the diffs | `f` / `F` | `f` (toggles) |
| Open / fold the Bash output | `b` / `B` | `b` (toggles) |
| Open / fold Claude's replies | `r` / `R` | `r` (toggles) |
| Clean view: hide the tool calls | `z` | `z` |
| Mouse off / on, to select text | `m` | |
| Help | `?` or `h` | `h` |
| Close | `q` or `esc` | `q` or `esc` |

The in-app pane has fewer keys because Claude Code lets a plugin bind only
single lowercase letters there.

Copying an item puts on the clipboard: a reply as Claude wrote it (Markdown), a
Bash call as its command and output, an edit as a unified diff. The side pane
copies with the OSC 52 escape sequence, which your terminal and multiplexer
must allow.

## Notes and limits

- The side pane reads the session's transcript file under
  `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`). It never writes to it.
- A session opened with `--resume` has its history in memory until your next
  message. For that case the plugin hands the side pane a snapshot of the
  conversation in a temporary file in the Claude config directory, which the
  side pane deletes as soon as it has read it.
- After `/clear` or anything else that gives the session a new id, close the
  side pane and open it again.
- Conversations rewound to an earlier point show the abandoned branches too.
- Colors assume a dark terminal theme.
- No syntax highlighting.

## Development

The plugin is a Claude Code hooks module (`hooks/register.tsx`) plus a
dependency-free Node program (`tui/popout.mjs`).

Clone the repository into `~/.claude/skills/ccpopout/`: Claude Code loads
plugins from there in every session and reloads them when a file changes. Do
not also install the marketplace copy, or both will load.

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .   # after Claude Code has loaded the plugin once
```

`tsconfig.json` extends the API types Claude Code writes to
`.claude-plugin/types/` when it loads the plugin; that folder is not in the
repository.

The side pane runs on its own against any transcript:

```sh
node tui/popout.mjs ~/.claude/projects/<project>/<session-id>.jsonl
```

## License

MIT
