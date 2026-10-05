import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, ToolUseSummary } from 'claude-code'
import type { SidePane } from '../types'

const turnIndex = atom({ plugin: 'ccpopout', key: 'turnIndex' } as const, 0)
const isPromptExpanded = atom({ plugin: 'ccpopout', key: 'isPromptExpanded' } as const, false)
const scrollRows = atom({ plugin: 'ccpopout', key: 'scrollRows' } as const, 0)
/** The item under the cursor: its place among the turn's replies and tool calls. */
const cursorItem = atom({ plugin: 'ccpopout', key: 'cursorItem' } as const, 0)
/** A line in the rule for a moment: what `c` copied. */
const notice = atom({ plugin: 'ccpopout', key: 'notice' } as const, '')
/** The clean view of the turns: tool calls hidden, Claude's words alone. */
const isClean = atom({ plugin: 'ccpopout', key: 'isClean' } as const, false)
const isHelpShown = atom({ plugin: 'ccpopout', key: 'isHelpShown' } as const, false)
const turnOpen = { plugin: 'ccpopout', key: 'turnOpen' } as const
const sidePane = atom({ plugin: 'ccpopout', key: 'sidePane' } as const, null as SidePane | null)

const PANE = 'popout'
const MAX_TEXT = 20000
/** Most lines one unfolded tool result shows; the rest is counted, not drawn. */
const MAX_BODY_LINES = 300
/** The pane's wanted height; the layout grants what it spares (a third, fullscreen). */
const WANTED_ROWS = 200
const HEADER_BG = 'userMessageBackground'
/** The color of a tool call's mark and name. */
const TOOL_COLOR = 'blue'
/** Nav row, prompt row, rule: the rows above the scrolling window. */
const HEADER_ROWS = 3
/** Most rows of the message a docked pane's header shows; `e` shows it whole. */
const TITLE_ROWS = 3
/** Below this many rows a pane's header keeps to one row of the message. */
const ROOMY_ROWS = 16
/** The turns program a multiplexer's pane runs, under the plugin's root. */
const TUI = 'tui/popout.mjs'
/** From this many columns the side pane splits off to the right; below, it opens zoomed. */
const WIDE_COLUMNS = 140

/**
 * The scroll bounds of the turn last drawn, for the handlers that move
 * `scrollRows`: a cache the next draw refreshes, so a reload loses nothing.
 */
let maxScroll = 0
let windowRows = 10
/** Of the turn last drawn: each item's first and last row, and the row the window starts at. */
let itemRows: { item: number; first: number; last: number }[] = []
let drawnScroll = 0
/** The cells left of the turn's rows, where the cursor's bar is drawn. */
const GUTTER = 2
/** The cell at the right edge, where the scroll bar is drawn. */
const BAR = 1
/**
 * Where the engine's own window over the pane's tree is held: one row down,
 * so it has a row to move to either way and reports every wheel tick and
 * arrow as `ui.scroll`. The pane turns those into moves of `scrollRows`.
 */
const PIN = 1
/** True while the pane itself moves the engine's window to PIN: no scroll meant. */
let isPinning = false

type Patch = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]

function countPatch(patch: Patch | undefined): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of patch ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function lineCount(text: string | undefined): number {
  const trimmed = (text ?? '').trimEnd()
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

/** The one-line summary for a result, or undefined to leave it to the engine. */
function summarize(tool: string, output: unknown): string | undefined {
  if (output === null || typeof output !== 'object') return undefined
  const out = output as Record<string, unknown>

  if (tool === 'Edit' || tool === 'Write') {
    const { added, removed } = countPatch(out.structuredPatch as Patch | undefined)
    if (tool === 'Write' && out.type === 'create') {
      return `new file · ${lineCount(out.content as string)} lines`
    }
    if (added === 0 && removed === 0) return undefined
    return `+${added} −${removed}`
  }

  if (tool === 'Bash') {
    if (out.backgroundTaskId !== undefined || out.isImage === true) return undefined
    const stdout = lineCount(out.stdout as string)
    const stderr = lineCount(out.stderr as string)
    if (stdout + stderr === 0) return undefined
    const parts = [`${stdout} lines`]
    if (stderr > 0) parts.push(`${stderr} stderr`)
    if (out.interrupted === true) parts.push('interrupted')
    return parts.join(' · ')
  }

  return undefined
}

/** Text safe for Code and Markdown: no escapes or control characters, bounded. */
function clean(text: string, max = MAX_TEXT): string {
  const plain = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}\n… (${plain.length - max} more characters)` : plain
}

/** A person's prompt with the engine's tagged blocks taken out; '' for none. */
function promptText(message: SessionMessage): string {
  if (message.role !== 'user' || (message.toolResults?.length ?? 0) > 0) return ''
  return message.text.replace(/<([a-z][a-z0-9-]*)>[\s\S]*?<\/\1>/g, '').trim()
}

function shortPath(path: unknown): string {
  if (typeof path !== 'string') return ''
  const parts = path.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : path
}

function callLabel(use: ToolUseSummary): string {
  const input = use.input
  let arg = ''
  if (use.tool === 'Bash') arg = String(input.command ?? '').split('\n')[0] ?? ''
  else if ('file_path' in input) arg = shortPath(input.file_path)
  else if ('pattern' in input) arg = String(input.pattern)
  else if ('path' in input) arg = shortPath(input.path)
  if (arg.length > 60) arg = `${arg.slice(0, 59)}…`
  return arg === '' ? use.tool : `${use.tool}(${arg})`
}

/** One row of the pane's body: exactly one terminal row when drawn. */
type Line = {
  text: string
  color?: string
  isDim?: boolean
  isBold?: boolean
  /**
   * On a tool call's row: its mark and the tool's name, drawn in the tool
   * color before `text` (the argument and summary), apart from Claude's prose.
   */
  head?: string
  /** Which of the turn's items (a reply, a tool call) the row belongs to. */
  item?: number
  /** Set on a tool call's summary row that folds: pressing it toggles the call. */
  call?: { id: string; isUnfolded: boolean; kind: CallKind }
}

/** What the fold keys group a row under: a file's diff, a shell run, another call, or a reply of Claude's. */
type CallKind = 'diff' | 'bash' | 'other' | 'text'

function callKind(tool: string): CallKind {
  return tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit' ? 'diff' : tool === 'Bash' ? 'bash' : 'other'
}

/** The pane's keys, as its help lists them: a Button's hotkey is one lowercase letter. */
const HELP: [string, [string, string][]][] = [
  ['Messages', [
    ['p   n', 'older, newer message of yours'],
    ['e', 'show or hide the whole message'],
  ]],
  ['Items (Claude\'s replies and tool calls)', [
    ['↑   ↓', 'previous, next item'],
    ['o', 'open or fold the item'],
    ['c', 'copy the item (a call: its command or diff, and output)'],
    ['click', 'pick a call, and open or fold it'],
  ]],
  ['Scrolling', [
    ['k   j', 'one row up, down'],
    ['u   d', 'one page up, down'],
    ['wheel', 'scrolls'],
  ]],
  ['All at once', [
    ['a', 'tool calls: fold all when any is open, else open all (errors too)'],
    ['f', 'the same for the diffs (Edit, Write)'],
    ['b', 'the same for the Bash output'],
    ['r', 'the same for Claude\'s replies'],
    ['z', 'clean view: hide the tool calls, or show them again'],
  ]],
  ['Other', [
    ['h', 'this help'],
    ['q  esc', 'close (over the help: back to the turn)'],
  ]],
]

function helpLines(width: number): Line[] {
  const keys = Math.max(...HELP.flatMap(([, items]) => items.map(([key]) => key.length)))
  const lines: Line[] = []
  for (const [title, items] of HELP) {
    if (lines.length > 0) lines.push({ text: '' })
    lines.push({ text: title, isBold: true })
    for (const [key, text] of items) {
      const rows = wrapWords(text, Math.max(10, width - keys - 5))
      rows.forEach((row, at) => lines.push({ text: `  ${(at === 0 ? key : '').padEnd(keys)}   ${row}` }))
    }
  }
  return lines
}

/** Splits text into rows of at most `width` cells, breaking long lines hard. */
function wrapRows(text: string, width: number): string[] {
  const rows: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') rows.push('')
    for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width))
  }
  return rows
}

/** Wraps one line at word boundaries, continuation rows under its indent. */
function wrapWords(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const indent = (/^(\s*(?:[-*•]\s+|\d+\.\s+)?)/.exec(line)?.[1] ?? '').replace(/\S/g, ' ').slice(0, width >> 1)
  const rows: string[] = []
  let row = ''
  for (const word of line.split(/(?<=\s)/)) {
    if (row.length + word.trimEnd().length > width && row.trim() !== '') {
      rows.push(row.trimEnd())
      row = indent
    }
    row += word
    while (row.trimEnd().length > width) {
      rows.push(row.slice(0, width))
      row = indent + row.slice(width)
    }
  }
  if (row.trim() !== '') rows.push(row.trimEnd())
  return rows
}

/** An assistant reply as rows: headings bold, code fences dim, the rest plain. */
function proseLines(markdown: string, width: number): Line[] {
  const lines: Line[] = []
  let isFenced = false
  for (const raw of clean(markdown).split('\n')) {
    if (/^\s*```/.test(raw)) {
      isFenced = !isFenced
      continue
    }
    if (isFenced) {
      for (const row of wrapRows(raw, width - 2)) lines.push({ text: `  ${row}`, color: 'cyan' })
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw)
    const text = (heading?.[1] ?? raw).replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    if (text.trim() === '') {
      if (lines.at(-1)?.text !== '') lines.push({ text: '' })
      continue
    }
    for (const row of wrapWords(text, width)) lines.push({ text: row, isBold: heading !== null })
  }
  while (lines.at(-1)?.text === '') lines.pop()
  return lines
}

/** A tool call as rows: its summary, and beneath it the result when unfolded. */
function callLines(use: ToolUseSummary, stored: boolean | undefined, width: number): Line[] {
  const label = callLabel(use)
  const rest = label.slice(use.tool.length)
  const call = (isUnfolded: boolean) => ({ id: use.tool_use_id, isUnfolded, kind: callKind(use.tool) })
  if (use.isError) {
    const isUnfolded = stored ?? true
    const rows = isUnfolded ? wrapRows(clean(use.text ?? 'failed'), width - 2) : []
    return [
      { head: `${isUnfolded ? '▾' : '▸'} ${use.tool}`, text: `${rest} · error`, color: 'red', call: call(isUnfolded) },
      ...capped(rows.map(row => ({ text: `  ${row}`, color: 'red' }))),
    ]
  }
  if (use.result === undefined && use.text === undefined) return [{ head: `• ${use.tool}`, text: `${rest} · running…`, isDim: true }]

  const out = (use.result ?? {}) as Record<string, unknown>
  let summary: string
  let body: Line[] = []
  if (use.tool === 'Edit' || use.tool === 'Write') {
    summary = summarize(use.tool, out) ?? 'no change'
    const patch = (out.structuredPatch as Patch | undefined) ?? []
    for (const hunk of patch) {
      body.push({ text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, isDim: true })
      for (const line of hunk.lines) {
        const color = line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined
        for (const row of wrapRows(clean(line), width - 2)) body.push({ text: `  ${row}`, color, isDim: color === undefined })
      }
    }
    if (patch.length === 0 && typeof out.content === 'string') {
      body = wrapRows(clean(out.content), width - 2).map(row => ({ text: `  ${row}`, color: 'green' }))
    }
  } else if (use.tool === 'Bash') {
    summary = summarize('Bash', out) ?? 'no output'
    const text = [out.stdout, out.stderr].filter(part => typeof part === 'string' && part.trim() !== '').join('\n')
    if (text !== '') body = wrapRows(clean(text).trimEnd(), width - 2).map(row => ({ text: `  ${row}`, isDim: true }))
  } else {
    const text = clean(use.text ?? '').trim()
    const count = lineCount(text)
    summary = count <= 1 ? 'done' : `${count} lines`
    if (text !== '') body = wrapRows(text, width - 2).map(row => ({ text: `  ${row}`, isDim: true }))
  }

  if (body.length === 0) return [{ head: `• ${use.tool}`, text: `${rest} · ${summary}`, isDim: true }]
  const isUnfolded = stored ?? false
  return [
    { head: `${isUnfolded ? '▾' : '▸'} ${use.tool}`, text: `${rest} · ${summary}`, call: call(isUnfolded) },
    ...(isUnfolded ? capped(body) : []),
  ]
}

/** The row the clean view draws for a run of tool calls: how many, of which tools. */
function hiddenLine(uses: ToolUseSummary[], width: number): Line {
  const counts = new Map<string, number>()
  for (const use of uses) counts.set(use.tool, (counts.get(use.tool) ?? 0) + 1)
  const tools = [...counts].map(([tool, count]) => (count === 1 ? tool : `${count} ${tool}`)).join(', ')
  const errors = uses.filter(use => use.isError).length
  const tail = errors === 0 ? '' : ` · ${errors} ${errors === 1 ? 'error' : 'errors'}`
  const text = `⋯ ${uses.length} tool ${uses.length === 1 ? 'call' : 'calls'} · ${tools}`
  const room = Math.max(8, width - tail.length)
  return { text: `${text.length > room ? `${text.slice(0, room - 1)}…` : text}${tail}`, isDim: true }
}

function capped(lines: Line[]): Line[] {
  if (lines.length <= MAX_BODY_LINES) return lines
  return [...lines.slice(0, MAX_BODY_LINES), { text: `  … ${lines.length - MAX_BODY_LINES} more lines`, isDim: true }]
}

/** `scrollRows` moved by `by` rows, kept inside the turn last drawn. */
function scrolledBy(was: number, by: number): number {
  return Math.max(0, Math.min(maxScroll, Math.min(was, maxScroll) + by))
}

/** Keeps the open pane current as the conversation grows. */
async function refresh($: EngineInterface): Promise<void> {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) $.ui.invalidate('ui.render')
}

const PANE_ARGS = {
  id: PANE,
  title: 'Popout',
  focus: true,
  closeOnEscape: true,
  holdToasts: true,
  rows: WANTED_ROWS,
  columns: 100,
} as const

/**
 * Takes the keyboard back for the pane after an Escape it refused to close
 * on: Escape hands the keys to the prompt either way, a moment after.
 */
async function refocus($: EngineInterface): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await $.clock.sleep(40)
    await $.ui.open(PANE_ARGS)
    const moved = await $.ui.focus({ requestId: PANE, key: 'help' }).catch(() => ({ deny: 'failed' }))
    if (!('deny' in moved)) return
  }
}

/** A reply or a call as plain text for the clipboard: prose as written, a call with its result. */
function copyText(entry: string | ToolUseSummary): string {
  if (typeof entry === 'string') return entry
  const out = (entry.result !== null && typeof entry.result === 'object' ? entry.result : {}) as Record<string, unknown>
  const input = entry.input as Record<string, unknown>
  if (entry.tool === 'Bash') {
    const streams = [out.stdout, out.stderr].filter(part => typeof part === 'string' && part.trim() !== '').join('\n')
    return `$ ${String(input.command ?? '')}\n${entry.isError || streams === '' ? (entry.text ?? '') : streams}`.trimEnd()
  }
  const patch = (out.structuredPatch as Patch | undefined) ?? []
  if (patch.length > 0) {
    const file = String(out.filePath ?? input.file_path ?? '')
    const hunks = patch.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`)
    return `--- ${file}\n+++ ${file}\n${hunks.join('\n')}`
  }
  if (typeof out.content === 'string' && !entry.isError) return out.content
  return `${callLabel(entry)}\n${entry.text ?? ''}`.trimEnd()
}

/** Shows `text` in the pane's rule for two seconds. */
async function flash($: EngineInterface, text: string): Promise<void> {
  await update($, notice, () => text)
  await $.clock.sleep(2000)
  await update($, notice, was => (was === text ? '' : was))
}

/**
 * Moves the cursor an item up or down the turn last drawn, the window after
 * it: whole into view when the item fits, else its top.
 */
async function moveCursor($: EngineInterface, step: number): Promise<void> {
  if (itemRows.length === 0) return
  const cursor = await read($, cursorItem)
  const isShown = (rows: { first: number; last: number }) => rows.last >= drawnScroll && rows.first < drawnScroll + windowRows
  let at = itemRows.findIndex(rows => rows.item === cursor)
  if (at === -1 || !isShown(itemRows[at] as { first: number; last: number })) {
    // Scrolled out of sight: the cursor comes to what is on screen.
    const shown = itemRows.filter(isShown)
    const near = step > 0 ? shown[0] : shown.at(-1)
    if (near !== undefined) at = itemRows.indexOf(near)
    else at = Math.max(0, at)
  } else if (at + step < 0 || at + step >= itemRows.length) {
    // At either end the window still moves, so the first and last rows are reached.
    await update($, scrollRows, was => scrolledBy(was, step))
    return
  } else at += step
  const to = itemRows[at]
  if (to === undefined) return
  await update($, cursorItem, () => to.item)
  if (to.first < drawnScroll) await update($, scrollRows, () => to.first)
  else if (to.last >= drawnScroll + windowRows) await update($, scrollRows, () => Math.min(maxScroll, Math.min(to.first, to.last - windowRows + 1)))
}

/** Opens the pane inside Claude Code, at its newest turn. */
async function openInnerPane($: EngineInterface): Promise<void> {
  await update($, turnIndex, () => 0)
  await update($, isPromptExpanded, () => false)
  await update($, scrollRows, () => 0)
  await update($, cursorItem, () => 0)
  await update($, isHelpShown, () => false)
  const opened = await $.ui.open(PANE_ARGS)
  if (!opened.isPlaced) $.ui.toast(`popout: ${opened.reason}`)
  // The pane's elements are drawn a moment after it opens; until then the
  // scroll has nothing to land on and is refused.
  isPinning = true
  for (let attempt = 0; attempt < 20; attempt++) {
    const moved = await $.ui.scroll({ in: PANE, to: { key: 'older' }, block: 'start' }).catch(() => ({ deny: 'failed' }))
    if (!('deny' in moved)) break
    await $.clock.sleep(50)
  }
  isPinning = false
}

/** A command's output when it ran and exited 0; undefined otherwise. */
async function stdoutOf($: EngineInterface, argv: readonly string[]): Promise<string | undefined> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 10000 })
    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

/** One argument quoted for the shell `herdr pane run` types into. */
function quoted(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

async function herdrBin($: EngineInterface): Promise<string> {
  return (await $.env.get('HERDR_BIN_PATH')) ?? 'herdr'
}

async function isSidePaneAlive($: EngineInterface, pane: SidePane): Promise<boolean> {
  if (pane.mux === 'herdr') return (await stdoutOf($, [await herdrBin($), 'pane', 'get', pane.id])) !== undefined
  const panes = await stdoutOf($, ['tmux', 'list-panes', '-a', '-F', '#{pane_id}'])
  return panes?.split('\n').includes(pane.id) ?? false
}

/** Closes the side pane this session opened; false when there was none. */
async function closeSidePane($: EngineInterface): Promise<boolean> {
  const pane = await read($, sidePane)
  if (pane === null) return false
  await update($, sidePane, () => null)
  if (!(await isSidePaneAlive($, pane))) return false
  const argv = pane.mux === 'herdr' ? [await herdrBin($), 'pane', 'close', pane.id] : ['tmux', 'kill-pane', '-t', pane.id]
  return (await stdoutOf($, argv)) !== undefined
}

/**
 * Opens the popout program in a pane of the terminal multiplexer this session
 * runs in: beside Claude Code where there is room, zoomed over it otherwise.
 *
 * @returns '' once it is open (or was, and now has focus), 'none' where there
 *          is no multiplexer, else what went wrong
 */
async function openSidePane($: EngineInterface): Promise<string> {
  const open = await read($, sidePane)
  if (open !== null && (await isSidePaneAlive($, open))) {
    if (open.mux === 'tmux') await stdoutOf($, ['tmux', 'select-pane', '-t', open.id])
    else await stdoutOf($, [await herdrBin($), 'pane', 'focus', '--direction', open.direction, '--pane', open.from])
    return ''
  }

  const isHerdr = (await $.env.get('HERDR_ENV')) === '1'
  const isTmux = ((await $.env.get('TMUX')) ?? '') !== ''
  if (!isHerdr && !isTmux) return 'none'

  const node = (await stdoutOf($, ['node', '-p', 'process.execPath']))?.trim()
  if (node === undefined || node === '') return 'node was not found on PATH'
  const cwd = await $.session.cwd()
  const session = await $.session.id()
  const program = [node, `${$.plugin.root}/${TUI}`, '--session', session, '--cwd', cwd]
  if (await read($, isClean)) program.push('--clean')
  // A session just resumed holds its history in memory, its file empty until
  // the next message: the program starts from this snapshot, and removes it.
  try {
    const home = await $.env.get('HOME')
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
    if (config !== undefined) {
      const snapshot = `${config}/ccpopout-snapshot-${session}.json`
      await $.fs.write(snapshot, JSON.stringify(await $.session.messages()))
      program.push('--snapshot', snapshot)
    }
  } catch {}

  if (isHerdr) {
    const herdr = await herdrBin($)
    const from = await $.env.get('HERDR_PANE_ID')
    if (from === undefined) return 'HERDR_PANE_ID is not set'
    let columns = 0
    try {
      const layout = JSON.parse((await stdoutOf($, [herdr, 'pane', 'layout', '--pane', from])) ?? '{}')
      const panes: { pane_id: string; rect: { width: number } }[] = layout.result?.layout?.panes ?? []
      columns = panes.find(pane => pane.pane_id === from)?.rect.width ?? 0
    } catch {}
    const direction = columns >= WIDE_COLUMNS ? 'right' : 'down'

    const split = await stdoutOf($, [herdr, 'pane', 'split', from, '--direction', direction, '--ratio', '0.5', '--cwd', cwd, '--focus'])
    let id: unknown
    try {
      id = JSON.parse(split ?? '{}').result?.pane?.pane_id
    } catch {}
    if (typeof id !== 'string') return 'herdr could not split the pane'
    // `exec`: the pane's shell becomes the program, so the pane closes with it.
    const started = await stdoutOf($, [herdr, 'pane', 'run', id, ` exec ${program.map(quoted).join(' ')}`])
    if (started === undefined) {
      await stdoutOf($, [herdr, 'pane', 'close', id])
      return 'herdr could not start the program'
    }
    if (direction === 'down') await stdoutOf($, [herdr, 'pane', 'zoom', id, '--on'])
    const pane: SidePane = { mux: 'herdr', id, from, direction }
    await update($, sidePane, () => pane)
    return ''
  }

  const from = (await $.env.get('TMUX_PANE')) ?? ''
  const target = from === '' ? [] : ['-t', from]
  const columns = Number((await stdoutOf($, ['tmux', 'display-message', '-p', ...target, '#{pane_width}']))?.trim() ?? 0)
  const direction = columns >= WIDE_COLUMNS ? 'right' : 'down'
  const split = await stdoutOf($, [
    'tmux', 'split-window', direction === 'right' ? '-h' : '-v', '-P', '-F', '#{pane_id}', '-c', cwd, ...target, ...program,
  ])
  const id = split?.trim() ?? ''
  if (id === '') return 'tmux could not split the pane'
  if (direction === 'down') await stdoutOf($, ['tmux', 'resize-pane', '-Z', '-t', id])
  const pane: SidePane = { mux: 'tmux', id, from, direction }
  await update($, sidePane, () => pane)
  return ''
}

/** `/popout side`: the side pane, or the pane inside where no multiplexer is. */
async function showSidePane($: EngineInterface): Promise<void> {
  const failure = await openSidePane($)
  if (failure === '') return
  $.ui.toast(failure === 'none' ? 'popout: no herdr or tmux here, opened inside instead' : `popout: ${failure}, opened inside instead`)
  await openInnerPane($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'popout',
      description: 'Read the session: what Claude did since each of your messages',
      argumentHint: '[side|close]',
      immediate: true,
    })
    // `/popout side` under a name of its own: a key binds to a command, not to
    // its arguments.
    await $.command.register({
      name: 'popout-side',
      description: 'Read the session in a herdr or tmux pane beside Claude Code',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'popout' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'side') await showSidePane($)
    else if (arg === 'close') {
      if (!(await closeSidePane($))) $.ui.toast('popout: no side pane is open')
    } else if (arg !== '') return { text: `Usage: /popout [side|close] (got "${e.args.trim()}")` }
    else await openInnerPane($)
    return {}
  })

  on('command.run', { command: 'popout-side' }, async $ => {
    await showSidePane($)
    return {}
  })

  // Escape (or the close mark) over the help returns to the turn; the next closes.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person' || !(await read($, isHelpShown))) return next(e)
    await update($, isHelpShown, () => false)
    await update($, scrollRows, () => 0)
    void refocus($)
    return { value: undefined }
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // An arrow (a row, from the keys: no pointer) moves the cursor over the
    // turn's items; the wheel and the page keys move the window.
    const isArrow = e.origin.kind === 'person' && e.pointer === undefined && Math.abs(e.by) === 1
    if (isPinning) return next({ ...e, offset: PIN })
    if (isArrow && !(await read($, isHelpShown))) await moveCursor($, e.by)
    else await update($, scrollRows, was => scrolledBy(was, e.by))
    return next({ ...e, offset: PIN })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await refresh($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    // An inline pane is only as tall as its tree, up to the layout's cap, so the
    // tree asks for a whole screen and draws into the rows it was granted. The
    // rest is blank and never shown: the drawing starts PIN rows down, where
    // `ui.scroll` holds the engine's window.
    const screenRows = Math.max(HEADER_ROWS + 3, e.props.scroll.bodyRows)
    const treeRows = Math.max(screenRows + 2 * PIN, e.viewport?.rows ?? 0)
    const messages = await $.session.messages()

    const prompts: number[] = []
    messages.forEach((message, at) => {
      if (promptText(message) !== '') prompts.push(at)
    })
    if (prompts.length === 0) return <Text dimColor>No messages yet.</Text>

    const index = Math.min(await read($, turnIndex), prompts.length - 1)
    const start = prompts[prompts.length - 1 - index] ?? 0
    const end = prompts[prompts.length - index] ?? messages.length
    const prompt = clean(promptText(messages[start] as SessionMessage))
    const isExpanded = await read($, isPromptExpanded)

    // The body, one entry per terminal row, so the window over it is exact.
    // Two cells on the left are the cursor's: the bar beside the item it is on.
    const inner = width - GUTTER - BAR
    const lines: Line[] = []
    /** The turn's items in order: a reply's text, or a tool call. */
    const items: (string | ToolUseSummary)[] = []
    if (isExpanded) {
      for (const row of prompt.split('\n').flatMap(line => wrapWords(line, inner))) lines.push({ text: row, isBold: true })
      lines.push({ text: '─'.repeat(inner), isDim: true })
    }
    // The clean view leaves Claude's words alone: each run of tool calls
    // between them is one row saying how many there were.
    const isCleanView = await read($, isClean)
    let hidden: ToolUseSummary[] = []
    const flush = () => {
      if (hidden.length > 0) lines.push(hiddenLine(hidden, inner))
      hidden = []
    }
    for (const message of messages.slice(start + 1, end)) {
      if (message.role !== 'assistant') continue
      if (message.text.trim() !== '') {
        flush()
        if (lines.length > 0 && lines.at(-1)?.text !== '') lines.push({ text: '' })
        const item = items.push(message.text) - 1
        // Claude's own words: a bullet on the first row, the rest under it.
        // A reply of several rows folds to its first, as a call does.
        const prose = proseLines(message.text, inner - 2)
        const id = `text:${start}:${item}`
        const isUnfolded = (await read($, { ...turnOpen, id })) ?? true
        // Folded, its first rows of text stay (two where there is height), the
        // last saying how much there is.
        const foldedRows = e.props.placement === 'dock' && screenRows >= ROOMY_ROWS ? 2 : 1
        const fold = prose.length > foldedRows ? { id, isUnfolded, kind: 'text' as const } : undefined
        if (fold !== undefined && !isUnfolded) {
          const kept = prose.filter(line => line.text !== '').slice(0, foldedRows)
          const tail = ` · ${prose.length} lines`
          const room = Math.max(8, inner - 2 - tail.length)
          kept.forEach((line, at) => {
            const isLast = at === kept.length - 1
            const text = isLast ? `${line.text.length > room ? `${line.text.slice(0, room - 1)}…` : line.text}${tail}` : line.text
            if (at === 0) lines.push({ head: '▸ ', text, item, call: fold })
            else lines.push({ ...line, text: `  ${text}`, item })
          })
        } else {
          prose.forEach((line, at) => {
            lines.push({ ...line, item, call: at === 0 ? fold : undefined, text: line.text === '' ? '' : `${at === 0 ? '●' : ' '} ${line.text}` })
          })
        }
        lines.push({ text: '' })
      }
      for (const use of message.toolUses) {
        const item = items.push(use) - 1
        if (isCleanView) {
          hidden.push(use)
          continue
        }
        for (const line of callLines(use, await read($, { ...turnOpen, id: use.tool_use_id }), inner)) lines.push({ ...line, item })
      }
    }
    flush()
    while (lines.at(-1)?.text === '') lines.pop()
    if (lines.length === 0) lines.push({ text: 'Claude has not answered this message yet.', isDim: true })

    const calls = lines.flatMap(line => (line.call === undefined ? [] : [line.call]))
    const hasCalls = calls.some(call => call.kind !== 'text')
    const cursor = Math.min(await read($, cursorItem), Math.max(0, items.length - 1))
    const cursorCall = lines.find(line => line.item === cursor && line.call !== undefined)?.call
    itemRows = []
    lines.forEach((line, at) => {
      if (line.item === undefined) return
      const rows = itemRows.at(-1)
      if (rows?.item === line.item) rows.last = at
      else itemRows.push({ item: line.item, first: at, last: at })
    })
    const isHelp = await read($, isHelpShown)
    if (isHelp) {
      lines.splice(0, lines.length, ...helpLines(inner))
      itemRows = []
    }

    // Which message, and how it starts: a row, or a few where there is height.
    const position = `${prompts.length - index}/${prompts.length} › `
    const titleAll = `${position}${prompt}`.split('\n').filter(line => line.trim() !== '').flatMap(line => wrapWords(line, width))
    const titleMost = !isExpanded && e.props.placement === 'dock' && screenRows >= ROOMY_ROWS ? TITLE_ROWS : 1
    let titles = titleAll.slice(0, titleMost)
    if (titleAll.length > titleMost && !isExpanded) {
      const last = titles[titleMost - 1] ?? ''
      titles[titleMost - 1] = `${last.length > width - 2 ? last.slice(0, width - 2) : last} …`
    }
    if (isHelp) titles = ['Keys · h, q or esc returns']

    // A blank row between the keys and the message, where there is height.
    const gapRows = e.props.placement === 'dock' && screenRows >= ROOMY_ROWS ? 1 : 0

    windowRows = screenRows - (HEADER_ROWS - 1 + gapRows + titles.length)
    maxScroll = Math.max(0, lines.length - windowRows)
    const scrolled = Math.min(await read($, scrollRows), maxScroll)
    drawnScroll = scrolled
    const shown = lines.slice(scrolled, scrolled + windowRows)

    const go = (to: number) => async () => {
      await update($, turnIndex, () => Math.max(0, Math.min(prompts.length - 1, to)))
      await update($, isPromptExpanded, () => false)
      await update($, scrollRows, () => 0)
      await update($, cursorItem, () => 0)
      await update($, isHelpShown, () => false)
    }
    const scroll = (by: number) => () => update($, scrollRows, was => scrolledBy(was, by))
    // One lowercase key each, so a key toggles: fold while any is open, else open.
    const foldAll = (kind?: CallKind) => async () => {
      const group = calls.filter(call => (kind === undefined ? call.kind !== 'text' : call.kind === kind))
      const isUnfolded = !group.some(call => call.isUnfolded)
      for (const call of group) await update($, { ...turnOpen, id: call.id }, () => isUnfolded)
    }
    const hasKind = (kind: CallKind) => calls.some(call => call.kind === kind)
    // Over a prompt box holding text the pane opens without the keyboard,
    // which only the person can then hand it.
    const flashed = await read($, notice)
    const hint = flashed !== '' ? `── ${flashed} ` : e.props.isFocused ? '' : '── ctrl+x tab: keys here '
    // How many rows there are above and below the window, or that it is at an end.
    const below = lines.length - scrolled - shown.length
    const range = maxScroll === 0 ? '' : ` ${scrolled === 0 ? 'top' : `↑ ${scrolled}`} · ${below <= 0 ? 'end' : `↓ ${below}`} `
    // The scroll bar: the window's share of the rows, at its place among them.
    const thumb = Math.max(1, Math.round((windowRows * windowRows) / Math.max(1, lines.length)))
    const thumbAt = maxScroll === 0 ? 0 : Math.round((scrolled / maxScroll) * (windowRows - thumb))
    const bar = (at: number) => (
      <Box width={BAR} flexShrink={0}>
        <Text color={at >= thumbAt && at < thumbAt + thumb ? 'cyan' : undefined} dimColor={at < thumbAt || at >= thumbAt + thumb}>
          {maxScroll === 0 ? ' ' : at >= thumbAt && at < thumbAt + thumb ? '┃' : '│'}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" width={width} height={treeRows}>
        <Box height={PIN} flexShrink={0} />
        <Box flexDirection="row" width={width} height={1} flexShrink={0} overflow="hidden" backgroundColor={HEADER_BG}>
          <Button key="older" hotkey="p" plain dimColor={index >= prompts.length - 1} onPress={go(index + 1)}>
            ◂
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="newer" hotkey="n" plain dimColor={index === 0} onPress={go(index - 1)}>
            ▸
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="expand" hotkey="e" plain onPress={async () => {
            await update($, isPromptExpanded, was => !was)
            await update($, scrollRows, () => 0)
          }}>
            {isExpanded ? 'collapse' : 'expand'}
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="help" hotkey="h" plain onPress={async () => {
            await update($, isHelpShown, was => !was)
            await update($, scrollRows, () => 0)
          }}>
            help
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="close" hotkey="q" plain onPress={async () => {
            if (!isHelp) return $.ui.close({ id: PANE })
            await update($, isHelpShown, () => false)
            await update($, scrollRows, () => 0)
          }}>
            close
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="toggleItem" hotkey="o" plain dimColor={cursorCall === undefined} onPress={async () => {
            if (cursorCall !== undefined) await update($, { ...turnOpen, id: cursorCall.id }, () => !cursorCall.isUnfolded)
          }}>
            {cursorCall?.isUnfolded === true ? 'fold' : 'open'}
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="copy" hotkey="c" plain dimColor={items.length === 0} onPress={async () => {
            const entry = items[cursor]
            if (entry === undefined || isHelp) return
            const text = copyText(entry)
            const copied = await $.ui.copy({ text, surface: e.surface })
            const count = text.split('\n').length
            void flash($, copied.isCopied ? `copied · ${count} ${count === 1 ? 'line' : 'lines'}` : 'could not copy')
          }}>
            copy
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="clean" hotkey="z" plain onPress={async () => {
            await update($, isClean, was => !was)
            // A cursor on a call now hidden comes to the reply after it, or the last.
            const replies = items.flatMap((entry, at) => (typeof entry === 'string' ? [at] : []))
            if (!isCleanView && typeof items[cursor] !== 'string') {
              await update($, cursorItem, () => replies.find(at => at > cursor) ?? replies.at(-1) ?? 0)
            }
          }}>
            {isCleanView ? 'full' : 'clean'}
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="foldAll" hotkey="a" plain dimColor={!hasCalls} onPress={foldAll()}>
            all
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="foldDiffs" hotkey="f" plain dimColor={!hasKind('diff')} onPress={foldAll('diff')}>
            diff
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="foldBash" hotkey="b" plain dimColor={!hasKind('bash')} onPress={foldAll('bash')}>
            bash
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="foldReplies" hotkey="r" plain dimColor={!hasKind('text')} onPress={foldAll('text')}>
            text
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="up" hotkey="k" plain dimColor={scrolled === 0} onPress={scroll(-1)}>
            ▲
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="down" hotkey="j" plain dimColor={scrolled >= maxScroll} onPress={scroll(1)}>
            ▼
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="pageUp" hotkey="u" plain dimColor={scrolled === 0} onPress={scroll(-(windowRows - 1))}>
            pg▲
          </Button>
          <Box width={2} flexShrink={0} backgroundColor={HEADER_BG} />
          <Button key="pageDown" hotkey="d" plain dimColor={scrolled >= maxScroll} onPress={scroll(windowRows - 1)}>
            pg▼
          </Button>
          <Box flexGrow={1} backgroundColor={HEADER_BG} />
        </Box>
        {gapRows === 1 ? <Box width={width} height={1} flexShrink={0} backgroundColor={HEADER_BG} /> : null}
        {titles.map(title => (
          <Box width={width} height={1} flexShrink={0} overflow="hidden" backgroundColor={HEADER_BG}>
            <Text bold backgroundColor={HEADER_BG} wrap="truncate-end">
              {title.length > width ? `${title.slice(0, width - 1)}…` : title.padEnd(width)}
            </Text>
          </Box>
        ))}
        <Box width={width} height={1} flexShrink={0} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {hint}
            {'─'.repeat(Math.max(0, width - hint.length - range.length - 2))}
            {range}
            {'──'}
          </Text>
        </Box>
        {shown.map((line, at) => {
          const head = line.head ?? ''
          const room = Math.max(1, inner - head.length)
          const text = line.text.length > room ? `${line.text.slice(0, room - 1)}…` : line.text
          const gutter = (
            <Text color="cyan" wrap="truncate-end">
              {!isHelp && line.item === cursor ? '▌ ' : '  '}
            </Text>
          )
          if (line.head === undefined) {
            return (
              <Box flexDirection="row" width={width} height={1} flexShrink={0} overflow="hidden">
                {gutter}
                <Box width={inner} flexShrink={0} overflow="hidden">
                  <Text color={line.color} dimColor={line.isDim} bold={line.isBold} wrap="truncate-end">
                    {line.text === '' ? ' ' : line.text}
                  </Text>
                </Box>
                {bar(at)}
              </Box>
            )
          }
          // A Button takes no color: the mark and name are a Text before it,
          // and the press target is the rest of the row.
          return (
            <Box flexDirection="row" width={width} height={1} flexShrink={0} overflow="hidden">
              {gutter}
              <Text color={line.call?.kind === 'text' ? undefined : (line.color ?? TOOL_COLOR)} bold={line.call?.kind === 'text' || line.call?.isUnfolded === true} wrap="truncate-end">
                {head}
              </Text>
              {line.call === undefined ? (
                <Text dimColor wrap="truncate-end">
                  {text}
                </Text>
              ) : (
                <Button
                  key={`call:${line.call.id}`}
                  label={text}
                  plain
                  dimColor={!line.call.isUnfolded && line.call.kind !== 'text'}
                  onPress={((call, item) => async () => {
                    if (item !== undefined) await update($, cursorItem, () => item)
                    await update($, { ...turnOpen, id: call.id }, () => !call.isUnfolded)
                  })(line.call, line.item)}
                />
              )}
              <Box flexGrow={1} />
              {bar(at)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
