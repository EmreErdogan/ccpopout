import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const PATCH = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' ctx', '-a', '+b', '+c'] }]

const EDIT_OUTPUT = {
  filePath: '/x/a.ts',
  oldString: 'a',
  newString: 'b',
  originalFile: 'a\n',
  structuredPatch: PATCH,
  userModified: false,
  replaceAll: false,
}

/** The command.run input a person typing `/<command> <args>` raises. */
const typed = (command: string, args = '') =>
  ({ command, args, origin: { kind: 'composer' } }) as never

const CONVERSATION: SessionMessage[] = [
  { role: 'user', text: '<system-reminder>ignored</system-reminder>first question', toolUses: [] },
  { role: 'assistant', text: 'First answer.', toolUses: [] },
  { role: 'user', text: 'second question\nwith a second line', toolUses: [] },
  {
    role: 'assistant',
    text: 'Editing now.',
    toolUses: [
      { tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/x/a.ts' }, result: EDIT_OUTPUT, text: 'ok' },
      {
        tool_use_id: 'b1',
        tool: 'Bash',
        input: { command: 'npm test' },
        result: { stdout: 'line 1\nline 2\nALL PASSED', stderr: '', interrupted: false },
        text: 'ALL PASSED',
      },
      { tool_use_id: 'b2', tool: 'Bash', input: { command: 'false' }, text: 'BOOM', isError: true },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e1', text: 'ok' }] as never },
  { role: 'assistant', text: 'Done editing.', toolUses: [] },
]

const PANE = {
  plugin: 'ccpopout',
  component: 'Pane' as const,
  requestId: 'popout',
  props: {
    title: 'Popout',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

test('the pane shows the latest turn folded and pages to older ones', async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  on('ui.scroll', () => ({}))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Latest prompt in the header (a docked pane shows its first rows; one
    // above the prompt, its first alone), its answer below, tool rows folded.
    expect(await ui.find({ text: /second question/ })).toBeDefined()
    expect(await ui.find({ text: /with a second line/ })).toBeDefined()
    expect(await ui.find({ text: /2\/2/ })).toBeDefined()
    expect(await ui.find({ text: /Editing now/ })).toBeDefined()
    expect(await ui.find({ text: /Done editing/ })).toBeDefined()
    expect((await ui.find({ key: 'call:e1' }))?.text).toContain('+2 −1')
    expect((await ui.find({ key: 'call:b1' }))?.text).toContain('3 lines')
    expect(await ui.find({ text: /ALL PASSED/ })).toBeUndefined()

    // An error shows unfolded.
    expect(await ui.find({ text: /BOOM/ })).toBeDefined()

    // A tool row unfolds and folds on press.
    await ui.press({ key: 'call:b1' })
    expect(await ui.find({ text: /ALL PASSED/ })).toBeDefined()
    await ui.press({ key: 'call:b1' })
    expect(await ui.find({ text: /ALL PASSED/ })).toBeUndefined()

    // The prompt expands to every line.
    await ui.press({ key: 'expand' })
    expect(await ui.find({ text: /with a second line/ })).toBeDefined()

    // Older goes to the first turn and folds the prompt again; newer comes back.
    await ui.press({ key: 'older' })
    expect(await ui.find({ text: /first question/ })).toBeDefined()
    expect(await ui.find({ text: /ignored/ })).toBeUndefined()
    expect(await ui.find({ text: /First answer/ })).toBeDefined()
    expect(await ui.find({ text: /Editing now/ })).toBeUndefined()
    expect(await ui.find({ text: /1\/2/ })).toBeDefined()

    await ui.press({ key: 'older' })
    expect(await ui.find({ text: /1\/2/ })).toBeDefined()

    await ui.press({ key: 'newer' })
    expect(await ui.find({ text: /Editing now/ })).toBeDefined()
    await ui.unmount()

    const inline = await $.ui.mount({ ...PANE, surface, requestId: 'popout', props: { ...PANE.props, placement: 'inline' as const } })
    expect(await inline.find({ text: /second question …/ })).toBeDefined()
    expect(await inline.find({ text: /with a second line/ })).toBeUndefined()
    await inline.unmount()
  }
})

test('the pane keeps its header and scrolls the body beneath it', async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  on('ui.scroll', () => ({}))

  for (const surface of SURFACES) {
    // Six rows: three of header, three of body.
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } } })
    expect(await ui.find({ text: /Editing now/ })).toBeDefined()
    expect(await ui.find({ text: /Done editing/ })).toBeUndefined()

    await ui.press({ key: 'pageDown' })
    await ui.press({ key: 'pageDown' })
    await ui.press({ key: 'pageDown' })
    expect(await ui.find({ text: /second question/ })).toBeDefined()
    expect(await ui.find({ key: 'older' })).toBeDefined()
    expect(await ui.find({ text: /Editing now/ })).toBeUndefined()
    expect(await ui.find({ text: /Done editing/ })).toBeDefined()

    await ui.press({ key: 'up' })
    await ui.press({ key: 'pageUp' })
    await ui.press({ key: 'pageUp' })
    await ui.press({ key: 'pageUp' })
    expect(await ui.find({ text: /Editing now/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane folds and opens every call, or one kind, and shows its keys', async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  on('ui.scroll', () => ({}))
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('/.claude-plugin/plugin.json') ? '{ "version": "9.8.7" }' : '' }))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Open or folded, by whether each call's result is drawn beneath it.
    const marks = async () =>
      (await Promise.all([/@@ -1,2/, /ALL PASSED/, /BOOM/].map(async text => ((await ui.find({ text })) === undefined ? '▸' : '▾')))).join('')

    // The error starts open, so the first press folds everything.
    expect(await marks()).toBe('▸▸▾')
    await ui.press({ key: 'foldAll' })
    expect(await marks()).toBe('▸▸▸')
    expect(await ui.find({ text: /BOOM/ })).toBeUndefined()
    await ui.press({ key: 'foldAll' })
    expect(await marks()).toBe('▾▾▾')

    await ui.press({ key: 'foldDiffs' })
    expect(await marks()).toBe('▸▾▾')
    await ui.press({ key: 'foldBash' })
    expect(await marks()).toBe('▸▸▸')
    await ui.press({ key: 'foldBash' })
    expect(await marks()).toBe('▸▾▾')
    await ui.press({ key: 'foldDiffs' })
    expect(await marks()).toBe('▾▾▾')

    await ui.press({ key: 'help' })
    expect(await ui.find({ text: /ccpopout 9\.8\.7 · Keys · h, q or esc returns/ })).toBeDefined()
    expect(await ui.find({ text: /the same for the diffs/ })).toBeDefined()
    expect(await ui.find({ text: /Editing now/ })).toBeUndefined()
    await ui.press({ key: 'help' })
    expect(await ui.find({ text: /Editing now/ })).toBeDefined()
    // Back to how a turn starts, for the next surface.
    await ui.press({ key: 'foldAll' })
    await ui.press({ key: 'call:b2' })
    await ui.unmount()
  }
})

test('a cursor the window leaves out of sight comes to the nearest item in it', async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } as never }
  })

  // Six rows: three of header, three of body.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } } })
  // A row down takes the first reply out of sight: the cursor comes to the Edit.
  await ui.press({ key: 'down' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toContain('--- /x/a.ts')
  // A row back up, and the Edit is still in sight: the cursor stays on it.
  await ui.press({ key: 'up' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toContain('--- /x/a.ts')

  // To the end: the failed Bash call is the top item there.
  await ui.press({ key: 'pageDown' })
  await ui.press({ key: 'pageDown' })
  await ui.press({ key: 'pageDown' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ false\nBOOM')

  // Back to the top: the cursor leaves at the bottom, and ends on the Edit.
  await ui.press({ key: 'pageUp' })
  await ui.press({ key: 'pageUp' })
  await ui.press({ key: 'pageUp' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toContain('--- /x/a.ts')
  await ui.unmount()
})

test('the pane keeps its place over a change to the rows, and returns to it', async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } as never }
  })

  // Six rows: three of header, three of body. Two pages down: the failed Bash
  // call at the top of the window, the cursor on it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } } })
  await ui.press({ key: 'pageDown' })
  await ui.press({ key: 'pageDown' })
  const isThere = async () => (await ui.find({ text: /BOOM/ })) !== undefined && (await ui.find({ text: /Editing now/ })) === undefined
  expect(await isThere()).toBe(true)

  // The help and the whole message open at their top, and close onto the turn where it was.
  await ui.press({ key: 'help' })
  expect(await ui.find({ text: /BOOM/ })).toBeUndefined()
  await ui.press({ key: 'help' })
  expect(await isThere()).toBe(true)
  await ui.press({ key: 'expand' })
  expect(await ui.find({ text: /BOOM/ })).toBeUndefined()
  await ui.press({ key: 'expand' })
  expect(await isThere()).toBe(true)

  // The clean view puts the reply after the hidden call where the call was;
  // left again with nothing moved, the turn is where it was, cursor and all.
  await ui.press({ key: 'clean' })
  expect(await ui.find({ text: /Done editing/ })).toBeDefined()
  await ui.press({ key: 'clean' })
  expect(await isThere()).toBe(true)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ false\nBOOM')

  // Every call folded, then opened: the rows above grow, the call stays put.
  await ui.press({ key: 'foldAll' })
  expect(await ui.find({ text: /BOOM/ })).toBeUndefined()
  expect(await ui.find({ key: 'call:b2' })).toBeDefined()
  await ui.press({ key: 'foldAll' })
  expect(await isThere()).toBe(true)
  expect(await ui.find({ text: /@@ -1,2/ })).toBeUndefined()
  // And the window moves on from there.
  await ui.press({ key: 'down' })
  expect(await ui.find({ text: /Done editing/ })).toBeDefined()
  expect(await ui.find({ key: 'call:b2' })).toBeUndefined()
  await ui.unmount()
})

test('the pane moves a cursor over the items, opens the one it is on and copies it', async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } as never }
  })
  /** An arrow key, as the engine raises it at the pane. */
  const arrow = (by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'popout', offset: 1 + by, by, bodyRows: 30, contentRows: 60, origin: { kind: 'person' } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The cursor starts on the first item, Claude's words; they copy as written.
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('Editing now.')

  // Down to the Edit: `o` opens it, and it copies as a patch.
  await arrow(1)
  expect((await ui.find({ key: 'toggleItem' }))?.text).toContain('open')
  await ui.press({ key: 'toggleItem' })
  expect(await ui.find({ text: /@@ -1,2/ })).toBeDefined()
  expect((await ui.find({ key: 'toggleItem' }))?.text).toContain('fold')
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toContain('--- /x/a.ts')
  expect(copied.at(-1)).toContain('+b')
  await ui.press({ key: 'toggleItem' })
  expect(await ui.find({ text: /@@ -1,2/ })).toBeUndefined()

  // Down to the Bash call: its command and output.
  await arrow(1)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ npm test\nline 1\nline 2\nALL PASSED')
  await arrow(-1)
  await arrow(-1)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('Editing now.')
  await ui.unmount()
})

test('the pane folds a reply of several rows to its first ones', async ($, on) => {
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'explain', toolUses: [] },
      { role: 'assistant', text: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.', toolUses: [] },
    ] satisfies SessionMessage[],
  }))
  on('ui.scroll', () => ({}))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Third paragraph/ })).toBeDefined()
  await ui.press({ key: 'toggleItem' })
  expect(await ui.find({ text: /Third paragraph/ })).toBeUndefined()
  expect(await ui.find({ text: /Second paragraph\. · 5 lines/ })).toBeDefined()
  await ui.press({ key: 'foldReplies' })
  expect(await ui.find({ text: /Third paragraph/ })).toBeDefined()
  // The key for everything takes the replies too.
  await ui.press({ key: 'foldAll' })
  expect(await ui.find({ text: /Third paragraph/ })).toBeUndefined()
  await ui.press({ key: 'foldAll' })
  expect(await ui.find({ text: /Third paragraph/ })).toBeDefined()
  await ui.unmount()

  // Above the prompt, where rows are few, a folded reply keeps one.
  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' as const } })
  await inline.press({ key: 'toggleItem' })
  expect(await inline.find({ text: /First paragraph\. · 5 lines/ })).toBeDefined()
  expect(await inline.find({ text: /Second paragraph/ })).toBeUndefined()
  await inline.press({ key: 'toggleItem' })
  await inline.unmount()
})

test('the clean view hides the tool calls and counts them', async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  on('ui.scroll', () => ({}))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'call:e1' })).toBeDefined()
    await ui.press({ key: 'clean' })
    expect(await ui.find({ key: 'call:e1' })).toBeUndefined()
    expect(await ui.find({ text: /BOOM/ })).toBeUndefined()
    expect(await ui.find({ text: /⋯ 3 tool calls · Edit, 2 Bash · 1 error/ })).toBeDefined()
    expect(await ui.find({ text: /Editing now/ })).toBeDefined()
    expect(await ui.find({ text: /Done editing/ })).toBeDefined()
    await ui.press({ key: 'clean' })
    expect(await ui.find({ key: 'call:e1' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane says so when there is nothing yet', async ($, on) => {
  on('session.messages', () => ({ value: [] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /No messages yet/ })).toBeDefined()
  expect(await ui.find({ key: 'close' })).toBeDefined()
  await ui.unmount()
})

test('a slash command sent to Claude is a message, one the engine ran is not', async ($, on) => {
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', toolUses: [] },
      {
        role: 'user',
        text: '<command-message>make-story</command-message>\n<command-name>/make-story</command-name>\n<command-args>redis-namespace</command-args>',
        toolUses: [],
      },
      { role: 'assistant', text: 'Story written.', toolUses: [] },
    ],
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /1\/1 › \/make-story redis-namespace/ })).toBeDefined()
  expect(await ui.find({ text: /Story written/ })).toBeDefined()
  await ui.unmount()
})

/** Stands in for the host: an environment, and every command run recorded. */
const host = (on: Parameters<TestBody>[1], env: Record<string, string>, answer: (argv: readonly string[]) => string | undefined) => {
  const ran: string[][] = []
  const toasts: string[] = []
  const opened: string[] = []
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'abc-123' }))
  on('session.cwd', () => ({ value: "/work/it's here" }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } as never }
  })
  on('ui.scroll', () => ({}))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const stdout = answer(e.argv)
    return { value: { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran, toasts, opened }
}

test('/popout side splits a herdr pane and runs the popout program in it', async ($, on) => {
  let isAlive = false
  const { ran, opened } = host(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: '/bin/herdr' }, argv => {
    if (argv[0] === 'node') return '/usr/bin/node\n'
    if (argv[2] === 'layout') return JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 200 } }] } } })
    if (argv[2] === 'split') {
      isAlive = true
      return JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } })
    }
    if (argv[2] === 'get') return isAlive ? '{}' : undefined
    if (argv[2] === 'close') isAlive = false
    return '{}'
  })

  await $.command.run(typed('popout', 'side'))
  const split = ran.find(argv => argv[2] === 'split')
  expect(split?.slice(0, 6)).toEqual(['/bin/herdr', 'pane', 'split', 'w1:p1', '--direction', 'right'])
  const run = ran.find(argv => argv[2] === 'run')
  expect(run?.[3]).toBe('w1:p2')
  expect(run?.[4]).toContain("exec '/usr/bin/node' '")
  expect(run?.[4]).toContain("/tui/popout.mjs' '--session' 'abc-123' '--cwd' '/work/it'\\''s here'")
  expect(ran.some(argv => argv[2] === 'zoom')).toBe(false)
  expect(opened).toEqual([])

  // Open already: the key focuses it, and splits nothing more.
  await $.command.run(typed('popout-side'))
  expect(ran.filter(argv => argv[2] === 'split').length).toBe(1)
  expect(ran.at(-1)?.slice(1, 5)).toEqual(['pane', 'focus', '--direction', 'right'])

  await $.command.run(typed('popout', 'close'))
  expect(ran.at(-1)).toEqual(['/bin/herdr', 'pane', 'close', 'w1:p2'])
  expect(isAlive).toBe(false)
})

test('/popout side opens zoomed where the pane is narrow', async ($, on) => {
  const { ran } = host(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, argv => {
    if (argv[0] === 'node') return '/usr/bin/node\n'
    if (argv[2] === 'layout') return JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 100 } }] } } })
    if (argv[2] === 'split') return JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } })
    if (argv[2] === 'get') return undefined
    return '{}'
  })
  await $.command.run(typed('popout', 'side'))
  expect(ran.find(argv => argv[2] === 'split')?.[5]).toBe('down')
  expect(ran.at(-1)).toEqual(['herdr', 'pane', 'zoom', 'w1:p2', '--on'])
})

test('/popout side uses tmux where herdr is not running', async ($, on) => {
  const { ran } = host(on, { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3' }, argv => {
    if (argv[0] === 'node') return '/usr/bin/node\n'
    if (argv[1] === 'display-message') return '180\n'
    if (argv[1] === 'split-window') return '%7\n'
    return ''
  })
  await $.command.run(typed('popout', 'side'))
  const split = ran.find(argv => argv[1] === 'split-window') ?? []
  expect(split.slice(0, 9)).toEqual(['tmux', 'split-window', '-h', '-P', '-F', '#{pane_id}', '-c', "/work/it's here", '-t'])
  expect(split.slice(-4)).toEqual(['--session', 'abc-123', '--cwd', "/work/it's here"])
  expect(split.some(arg => arg.endsWith('/tui/popout.mjs'))).toBe(true)
})

test('/popout side falls back to the pane inside where there is no multiplexer', async ($, on) => {
  const { ran, toasts, opened } = host(on, {}, () => '')
  await $.command.run(typed('popout', 'side'))
  expect(ran).toEqual([])
  expect(toasts.join(' ')).toContain('no herdr or tmux')
  expect(opened).toEqual(['popout'])

  expect((await $.command.run(typed('popout', 'sideways'))).text).toContain('Usage')
})
