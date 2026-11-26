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

/** Presses a key of the pane `times` over. */
const presses = async (ui: { press: (target: { key: string }) => Promise<unknown> }, key: string, times: number) => {
  for (let at = 0; at < times; at++) await ui.press({ key })
}

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

    // Half a page is a row here: five of them to the end.
    await presses(ui, 'pageDown', 5)
    expect(await ui.find({ text: /second question/ })).toBeDefined()
    expect(await ui.find({ key: 'older' })).toBeDefined()
    expect(await ui.find({ text: /Editing now/ })).toBeUndefined()
    expect(await ui.find({ text: /Done editing/ })).toBeDefined()

    await ui.press({ key: 'up' })
    await presses(ui, 'pageUp', 5)
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
    expect(await ui.find({ text: /Done editing/ })).toBeUndefined()
    await ui.press({ key: 'help' })
    expect(await ui.find({ text: /Done editing/ })).toBeDefined()
    // Back to how a turn starts, for the next surface: the error open, the cursor on the first item.
    await ui.press({ key: 'foldAll' })
    await ui.press({ key: 'call:b2' })
    for (let at = 0; at < 5; at++) {
      await $.ui.scroll({ component: 'Pane', requestId: 'popout', offset: 0, by: -1, bodyRows: 30, contentRows: 60, origin: { kind: 'person' } } as never)
    }
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

  // Above the prompt. Six rows: three of header, three of body.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 6 } } })
  // A row down takes the first reply out of sight: the cursor comes to the Edit.
  await ui.press({ key: 'down' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toContain('--- /x/a.ts')
  // A row back up, and the Edit is still in sight: the cursor stays on it.
  await ui.press({ key: 'up' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toContain('--- /x/a.ts')

  // To the end: the failed Bash call is the top item there.
  await presses(ui, 'pageDown', 5)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ false\nBOOM')

  // Back to the top: the cursor leaves at the bottom, and ends on the Edit.
  await presses(ui, 'pageUp', 5)
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

  // Six rows: three of header, three of body. Four rows down: the failed Bash
  // call at the top of the window, the cursor on it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } } })
  await presses(ui, 'pageDown', 4)
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

test('in the fullscreen layout the cursor\'s item is held at the row being read, a little above the middle', async ($, on) => {
  // A reply, a blank row, forty folded calls: 42 rows.
  const toolUses = Array.from({ length: 40 }, (_, at) => ({ tool_use_id: `c${at}`, tool: 'Bash', input: { command: `echo ${at}` }, text: `${at}` }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'a long turn', toolUses: [] },
      { role: 'assistant', text: 'Start.', toolUses },
    ],
  }))
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
  const arrows = async (by: number, times: number) => {
    for (let at = 0; at < times; at++) await arrow(by)
  }

  // Thirty rows: three of header, twenty-seven of body; the row read has eleven above it, two short of the middle.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Near the top there is nothing above to scroll to: the window stays.
  await arrows(1, 10)
  expect(await ui.find({ text: /top · ↓ 15/ })).toBeDefined()
  // From there on each item comes to the row read.
  await arrows(1, 9)
  expect(await ui.find({ text: /↑ 9 · ↓ 6/ })).toBeDefined()
  // The last one too, over the blank rows past the turn's end.
  await arrows(1, 21)
  expect(await ui.find({ text: /↑ 30 · end/ })).toBeDefined()
  expect(await ui.find({ text: /echo 39/ })).toBeDefined()
  expect(await ui.find({ text: /echo 27/ })).toBeUndefined()
  // The window goes no further than that.
  await presses(ui, 'pageDown', 3)
  expect(await ui.find({ text: /↑ 30 · end/ })).toBeDefined()
  await arrows(-1, 40)
  expect(await ui.find({ text: /top · ↓ 15/ })).toBeDefined()

  // Scrolled a page, the cursor is on the item at the row read: half a page down, that is row 13 + 11, the call `echo 22`.
  await ui.press({ key: 'pageDown' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 22\n22')
  await arrow(1)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 23\n23')
  await presses(ui, 'pageUp', 2)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 9\n9')
  await arrows(-1, 40)

  // At the turn's top, `j` takes the cursor item by item, the window still,
  // until it has come to the row read: the call `echo 9`, at row 11.
  for (let at = 0; at < 10; at++) {
    await ui.press({ key: 'down' })
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)).toBe(`$ echo ${at}\n${at}`)
  }
  expect(await ui.find({ text: /top · ↓ 15/ })).toBeDefined()
  // From there it scrolls, the cursor at the row read: row 3 + 11, the call `echo 12`.
  await presses(ui, 'down', 3)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 12\n12')
  expect(await ui.find({ text: /↑ 3 · ↓ 12/ })).toBeDefined()
  // Back at the top, `k` takes it to the item before.
  await presses(ui, 'up', 3)
  await ui.press({ key: 'up' })
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 8\n8')

  // The wheel does as `j` and `k`: at the top, item by item, the window still.
  const wheel = (by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'popout', offset: 1 + by, by, bodyRows: 30, contentRows: 60, origin: { kind: 'person' }, pointer: { column: 10, row: 10 } } as never)
  await wheel(1)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 9\n9')
  await wheel(-1)
  await wheel(-1)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 7\n7')
  expect(await ui.find({ text: /top · ↓ 15/ })).toBeDefined()
  // Past the top it takes the cursor to the item at the row read, both ways: row 13 + 11, then 11 + 11.
  await arrows(1, 12)
  for (let at = 0; at < 3; at++) await wheel(1)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 22\n22')
  await wheel(-1)
  await wheel(-1)
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 20\n20')
  await arrows(-1, 40)
  await ui.unmount()

  // Above the prompt the window moves only for an item out of sight, and ends with the turn.
  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' as const } })
  await arrows(1, 20)
  expect(await inline.find({ text: /top · ↓ 15/ })).toBeDefined()
  await arrows(1, 20)
  expect(await inline.find({ text: /↑ 15 · end/ })).toBeDefined()
  await arrows(-1, 40)
  await inline.unmount()
})

test('an item that reaches past the window is come to at its first row, from above and from below', async ($, on) => {
  // A reply and a call (rows 0 to 3, with their blanks), a reply of fifty rows (4 to 53), a call (55).
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'a long reply', toolUses: [] },
      { role: 'assistant', text: 'Start.', toolUses: [{ tool_use_id: 'c0', tool: 'Bash', input: { command: 'echo 0' }, text: '0' }] },
      { role: 'assistant', text: Array.from({ length: 50 }, (_, at) => `Row ${at}.`).join('\n'), toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'echo 1' }, text: '1' }] },
    ],
  }))
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

  // Twenty-seven rows of body: the row read has eleven above it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rule = async () => ((await ui.find({ text: /─── / }))?.text ?? '').match(/(top|↑ \d+) · (end|↓ \d+)/)?.[0]
  const places: (string | undefined)[] = []
  for (let at = 0; at < 3; at++) {
    await arrow(1)
    places.push(await rule())
  }
  // The call, the long reply (its first row above the row read already), and the call after it (55 - 11).
  expect(places).toEqual(['top · ↓ 29', 'top · ↓ 29', '↑ 44 · end'])
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 1\n1')

  // Back up: the reply again, at its first row, and the call before it.
  places.length = 0
  for (let at = 0; at < 2; at++) {
    await arrow(-1)
    places.push(await rule())
  }
  expect(places).toEqual(['top · ↓ 29', 'top · ↓ 29'])
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 0\n0')
  await arrow(-1)
  await ui.unmount()
})

test('`j` and the wheel read a long item row by row from the turn\'s top, not past it', async ($, on) => {
  // A reply and a call (rows 0 to 3, with their blanks), a reply of fifty rows (4 to 53), a call (55).
  const long = Array.from({ length: 50 }, (_, at) => `Row ${at}.`).join('\n')
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'a long reply', toolUses: [] },
      { role: 'assistant', text: 'Start.', toolUses: [{ tool_use_id: 'c0', tool: 'Bash', input: { command: 'echo 0' }, text: '0' }] },
      { role: 'assistant', text: long, toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'echo 1' }, text: '1' }] },
    ],
  }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } as never }
  })
  const wheel = (by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'popout', offset: 1 + by, by, bodyRows: 30, contentRows: 60, origin: { kind: 'person' }, pointer: { column: 10, row: 10 } } as never)

  // Twenty-seven rows of body: the row read has eleven above it.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rule = async () => ((await ui.find({ text: /─── / }))?.text ?? '').match(/(top|↑ \d+) · (end|↓ \d+)/)?.[0]
  const places: (string | undefined)[] = []
  for (let at = 0; at < 3; at++) {
    await ui.press({ key: 'down' })
    places.push(await rule())
  }
  // The call, the long reply, and then a row: the call after the reply starts
  // past the row read, and coming to it would take the window over the reply unread.
  expect(places).toEqual(['top · ↓ 29', 'top · ↓ 29', '↑ 1 · ↓ 28'])
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe(long)
  // Row by row through the reply, to the call after it at the row read (55 - 11).
  await presses(ui, 'down', 43)
  expect(await rule()).toBe('↑ 44 · end')
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe('$ echo 1\n1')

  // The wheel the same: back at the top, on the reply, a tick is a row.
  await presses(ui, 'up', 44)
  expect(await rule()).toBe('top · ↓ 29')
  await wheel(1)
  expect(await rule()).toBe('↑ 1 · ↓ 28')
  await ui.press({ key: 'copy' })
  expect(copied.at(-1)).toBe(long)
  await ui.unmount()
})

test('a turn shown again is where it was left, and the rule counts the items shown', async ($, on) => {
  const toolUses = Array.from({ length: 40 }, (_, at) => ({ tool_use_id: `c${at}`, tool: 'Bash', input: { command: `echo ${at}` }, text: `${at}` }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'a short turn', toolUses: [] },
      { role: 'assistant', text: 'Short.', toolUses: [] },
      { role: 'user', text: 'a long turn', toolUses: [] },
      { role: 'assistant', text: 'Start.', toolUses },
    ],
  }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  const arrow = (by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'popout', offset: 1 + by, by, bodyRows: 30, contentRows: 60, origin: { kind: 'person' } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /▌ 1\/41 / })).toBeDefined()
  for (let at = 0; at < 15; at++) await arrow(1)
  // The call `echo 14`, its first row (16) at the row read (11).
  expect(await ui.find({ text: /▌ 16\/41  ↑ 5 · ↓ 10/ })).toBeDefined()
  await ui.press({ key: 'older' })
  expect(await ui.find({ text: /1\/2 › a short turn/ })).toBeDefined()
  expect(await ui.find({ text: /▌ 1\/1 / })).toBeDefined()
  await ui.press({ key: 'newer' })
  expect(await ui.find({ text: /▌ 16\/41  ↑ 5 · ↓ 10/ })).toBeDefined()

  // The clean view counts what it shows: the reply alone.
  await ui.press({ key: 'clean' })
  expect(await ui.find({ text: /▌ 1\/1 / })).toBeDefined()
  await ui.press({ key: 'clean' })
  await ui.unmount()
})

test('the pane opens in the view the setting names, then in the one last chosen', { options: { clean: false } }, async ($, on) => {
  on('session.messages', () => ({ value: CONVERSATION }))
  const files = new Map<string, string>()
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path) as string } : { value: '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  host(on, { HOME: '/home/u' }, () => '')
  const STATE = '/home/u/.claude/ccpopout-state.json'

  // Nothing chosen yet: the setting's full view.
  await $.command.run(typed('popout'))
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'call:b1' })).toBeDefined()
  await ui.press({ key: 'clean' })
  expect(await ui.find({ key: 'call:b1' })).toBeUndefined()
  expect(JSON.parse(files.get(STATE) ?? '{}')).toEqual({ isClean: true })
  await ui.unmount()

  // Chosen: the next pane opens in it, whatever the setting.
  await $.command.run(typed('popout'))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'call:b1' })).toBeUndefined()
  expect(await ui.find({ text: /⋯ 3 tool calls/ })).toBeDefined()
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
  let now = 1000
  on('clock.now', () => ({ value: now++ }))
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
  expect(split.slice(-5)).toEqual(['--session', 'abc-123', '--cwd', "/work/it's here", '--clean'])
  expect(split.some(arg => arg.endsWith('/tui/popout.mjs'))).toBe(true)
})

const HERDR_WIDE = (argv: readonly string[]) => {
  if (argv[0] === 'node') return '/usr/bin/node\n'
  if (argv[2] === 'layout') return JSON.stringify({ result: { layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 200 } }] } } })
  if (argv[2] === 'split') return JSON.stringify({ result: { pane: { pane_id: 'w1:p2' } } })
  if (argv[2] === 'get') return undefined
  return '{}'
}

test('/popout left splits a herdr pane to the right and swaps it over', async ($, on) => {
  const { ran } = host(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, HERDR_WIDE)
  await $.command.run(typed('popout', 'left'))
  expect(ran.find(argv => argv[2] === 'split')?.[5]).toBe('right')
  expect(ran.find(argv => argv[2] === 'swap')).toEqual(['herdr', 'pane', 'swap', '--source-pane', 'w1:p2', '--target-pane', 'w1:p1'])
})

test('the side setting opens the side pane on the left, and /popout-right still on the right', { options: { side: 'left' } }, async ($, on) => {
  const { ran } = host(on, { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3' }, argv => {
    if (argv[0] === 'node') return '/usr/bin/node\n'
    if (argv[1] === 'display-message') return '180\n'
    if (argv[1] === 'split-window') return '%7\n'
    return ''
  })
  await $.command.run(typed('popout-side'))
  expect(ran.filter(argv => argv[1] === 'split-window').at(-1)?.slice(2, 4)).toEqual(['-h', '-b'])
  await $.command.run(typed('popout-right'))
  expect(ran.filter(argv => argv[1] === 'split-window').at(-1)?.slice(2, 4)).toEqual(['-h', '-P'])
})

test('CCPOPOUT_SIDE overrides the side setting', { options: { side: 'left' } }, async ($, on) => {
  const { ran } = host(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', CCPOPOUT_SIDE: 'right' }, HERDR_WIDE)
  await $.command.run(typed('popout', 'side'))
  expect(ran.some(argv => argv[2] === 'swap')).toBe(false)
})

test('/popout side falls back to the pane inside where there is no multiplexer', async ($, on) => {
  const { ran, toasts, opened } = host(on, {}, () => '')
  await $.command.run(typed('popout', 'side'))
  expect(ran).toEqual([])
  expect(toasts.join(' ')).toContain('no herdr, tmux or Herdr Desktop pane')
  expect(opened).toEqual(['popout'])

  expect((await $.command.run(typed('popout', 'sideways'))).text).toContain('Usage')
})

/** Herdr Desktop: `hc get` of this terminal, `cols` wide, and a run that starts t9. */
const hcHost = (cols: number, labels: Record<string, string> = { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' }, placed: Record<string, string> = {}) => {
  let isAlive = false
  return {
    isAlive: () => isAlive,
    answer: (argv: readonly string[]) => {
      if (argv[0] === 'node') return '/usr/bin/node\n'
      if (argv[1] === 'get' && argv[2] === 't4') return JSON.stringify({ address: 't4', state: 'live', cols, labels })
      if (argv[1] === 'get') return isAlive ? JSON.stringify({ address: 't9', state: 'live', labels: placed }) : JSON.stringify({ address: 't9', state: 'finished' })
      if (argv[1] === 'run') {
        isAlive = true
        return JSON.stringify({ address: 't9', state: 'live' })
      }
      if (argv[1] === 'kill') isAlive = false
      return '{}'
    },
  }
}

test('/popout side starts the popout program in a Herdr Desktop pane beside this one', async ($, on) => {
  const hc = hcHost(200)
  const { ran, toasts, opened } = host(on, { HC_TERMINAL_ID: 't4', HC_BIN_PATH: '/bin/hc', CLAUDE_CONFIG_DIR: '/home/u/.claude1' }, hc.answer)

  await $.command.run(typed('popout', 'side'))
  const run = ran.find(argv => argv[1] === 'run') ?? []
  // The focus label asks Desktop's ccpopout mod to focus the pane.
  expect(run.slice(0, 15)).toEqual([
    '/bin/hc', 'run', '--bg', '--no-notify', '--json', '--cwd', "/work/it's here",
    '--label', 'herdr.space=sp1', '--label', 'herdr.tab=tb1', '--label', 'ccpopout.focus=1000', '--', '/usr/bin/node',
  ])
  expect(run[15]).toMatch(/^\/.*\/tui\/popout\.mjs$/)
  expect(run.slice(16, 20)).toEqual(['--session', 'abc-123', '--cwd', "/work/it's here"])
  // hc starts it with its own environment: the session's config directory is named.
  expect(run.slice(run.indexOf('--config'), run.indexOf('--config') + 2)).toEqual(['--config', '/home/u/.claude1'])
  expect(toasts).toEqual([])
  expect(opened).toEqual([])

  // Open already: nothing more starts, nothing is said, and the focus is asked for again.
  await $.command.run(typed('popout-side'))
  expect(ran.filter(argv => argv[1] === 'run').length).toBe(1)
  expect(ran.at(-1)).toEqual(['/bin/hc', 'label', 't9', 'ccpopout.focus=1001'])
  expect(toasts).toEqual([])

  await $.command.run(typed('popout', 'close'))
  expect(ran.at(-1)).toEqual(['/bin/hc', 'kill', 't9'])
  expect(hc.isAlive()).toBe(false)
})

test('/popout left in Herdr Desktop asks the ccpopout mod to move it left', async ($, on) => {
  const { ran, toasts } = host(on, { HC_TERMINAL_ID: 't4' }, hcHost(200, undefined, { 'ccpopout.placed': 'left' }).answer)
  await $.command.run(typed('popout', 'left'))
  const run = ran.find(argv => argv[1] === 'run') ?? []
  expect(run[0]).toBe('hc')
  expect(run.slice(11, 15)).toEqual(['--label', 'ccpopout.side=left', '--label', 'ccpopout.from=t4'])
  expect(ran.at(-1)).toEqual(['hc', 'get', 't9', '--json'])
  expect(toasts).toEqual([])
})

test('/popout left in Herdr Desktop without the mod stays on the right, and says so', async ($, on) => {
  const { ran, toasts } = host(on, { HC_TERMINAL_ID: 't4' }, hcHost(200).answer)
  await $.command.run(typed('popout', 'left'))
  expect(ran.filter(argv => argv[1] === 'get' && argv[2] === 't9').length).toBe(20)
  expect(toasts).toEqual(['popout: Herdr Desktop opened it on the right; its ccpopout mod moves it left (see the README)'])
})

test('/popout right in Herdr Desktop asks only for the focus, and does not wait', async ($, on) => {
  const { ran } = host(on, { HC_TERMINAL_ID: 't4' }, hcHost(200).answer)
  await $.command.run(typed('popout', 'right'))
  expect((ran.find(argv => argv[1] === 'run') ?? []).filter(arg => arg.startsWith('ccpopout.'))).toEqual(['ccpopout.focus=1000'])
  expect(ran.some(argv => argv[1] === 'get' && argv[2] === 't9')).toBe(false)
})

test('/popout side in a narrow Herdr Desktop terminal still opens a pane beside it', async ($, on) => {
  const { ran, toasts, opened } = host(on, { HC_TERMINAL_ID: 't4' }, hcHost(100).answer)
  await $.command.run(typed('popout', 'side'))
  expect(ran.some(argv => argv[1] === 'run')).toBe(true)
  expect(toasts).toEqual([])
  expect(opened).toEqual([])
})

test('/popout side in an hc terminal outside Herdr Desktop opens the pane inside', async ($, on) => {
  const { ran, toasts, opened } = host(on, { HC_TERMINAL_ID: 't4' }, hcHost(200, {}).answer)
  await $.command.run(typed('popout', 'side'))
  expect(ran.some(argv => argv[1] === 'run')).toBe(false)
  expect(toasts.join(' ')).toContain('no herdr, tmux or Herdr Desktop pane')
  expect(opened).toEqual(['popout'])
})

test('herdr and tmux come before hc', async ($, on) => {
  const { ran } = host(on, { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3', HC_TERMINAL_ID: 't4' }, argv => {
    if (argv[0] === 'node') return '/usr/bin/node\n'
    if (argv[1] === 'display-message') return '180\n'
    if (argv[1] === 'split-window') return '%7\n'
    return ''
  })
  await $.command.run(typed('popout', 'side'))
  expect(ran.some(argv => argv[0] === 'hc')).toBe(false)
  expect(ran.some(argv => argv[1] === 'split-window')).toBe(true)
})

/** keybindings.json in a map of files, as `fs.read` and `fs.write` see it, and `/popout keys` run on it. */
const keysHost = ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], text?: string) => {
  const KEYS_FILE = '/home/u/.claude/keybindings.json'
  const files = new Map<string, string>(text === undefined ? [] : [[KEYS_FILE, text]])
  const writes: string[] = []
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path) as string } : { deny: 'ENOENT' }) as never)
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    writes.push(e.path)
    return { value: undefined }
  })
  host(on, { HOME: '/home/u' }, () => '')
  return {
    writes,
    keys: () => JSON.parse(files.get(KEYS_FILE) ?? 'null'),
    run: async (args: string) => (await $.command.run(typed('popout', args))).text ?? '',
  }
}

const OURS = { 'ctrl+x r': 'command:popout', 'ctrl+x t': 'command:popout-side', 'ctrl+x l': 'command:popout-left' }

test('/popout keys add adds the key bindings, once', async ($, on) => {
  const { keys, run, writes } = keysHost($, on)
  const text = await run('keys add')
  expect(keys()).toEqual({ bindings: [{ context: 'Chat', bindings: OURS }] })
  expect(text).toContain('Added to /home/u/.claude/keybindings.json:')
  expect(text).toContain('ctrl+x t  →  /popout-side')
  expect(text).toContain('/popout keys remove')

  // Already there: nothing written, and it says so.
  expect(await run('keys add')).toContain("ccpopout's keys are already in /home/u/.claude/keybindings.json:")
  expect(writes.length).toBe(1)
})

test('/popout keys add leaves a key used for something else, and the rest of the file', async ($, on) => {
  const mine = { $schema: 'x', bindings: [{ context: 'Global', bindings: { 'ctrl+g': 'app:x' } }, { context: 'Chat', bindings: { 'ctrl+x r': 'command:review' } }] }
  const { keys, run } = keysHost($, on, JSON.stringify(mine))
  const text = await run('keys add')
  expect(keys()).toEqual({
    $schema: 'x',
    bindings: [
      { context: 'Global', bindings: { 'ctrl+g': 'app:x' } },
      { context: 'Chat', bindings: { 'ctrl+x r': 'command:review', 'ctrl+x t': 'command:popout-side', 'ctrl+x l': 'command:popout-left' } },
    ],
  })
  expect(text).toContain('Left alone, because you use this key for something else:\n  ctrl+x r')
})

test('/popout keys remove takes out only the keys bound to ccpopout', async ($, on) => {
  const mine = { bindings: [{ context: 'Chat', bindings: { 'ctrl+y': 'command:other' } }] }
  const { keys, run } = keysHost($, on, JSON.stringify(mine))
  await run('keys add')
  expect(keys().bindings[0].bindings).toEqual({ 'ctrl+y': 'command:other', ...OURS })
  expect(await run('keys  remove')).toContain("Removed ccpopout's keys from /home/u/.claude/keybindings.json:")
  expect(keys()).toEqual(mine)
  expect(await run('keys remove')).toContain('nothing to remove')
})

test('/popout keys remove drops a Chat block that held only its keys', async ($, on) => {
  const { keys, run } = keysHost($, on)
  await run('keys add')
  await run('keys remove')
  expect(keys()).toEqual({ bindings: [] })
})

test('/popout keys add leaves a keybindings.json that is not JSON alone', async ($, on) => {
  const { writes, run } = keysHost($, on, '{ "bindings": [ // mine\n')
  expect(await run('keys add')).toContain('is not plain JSON (it may have comments), so ccpopout left it alone')
  expect(writes).toEqual([])
})

test('/popout keys alone names the keys and changes nothing', async ($, on) => {
  const { writes, run } = keysHost($, on)
  const text = await run('keys')
  expect(text).toContain('ctrl+x r  →  /popout')
  expect(text).toContain('/popout keys add')
  expect(writes).toEqual([])
})
