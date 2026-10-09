#!/usr/bin/env node
// ccpopout as a terminal program of its own, for a multiplexer's side pane:
// what Claude did since each of the person's messages, read live from the
// session's transcript file.
//
//   node popout.mjs <transcript.jsonl>
//   node popout.mjs --session <id> [--cwd <dir>] [--snapshot <messages.json>] [--clean]
//
// A session just resumed has its history in memory only, its file filled at
// the next message: until then the view shows the snapshot its opener wrote.
//
// No dependencies: plain ANSI on the alternate screen.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const POLL_MS = 200
const MAX_TEXT = 200000
/** Most rows one unfolded tool result shows; the rest is counted, not drawn. */
const MAX_BODY_LINES = 2000
/** Most rows of the message the header shows; `e` shows it whole. */
const TITLE_ROWS = 3
/** Below this many terminal rows the header keeps to one row of the message. */
const ROOMY_ROWS = 16
const WHEEL_ROWS = 3
/** The rows of a folded reply that stay in view. */
const FOLDED_ROWS = 2
/** The cells left of the turn's rows, where the cursor's bar is drawn. */
const GUTTER = 2
/** The cell at the right edge, where the scroll bar is drawn. */
const BAR = 1

// ───────────────────────────── styles ─────────────────────────────

const ESC = '\x1b'
const RESET = `${ESC}[0m`
const S = {
  bold: '1',
  dim: '2',
  italic: '3',
  underline: '4',
  strike: '9',
  inverse: '7',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  gray: '90',
  tool: '94',
  /** A gray of its own, for what is read but stands back (a time, Claude's thinking, where the window is): the theme's (`gray`) is too faint. */
  stamp: '38;5;245',
  headerBg: '48;5;237',
  hoverBg: '48;5;240',
  addBg: '48;5;22',
  delBg: '48;5;52',
  codeBg: '48;5;235',
}
const sgr = (...codes) => codes.filter(Boolean).join(';')

// ───────────────────────────── text width ─────────────────────────────

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}​-‏︀-️]$/u
const WIDE =
  /^[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]$/u

function charWidth(ch) {
  if (ch < '\x7f') return 1
  if (ZERO_WIDTH.test(ch)) return 0
  return WIDE.test(ch) ? 2 : 1
}

function textWidth(text) {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/** The characters of `text` in the cells from `from` up to `to`, and the cell the first of them is in. */
function cellSlice(text, from, to) {
  let out = ''
  let col = 0
  let start
  for (const ch of text) {
    if (col >= to) break
    if (col >= from) {
      start ??= col
      out += ch
    }
    col += charWidth(ch)
  }
  return { text: out, start: start ?? from }
}

/** A drawn row as the text on screen: no escapes, and not the scroll bar at its edge. */
function plainOf(line) {
  return line.split(/\x1b\[\d+G/)[0].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

/** `text` cut to at most `width` cells, with an ellipsis when it was longer. */
function truncate(text, width) {
  if (textWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/** Text safe to draw: no escapes or control characters, tabs spread, bounded. */
function clean(text, max = MAX_TEXT) {
  const plain = String(text ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}\n… (${plain.length - max} more characters)` : plain
}

// ───────────────────────────── rows ─────────────────────────────
// A row is { segs: [{ t, s }], bg?, call? }: exactly one terminal row when
// drawn. `s` is an SGR parameter string, `bg` fills the row to the edge and
// `call` marks a tool call's summary row (pressing it toggles the call).

const row = (t = '', s = '', extra) => ({ segs: t === '' ? [] : [{ t, s }], ...extra })

/**
 * Wraps styled segments into rows of at most `width` cells at word
 * boundaries (hard where `isHard` or a word is too long), continuation rows
 * under `hang`.
 */
function wrapSegs(segs, width, { first = [], hang = [], isHard = false } = {}) {
  const firstWidth = first.reduce((sum, seg) => sum + textWidth(seg.t), 0)
  const hangWidth = hang.reduce((sum, seg) => sum + textWidth(seg.t), 0)
  const cells = []
  for (const seg of segs) for (const ch of seg.t) cells.push({ ch, w: charWidth(ch), s: seg.s })

  const rows = []
  let at = 0
  let isFirst = true
  while (at < cells.length || isFirst) {
    const room = Math.max(4, width - (isFirst ? firstWidth : hangWidth))
    let used = 0
    let end = at
    let lastSpace = -1
    while (end < cells.length && used + cells[end].w <= room) {
      if (cells[end].ch === ' ') lastSpace = end
      used += cells[end].w
      end++
    }
    let next = end
    if (end < cells.length && !isHard) {
      if (cells[end].ch === ' ') next = end + 1
      else if (lastSpace > at) {
        end = lastSpace
        next = lastSpace + 1
      }
    }
    if (end === at && at < cells.length) next = end = at + 1
    const out = [...(isFirst ? first : hang)]
    for (let i = at; i < end; i++) {
      const last = out.at(-1)
      if (last !== undefined && last.s === cells[i].s && last !== first.at(-1) && last !== hang.at(-1)) last.t += cells[i].ch
      else out.push({ t: cells[i].ch, s: cells[i].s })
    }
    rows.push({ segs: out })
    at = next
    isFirst = false
  }
  return rows
}

// ───────────────────────────── markdown ─────────────────────────────

/** Inline markdown as styled segments over the `base` style. */
function inline(text, base = '') {
  const segs = []
  const pattern =
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) segs.push({ t: text.slice(last, match.index), s: base })
    if (match[2] !== undefined) segs.push({ t: match[2], s: sgr(base, S.cyan) })
    else if (match[3] !== undefined || match[4] !== undefined) segs.push(...inline(match[3] ?? match[4], sgr(base, S.bold)))
    else if (match[5] !== undefined) segs.push(...inline(match[5], sgr(base, S.strike)))
    else if (match[6] !== undefined || match[7] !== undefined) segs.push(...inline(match[6] ?? match[7], sgr(base, S.italic)))
    else if (match[8] !== undefined) segs.push(...inline(match[8], sgr(base, S.underline, S.blue)))
    last = match.index + match[0].length
  }
  if (last < text.length) segs.push({ t: text.slice(last), s: base })
  return segs
}

/** Styled segments cut to at most `width` cells, an ellipsis where they were longer. */
function cutSegs(segs, width) {
  if (segs.reduce((sum, seg) => sum + textWidth(seg.t), 0) <= width) return segs
  const out = []
  let room = width - 1
  for (const seg of segs) {
    if (room <= 0) break
    let text = ''
    for (const ch of seg.t) {
      const w = charWidth(ch)
      if (w > room) break
      text += ch
      room -= w
    }
    out.push({ t: text, s: seg.s })
    if (text !== seg.t) break
  }
  return [...out, { t: '…', s: '' }]
}

const segsWidth = segs => segs.reduce((sum, seg) => sum + textWidth(seg.t), 0)

/** When a transcript record was written, as the clock on the wall here read; '' for none. */
function stampText(time) {
  if (typeof time !== 'number' || Number.isNaN(time)) return ''
  const at = new Date(time)
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

/** The cells a stamp takes at a row's right edge, the gap before it counted. */
const stampRoom = stamp => (stamp === '' ? 0 : stamp.length + 2)

/** `segs` with `stamp` at the right edge of a row `width` cells wide; undefined where it does not fit. */
function stamped(segs, stamp, width) {
  const gap = width - segsWidth(segs) - stamp.length
  if (gap < 2) return undefined
  return [...segs, { t: ' '.repeat(gap), s: '' }, { t: stamp, s: S.stamp }]
}

const splitCells = line =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))

/** A markdown table as boxed rows, its columns shrunk to fit `width`. */
function tableRows(lines, width) {
  const header = splitCells(lines[0])
  const aligns = splitCells(lines[1]).map(cell => (/^:-+:$/.test(cell) ? 'center' : /-:$/.test(cell) ? 'right' : 'left'))
  const body = lines.slice(2).map(splitCells)
  const count = Math.max(header.length, ...body.map(cells => cells.length))
  const all = [header, ...body].map((cells, at) =>
    Array.from({ length: count }, (_, col) => inline(cells[col] ?? '', at === 0 ? S.bold : '')),
  )

  const widths = Array.from({ length: count }, (_, col) => Math.max(3, ...all.map(cells => segsWidth(cells[col]))))
  const room = Math.max(count * 4, width - (3 * count + 1))
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest] <= 4) break
    widths[widest]--
  }

  const rule = (left, mid, right) => row(left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right, S.gray)
  const out = [rule('┌', '┬', '┐')]
  all.forEach((cells, at) => {
    const wrapped = cells.map((segs, col) => wrapSegs(segs, widths[col]))
    const height = Math.max(...wrapped.map(rows => rows.length))
    for (let line = 0; line < height; line++) {
      const segs = [{ t: '│', s: S.gray }]
      wrapped.forEach((rows, col) => {
        const cell = rows[line]?.segs ?? []
        const pad = widths[col] - segsWidth(cell)
        const left = aligns[col] === 'right' ? pad : aligns[col] === 'center' ? pad >> 1 : 0
        segs.push({ t: ' '.repeat(left + 1), s: '' }, ...cell, { t: ' '.repeat(pad - left + 1), s: '' }, { t: '│', s: S.gray })
      })
      out.push({ segs })
    }
    if (at === 0) out.push(rule('├', '┼', '┤'))
  })
  out.push(rule('└', '┴', '┘'))
  return out
}

/** An assistant reply as rows. */
function proseRows(markdown, width) {
  const rows = []
  const source = clean(markdown).split('\n')
  const blank = () => {
    if (rows.length > 0 && rows.at(-1).segs.length > 0) rows.push(row())
  }

  for (let at = 0; at < source.length; at++) {
    const raw = source[at]

    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(raw)
    if (fence !== null) {
      const lang = fence[3].toLowerCase()
      const body = []
      for (at++; at < source.length && !source[at].trimStart().startsWith(fence[2]); at++) body.push(source[at])
      if (lang !== '') rows.push(row(`  ${lang}`, S.gray))
      for (const line of body) {
        let style = ''
        if (lang === 'diff' || lang === 'patch') {
          style = line.startsWith('+') ? S.green : line.startsWith('-') ? S.red : line.startsWith('@@') ? S.cyan : ''
        }
        const gutter = [{ t: '  ', s: '' }]
        for (const out of wrapSegs([{ t: line, s: style }], width - 1, { first: gutter, hang: gutter, isHard: true })) {
          rows.push({ ...out, bg: S.codeBg })
        }
      }
      continue
    }

    if (raw.trim() === '') {
      blank()
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(raw) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(source[at + 1] ?? '')) {
      const lines = [raw, source[at + 1]]
      for (at += 2; at < source.length && /^\s*\|.*\|\s*$/.test(source[at]); at++) lines.push(source[at])
      at--
      rows.push(...tableRows(lines, width))
      continue
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(raw)
    if (heading !== null) {
      blank()
      const style = heading[1].length <= 2 ? sgr(S.bold, S.magenta) : S.bold
      rows.push(...wrapSegs(inline(heading[2], style), width))
      continue
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) {
      rows.push(row('─'.repeat(width), S.gray))
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote !== null) {
      const bar = [{ t: '▎ ', s: S.gray }]
      rows.push(...wrapSegs(inline(quote[1], S.italic), width, { first: bar, hang: bar }))
      continue
    }

    const item = /^(\s*)([-*+•]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw)
    if (item !== null) {
      const indent = ' '.repeat(Math.min(textWidth(item[1]), width >> 2))
      const mark = /\d/.test(item[2]) ? item[2] : '•'
      const box = item[3] === undefined ? '' : /x/i.test(item[3]) ? '☑ ' : '☐ '
      const first = [{ t: `${indent}${mark} ${box}`, s: S.gray }]
      const hang = [{ t: ' '.repeat(textWidth(first[0].t)), s: '' }]
      rows.push(...wrapSegs(inline(item[4]), width, { first, hang }))
      continue
    }

    const lead = /^\s*/.exec(raw)[0]
    const indent = lead === '' ? [] : [{ t: ' '.repeat(Math.min(textWidth(lead), width >> 2)), s: '' }]
    rows.push(...wrapSegs(inline(raw.trim()), width, { first: indent, hang: indent }))
  }
  while (rows.length > 0 && rows.at(-1).segs.length === 0) rows.pop()
  return rows
}

// ───────────────────────────── tool calls ─────────────────────────────

function countPatch(patch) {
  let added = 0
  let removed = 0
  for (const hunk of patch ?? []) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function lineCount(text) {
  const trimmed = String(text ?? '').trimEnd()
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

function shortPath(value) {
  if (typeof value !== 'string') return ''
  const parts = value.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : value
}

function callLabel(call) {
  const input = call.input ?? {}
  let arg = ''
  if (call.tool === 'Bash') arg = String(input.command ?? '').split('\n')[0] ?? ''
  else if ('file_path' in input) arg = shortPath(input.file_path)
  else if ('pattern' in input) arg = String(input.pattern)
  else if ('path' in input) arg = shortPath(input.path)
  else if ('description' in input) arg = String(input.description)
  else if ('skill' in input) arg = String(input.skill)
  else if ('query' in input) arg = String(input.query)
  else if ('url' in input) arg = String(input.url)
  arg = clean(arg)
  return arg === '' ? call.tool : `${call.tool}(${arg})`
}

/** The label cut so that `tail`, the call's summary, still fits the row. */
const fitLabel = (label, tail, width) => truncate(label, Math.max(8, width - textWidth(tail) - 5))

function capped(rows) {
  if (rows.length <= MAX_BODY_LINES) return rows
  return [...rows.slice(0, MAX_BODY_LINES), row(`  … ${rows.length - MAX_BODY_LINES} more lines`, S.dim)]
}

const plainRows = (text, width, style) =>
  clean(text)
    .trimEnd()
    .split('\n')
    .flatMap(line => wrapSegs([{ t: line, s: style }], width, { first: [{ t: '  ', s: '' }], hang: [{ t: '  ', s: '' }], isHard: true }))

/** A structured patch as rows: line numbers, a sign column, tinted rows. */
function diffRows(patch, width) {
  const rows = []
  const last = Math.max(1, ...patch.map(hunk => Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)))
  const digits = String(last).length
  for (const hunk of patch) {
    rows.push(row(`  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, S.cyan))
    let oldAt = hunk.oldStart
    let newAt = hunk.newStart
    for (const line of hunk.lines ?? []) {
      const sign = line[0]
      if (sign === '\\') continue
      const number = sign === '-' ? oldAt++ : sign === '+' ? newAt++ : (oldAt++, newAt++)
      const tint = sign === '+' ? S.addBg : sign === '-' ? S.delBg : undefined
      const signStyle = sign === '+' ? sgr(S.green, S.bold) : sign === '-' ? sgr(S.red, S.bold) : S.gray
      const first = [
        { t: `  ${String(number).padStart(digits)} `, s: S.gray },
        { t: `${sign === ' ' ? ' ' : sign} `, s: signStyle },
      ]
      const hang = [{ t: ' '.repeat(digits + 5), s: '' }]
      const text = clean(line.slice(1))
      for (const out of wrapSegs([{ t: text, s: tint === undefined ? S.dim : '' }], width, { first, hang, isHard: true })) {
        rows.push({ ...out, bg: tint })
      }
    }
  }
  return rows
}

/** The one-line summary and the body rows of an answered call. */
function callResult(call, width) {
  const out = call.result !== null && typeof call.result === 'object' ? call.result : {}
  if (call.tool === 'Edit' || call.tool === 'Write' || call.tool === 'MultiEdit') {
    const patch = Array.isArray(out.structuredPatch) ? out.structuredPatch : []
    const { added, removed } = countPatch(patch)
    if (patch.length === 0 && typeof out.content === 'string') {
      const lines = clean(out.content).trimEnd().split('\n')
      const digits = String(lines.length).length
      const body = lines.flatMap((line, at) =>
        wrapSegs([{ t: line, s: '' }], width, {
          first: [{ t: `  ${String(at + 1).padStart(digits)} `, s: S.gray }, { t: '+ ', s: sgr(S.green, S.bold) }],
          hang: [{ t: ' '.repeat(digits + 5), s: '' }],
          isHard: true,
        }).map(r => ({ ...r, bg: S.addBg })),
      )
      return { summary: `new file · ${lines.length} lines`, body }
    }
    return { summary: added + removed === 0 ? 'no change' : `+${added} −${removed}`, body: diffRows(patch, width) }
  }

  if (call.tool === 'Bash') {
    const stdout = typeof out.stdout === 'string' ? out.stdout : ''
    const stderr = typeof out.stderr === 'string' ? out.stderr : ''
    const fallback = stdout === '' && stderr === '' && call.result === undefined ? (call.text ?? '') : ''
    const parts = []
    if (lineCount(stdout + fallback) + lineCount(stderr) === 0) parts.push('no output')
    else parts.push(`${lineCount(stdout + fallback)} lines`)
    if (lineCount(stderr) > 0) parts.push(`${lineCount(stderr)} stderr`)
    if (out.interrupted === true) parts.push('interrupted')
    if (out.backgroundTaskId !== undefined) parts.push('background')
    const command = clean(call.input?.command ?? '')
    const body = []
    if (command !== '') {
      const first = [{ t: '  $ ', s: sgr(S.bold, S.yellow) }]
      for (const line of command.split('\n')) {
        body.push(...wrapSegs([{ t: line, s: S.bold }], width, { first: body.length === 0 ? first : [{ t: '    ', s: '' }], hang: [{ t: '    ', s: '' }], isHard: true }))
      }
    }
    if ((stdout + fallback).trim() !== '') body.push(...plainRows(stdout + fallback, width, S.dim))
    if (stderr.trim() !== '') body.push(...plainRows(stderr, width, S.red))
    return { summary: parts.join(' · '), body }
  }

  const text = clean(call.text ?? '').trim()
  const count = lineCount(text)
  return { summary: count <= 1 ? 'done' : `${count} lines`, body: text === '' ? [] : plainRows(text, width, S.dim) }
}

/** The row the clean view draws for a run of tool calls: how many, of which tools. */
function hiddenRow(calls, width) {
  const counts = new Map()
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1)
  const tools = [...counts].map(([tool, count]) => (count === 1 ? tool : `${count} ${tool}`)).join(', ')
  const errors = calls.filter(call => call.isError).length
  const text = `⋯ ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'} · ${tools}`
  const tail = errors === 0 ? '' : ` · ${errors} ${errors === 1 ? 'error' : 'errors'}`
  return { segs: [{ t: truncate(text, Math.max(8, width - textWidth(tail))), s: S.gray }, ...(tail === '' ? [] : [{ t: tail, s: S.red }])] }
}

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** What the fold keys group a call under: a file's diff, a shell run, or neither. */
const callKind = call => (DIFF_TOOLS.has(call.tool) ? 'diff' : call.tool === 'Bash' ? 'bash' : 'other')

/** A tool call as rows: its summary, and beneath it the result when unfolded. */
function callRows(call, stored, width) {
  const label = callLabel(call)
  const stamp = stampText(call.time)
  // Set apart from Claude's prose by color: the tool's name in the tool
  // color, its argument and summary gray; red throughout for an error.
  const summaryRow = (mark, tail, isUnfolded, isError = false) => {
    const fitted = fitLabel(label, tail, width - stampRoom(stamp))
    const name = fitted.startsWith(call.tool) ? call.tool : ''
    const tone = isError ? S.red : S.tool
    const rest = isError ? S.red : S.gray
    const segs = [
      { t: `${mark} `, s: tone },
      { t: name, s: sgr(tone, isUnfolded ? S.bold : '') },
      { t: `${fitted.slice(name.length)} · ${tail}`, s: rest },
    ]
    // When it was called, at the row's end.
    return stamp === '' ? segs : (stamped(segs, stamp, width) ?? segs)
  }
  const head = (mark, tail, isUnfolded, isError) => ({
    segs: summaryRow(mark, tail, isUnfolded, isError),
    call: { id: call.id, isUnfolded, kind: callKind(call) },
  })

  if (call.isError) {
    const isUnfolded = stored ?? true
    return [
      head(isUnfolded ? '▾' : '▸', 'error', isUnfolded, true),
      ...(isUnfolded ? capped(plainRows(call.text === '' ? 'failed' : call.text, width, S.red)) : []),
    ]
  }
  if (!call.isAnswered) return [{ segs: summaryRow('•', 'running…', false) }]

  const { summary, body } = callResult(call, width)
  if (body.length === 0) return [{ segs: summaryRow('•', summary, false) }]
  const isUnfolded = stored ?? false
  return [head(isUnfolded ? '▾' : '▸', summary, isUnfolded), ...(isUnfolded ? capped(body) : [])]
}

/** An entry as plain text for the clipboard: prose as written, a call with its result. */
function copyText(entry) {
  if (entry.kind !== 'call') return entry.text
  const out = entry.result !== null && typeof entry.result === 'object' ? entry.result : {}
  const input = entry.input ?? {}
  if (entry.tool === 'Bash') {
    const output = entry.isError
      ? entry.text
      : [out.stdout, out.stderr].filter(part => typeof part === 'string' && part.trim() !== '').join('\n') || entry.text
    return `$ ${input.command ?? ''}\n${output ?? ''}`.trimEnd()
  }
  if (Array.isArray(out.structuredPatch) && out.structuredPatch.length > 0) {
    const file = out.filePath ?? input.file_path ?? ''
    const hunks = out.structuredPatch.map(
      hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${(hunk.lines ?? []).join('\n')}`,
    )
    return `--- ${file}\n+++ ${file}\n${hunks.join('\n')}`
  }
  if (typeof out.content === 'string' && !entry.isError) return out.content
  return `${callLabel(entry)}\n${entry.text ?? ''}`.trimEnd()
}

/**
 * Puts text on the clipboard: by OSC 52, which reaches the person's own
 * terminal through a multiplexer and over ssh, and by a local tool where
 * this machine has a display of its own.
 */
function copyToClipboard(out, text) {
  out.write(`${ESC}]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
  const tools =
    process.platform === 'darwin'
      ? [['pbcopy']]
      : process.env.WAYLAND_DISPLAY
        ? [['wl-copy']]
        : process.env.DISPLAY
          ? [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]
          : []
  for (const [command, ...args] of tools) {
    const ran = spawnSync(command, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 })
    if (ran.status === 0) return
  }
}

// ───────────────────────────── transcript ─────────────────────────────

/**
 * A slash command sent to Claude (a skill, a custom command): its name and
 * arguments. One the engine ran itself (/clear, /model) starts with its name
 * instead, and is no message.
 */
const COMMAND = /^\s*<command-message>[\s\S]*?<\/command-message>\s*<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-args>([\s\S]*)<\/command-args>)?/

/**
 * A person's prompt with the engine's tagged blocks taken out; '' for none.
 * A slash command reads as it was typed.
 */
function promptText(text) {
  const command = COMMAND.exec(text)
  if (command !== null) return `${command[1]} ${command[2] ?? ''}`.trim()
  return text.replace(/<([a-z][a-z0-9-]*)>[\s\S]*?<\/\1>/g, '').trim()
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' ? (block.text ?? '') : block?.type === 'image' ? '[image]' : '')).join('\n')
}

/** The conversation read off a transcript file, kept current by `poll`. */
class Transcript {
  constructor(resolve) {
    this.resolve = resolve
    this.file = undefined
    this.reset()
  }

  reset() {
    this.offset = 0
    this.partial = ''
    this.seen = new Set()
    /** { kind: 'prompt' | 'text' | 'call', ... } in transcript order. */
    this.entries = []
    this.calls = new Map()
    this.prompts = []
  }

  /**
   * Stands the opener's snapshot of the conversation (SessionMessage[]) in
   * for a transcript that holds no prompt yet; the file's own replace it.
   */
  seed(messages) {
    this.seeded = messages
    this.entries = []
    this.calls = new Map()
    this.prompts = []
    for (const message of messages) {
      if (message.role === 'user') {
        const text = (message.toolResults?.length ?? 0) > 0 ? '' : promptText(message.text ?? '')
        if (text === '') continue
        this.prompts.push(this.entries.length)
        this.entries.push({ kind: 'prompt', text })
        continue
      }
      if ((message.text ?? '').trim() !== '') this.entries.push({ kind: 'text', text: message.text })
      for (const use of message.toolUses ?? []) {
        this.entries.push({
          kind: 'call',
          id: use.tool_use_id,
          tool: use.tool,
          input: use.input ?? {},
          isAnswered: use.result !== undefined || use.text !== undefined || use.isError === true,
          isError: use.isError === true,
          text: use.text ?? '',
          result: use.result,
        })
      }
    }
  }

  /** Reads what the file gained; true when the conversation changed. */
  poll() {
    if (this.seeded === undefined) return this.read()
    // The file's rows are taken on their own; they stand once they hold a prompt.
    let size = -1
    try {
      size = this.file === undefined ? -1 : fs.statSync(this.file).size
    } catch {}
    if (this.file !== undefined && size === this.seededSize) return false
    this.seededSize = size
    const { seeded } = this
    this.seeded = undefined
    this.entries = []
    this.calls = new Map()
    this.prompts = []
    this.offset = 0
    this.partial = ''
    this.seen = new Set()
    this.read()
    if (this.prompts.length > 0) return true
    this.seed(seeded)
    return false
  }

  read() {
    this.file ??= this.resolve()
    if (this.file === undefined) return false
    let size
    try {
      size = fs.statSync(this.file).size
    } catch {
      return false
    }
    if (size === this.offset) return false
    if (size < this.offset) this.reset()

    const fd = fs.openSync(this.file, 'r')
    try {
      const buffer = Buffer.alloc(size - this.offset)
      const got = fs.readSync(fd, buffer, 0, buffer.length, this.offset)
      this.offset += got
      this.partial += buffer.subarray(0, got).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }

    const lines = this.partial.split('\n')
    this.partial = lines.pop() ?? ''
    let isChanged = false
    for (const line of lines) {
      if (line === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (this.take(record)) isChanged = true
    }
    return isChanged
  }

  take(record) {
    if (record.isSidechain === true || record.message === undefined) return false
    if (record.type !== 'user' && record.type !== 'assistant') return false
    if (record.uuid !== undefined) {
      if (this.seen.has(record.uuid)) return false
      this.seen.add(record.uuid)
    }
    const content = record.message.content
    const time = Date.parse(record.timestamp)

    if (record.type === 'assistant') {
      let isChanged = false
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'text' && (block.text ?? '').trim() !== '') {
          this.entries.push({ kind: 'text', text: block.text, time })
          isChanged = true
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
          // What Claude notes between its tool calls: a thinking block holding
          // text. Its reasoning proper is one holding none.
          this.entries.push({ kind: 'thinking', text: block.thinking.trimEnd(), time })
          isChanged = true
        } else if (block.type === 'tool_use') {
          const call = { kind: 'call', id: block.id, tool: block.name, input: block.input ?? {}, isAnswered: false, isError: false, text: '', result: undefined, time }
          this.calls.set(block.id, call)
          this.entries.push(call)
          isChanged = true
        }
      }
      return isChanged
    }

    const results = Array.isArray(content) ? content.filter(block => block?.type === 'tool_result') : []
    if (results.length > 0) {
      for (const block of results) {
        const call = this.calls.get(block.tool_use_id)
        if (call === undefined) continue
        call.isAnswered = true
        call.isError = block.is_error === true
        call.text = blockText(block.content)
        call.result = results.length === 1 ? record.toolUseResult : undefined
      }
      return true
    }
    if (record.isMeta === true || record.isCompactSummary === true) return false
    const text = promptText(blockText(content))
    if (text === '') return false
    this.prompts.push(this.entries.length)
    this.entries.push({ kind: 'prompt', text })
    return true
  }
}

function transcriptResolver(args) {
  if (args.file !== undefined) return () => args.file
  const base = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  const name = `${args.session}.jsonl`
  return () => {
    if (args.cwd !== undefined) {
      const direct = path.join(base, args.cwd.replace(/[^a-zA-Z0-9]/g, '-'), name)
      if (fs.existsSync(direct)) return direct
    }
    try {
      for (const dir of fs.readdirSync(base)) {
        const found = path.join(base, dir, name)
        if (fs.existsSync(found)) return found
      }
    } catch {}
    return undefined
  }
}

// ───────────────────────────── the view ─────────────────────────────

const NAV = [
  { key: 'p', label: '◂ older' },
  { key: 'n', label: 'newer ▸' },
  { key: 'e', label: 'expand' },
  { key: 'a', label: 'open all' },
  { key: 'A', label: 'fold all' },
  { key: 'z', label: 'clean' },
  { key: 't', label: 'hide 💭' },
  { key: '?', label: 'help' },
  { key: 'q', label: 'close' },
]

const HELP = [
  ['Messages', [
    ['p   n', 'older, newer message of yours'],
    ['e', 'show or hide the whole message'],
  ]],
  ['Items (Claude\'s replies and tool calls)', [
    ['↑   ↓', 'previous, next item'],
    ['shift+tab  tab', 'the same'],
    ['→   ←', 'open, fold the item'],
    ['o  enter', 'open or fold the item'],
    ['c', 'copy the item (a call: its command or diff, and output)'],
    ['click', 'pick the item; on its first row, open or fold it'],
    ['drag', 'select text: copied when the button is let go'],
  ]],
  ['Scrolling', [
    ['k   j', 'one row up, down'],
    ['u  PgUp', 'one page up'],
    ['d  PgDn  space', 'one page down'],
    ['g  Home', 'top'],
    ['G  End', 'bottom, and follow new output'],
    ['wheel', 'three rows'],
  ]],
  ['All at once', [
    ['a   A', 'open, fold everything: tool calls (errors too), replies, thinking'],
    ['f   F', 'open, fold the diffs (Edit, Write)'],
    ['b   B', 'open, fold the Bash output'],
    ['r   R', 'open, fold Claude\'s replies and thinking'],
    ['z', 'clean view: hide the tool calls, or show them again'],
    ['t', 'hide Claude\'s thinking (💭) between the calls, or show it again'],
  ]],
  ['Other', [
    ['m', 'mouse off or on (off: the terminal\'s own selection)'],
    ['ctrl+l', 'redraw'],
    ['?  h', 'this help'],
    ['q  esc', 'close'],
  ]],
]

/** The plugin's version off its manifest; '' when it cannot be read. */
function pluginVersion() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json')
    const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    return typeof version === 'string' ? version : ''
  } catch {
    return ''
  }
}

const VERSION = pluginVersion()

function helpRows(width) {
  const keys = Math.max(...HELP.flatMap(([, items]) => items.map(([key]) => textWidth(key))))
  const rows = []
  for (const [title, items] of HELP) {
    if (rows.length > 0) rows.push(row())
    rows.push(row(`  ${title}`, sgr(S.bold, S.magenta)))
    for (const [key, text] of items) {
      const first = [{ t: `    ${key.padEnd(keys)}   `, s: sgr(S.bold, S.cyan) }]
      rows.push(...wrapSegs([{ t: text, s: '' }], width, { first, hang: [{ t: ' '.repeat(keys + 7), s: '' }] }))
    }
  }
  return rows
}

const SCROLL_KEYS = new Set(['k', 'up', 'j', 'down', 'u', 'pageup', 'd', 'space', 'pagedown', 'g', 'home', 'G', 'end', 'm'])

class View {
  constructor(transcript, out) {
    this.transcript = transcript
    this.out = out
    /** The prompt shown, by its place among the prompts; newest while `isNewest`. */
    this.turn = 0
    this.isNewest = true
    this.isExpanded = false
    this.scroll = 0
    /** Holds the window at the end as the turn grows. */
    this.isFollowing = false
    this.isMouseOn = true
    /** The clean view: tool calls hidden, Claude's words alone. */
    this.isClean = false
    /** Claude's thinking between its tool calls left out. */
    this.isThinkingHidden = false
    this.folds = new Map()
    /** The item under the cursor: its place among the turn's entries after the prompt. */
    this.cursor = 0
    /** A line in the rule for a moment (what `c` copied), and when it goes. */
    this.notice = ''
    this.noticeUntil = 0
    this.rows = undefined
    this.rowsWidth = 0
    this.hits = []
    /** While set, the help stands in for the turn; `scroll` is kept aside. */
    this.isHelp = false
    this.turnScroll = 0
    /** Where the mouse was last, and what of the header it was over when last drawn. */
    this.pointer = undefined
    this.hovered = ''
    /** The row the window started at when the turn was last drawn. */
    this.drawnScroll = 0
    /** Where the button went down, until it is let go. */
    this.pressed = undefined
    /** A drag's two ends in screen cells, from 1: where it began, where the mouse is. */
    this.selection = undefined
    /** The rows last drawn as text, each with the cells on its left a selection leaves out. */
    this.plain = []
  }

  get columns() {
    return Math.max(20, this.out.columns ?? 80)
  }

  get windowRows() {
    return Math.max(1, (this.out.rows ?? 24) - this.headerRows)
  }

  /** A blank row between the keys and the message, where there is height. */
  get gapRows() {
    return (this.out.rows ?? 24) < ROOMY_ROWS ? 0 : 1
  }

  /** The keys row, the gap, the message's rows, the rule. */
  get headerRows() {
    return this.titleRows().length + this.gapRows + 2
  }

  /** The message as the header shows it: its first rows, marked when cut. */
  titleRows() {
    const width = this.columns - 2
    if (this.isHelp) return [`${`ccpopout ${VERSION}`.trimEnd()} · Keys · any key returns`]
    const prompt = this.entries()[0]
    if (prompt === undefined) {
      return [this.transcript.file === undefined ? 'Waiting for the session to write its transcript…' : 'No messages yet.']
    }
    const text = `${this.turn + 1}/${this.count} › ${clean(prompt.text)}`
    const all = text
      .split('\n')
      .filter(line => line.trim() !== '')
      .flatMap(line => wrapSegs([{ t: line, s: '' }], width).map(wrapped => wrapped.segs.map(seg => seg.t).join('')))
    const most = this.isExpanded || (this.out.rows ?? 24) < ROOMY_ROWS ? 1 : TITLE_ROWS
    if (all.length <= most) return all
    const rows = all.slice(0, most)
    if (!this.isExpanded) {
      const last = rows[most - 1]
      rows[most - 1] = textWidth(last) + 2 > width ? truncate(`${last}  `, width) : `${last} …`
    }
    return rows
  }

  get count() {
    return this.transcript.prompts.length
  }

  changed() {
    if (this.isNewest) {
      const newest = Math.max(0, this.count - 1)
      if (newest !== this.turn) this.show(newest)
    }
    this.rows = undefined
  }

  show(turn) {
    const to = Math.max(0, Math.min(this.count - 1, turn))
    this.isNewest = to >= this.count - 1
    if (to === this.turn && this.rows !== undefined) return
    this.turn = to
    this.isExpanded = false
    this.isFollowing = false
    this.scroll = 0
    this.cursor = 0
    this.rows = undefined
  }

  /** The entries of the turn shown: its prompt first. */
  entries() {
    const { prompts, entries } = this.transcript
    if (prompts.length === 0) return []
    return entries.slice(prompts[this.turn], prompts[this.turn + 1] ?? entries.length)
  }

  /** The turn's calls that fold, in order. */
  foldable() {
    if (this.isHelp) return []
    return this.build().flatMap(line => (line.call === undefined ? [] : [line.call]))
  }

  build() {
    let width = this.columns
    if (this.rows !== undefined && this.rowsWidth === width) return this.rows
    if (this.isHelp) {
      this.rows = helpRows(width - BAR)
      this.rowsWidth = width
      return this.rows
    }
    const [prompt, ...rest] = this.entries()
    const first = this.transcript.prompts[this.turn] ?? 0
    const rows = []
    // Two cells on the left are the cursor's: the bar beside the item it is on.
    const full = width
    width -= GUTTER + BAR
    if (prompt !== undefined && this.isExpanded) {
      for (const line of clean(prompt.text).split('\n')) rows.push(...wrapSegs([{ t: line, s: S.bold }], width))
      rows.push(row('─'.repeat(width), S.gray))
    }
    // The clean view leaves Claude's words alone: each run of tool calls
    // between them is one row saying how many there were.
    let hidden = []
    const flush = () => {
      if (hidden.length === 0) return
      rows.push(hiddenRow(hidden, width))
      hidden = []
    }
    rest.forEach((entry, item) => {
      if (entry.kind === 'call' && this.isClean) return hidden.push(entry)
      if (entry.kind === 'thinking' && this.isThinkingHidden) return
      flush()
      if (entry.kind === 'text' || entry.kind === 'thinking') {
        if (rows.length > 0 && rows.at(-1).segs.length > 0) rows.push(row())
        // Claude's own words: a bullet on the first row, the rest under it.
        // A reply of several rows folds to its first, as a call does.
        // Its thinking is set apart: a thought bubble for the bullet, gray italics.
        const isThinking = entry.kind === 'thinking'
        const mark = isThinking ? '💭 ' : '● '
        const pad = ' '.repeat(textWidth(mark))
        // Folded, the bubble stays beside the fold's mark: the rows leave room for both.
        const foldedMark = isThinking ? `▸ ${mark}` : '▸ '
        const foldedPad = ' '.repeat(textWidth(foldedMark))
        let prose = proseRows(entry.text, width - foldedPad.length)
        if (isThinking) prose = prose.map(line => ({ ...line, segs: line.segs.map(seg => ({ ...seg, s: sgr(S.stamp, S.italic, seg.s) })) }))
        const id = `text:${first + 1 + item}`
        const isUnfolded = this.folds.get(id) ?? true
        const fold = prose.length > FOLDED_ROWS ? { id, isUnfolded, kind: 'text' } : undefined
        const stamp = stampText(entry.time)
        if (fold !== undefined && !isUnfolded) {
          // Folded, its first rows of text stay, the last saying how much there is.
          const kept = prose.filter(line => line.segs.length > 0).slice(0, FOLDED_ROWS)
          const tail = ` · ${prose.length} lines`
          kept.forEach((line, at) => {
            const lead = at === 0 ? { t: foldedMark, s: S.bold } : { t: foldedPad, s: '' }
            const isLast = at === kept.length - 1
            const segs = isLast ? [...cutSegs(line.segs, Math.max(8, width - foldedPad.length - textWidth(tail) - stampRoom(stamp))), { t: tail, s: S.gray }] : line.segs
            rows.push({ ...line, item, call: at === 0 ? fold : undefined, segs: [lead, ...segs] })
          })
        } else {
          prose.forEach((line, at) => {
            const lead = at === 0 ? { t: mark, s: S.bold } : { t: pad, s: '' }
            rows.push({ ...line, item, call: at === 0 ? fold : undefined, segs: [lead, ...line.segs] })
          })
        }
        if (stamp !== '') {
          // When it was written: at the end of its last row, or on one of its own.
          const last = rows.at(-1)
          const segs = stamped(last.segs, stamp, width)
          if (segs !== undefined) last.segs = segs
          else rows.push({ item, segs: stamped([], stamp, width) ?? [] })
        }
        rows.push(row())
      } else if (entry.kind === 'call') {
        for (const line of callRows(entry, this.folds.get(entry.id), width)) rows.push({ ...line, item })
      }
    })
    flush()
    while (rows.length > 0 && rows.at(-1).segs.length === 0) rows.pop()
    if (rows.length === 0 && prompt !== undefined) rows.push(row('Claude has not answered this message yet.', S.dim))
    this.rows = rows
    this.rowsWidth = full
    return rows
  }

  get maxScroll() {
    return Math.max(0, this.build().length - this.windowRows)
  }

  scrollBy(by) {
    const max = this.maxScroll
    this.scroll = Math.max(0, Math.min(max, Math.min(this.scroll, max) + by))
    this.isFollowing = by > 0 && this.isFollowing && this.scroll >= max
  }

  /** The call under the cursor when it folds; undefined on prose or a call with nothing to show. */
  cursorCall() {
    if (this.isHelp) return undefined
    return this.build().find(line => line.item === this.cursor && line.call !== undefined)?.call
  }

  /** Opens (true), folds (false) or toggles (undefined) the call under the cursor. */
  fold(isUnfolded) {
    const call = this.cursorCall()
    if (call === undefined || call.isUnfolded === isUnfolded) return
    this.folds.set(call.id, isUnfolded ?? !call.isUnfolded)
    this.rows = undefined
    this.reveal()
  }

  /** Scrolls so the item under the cursor shows: whole when it fits, else its top. */
  reveal() {
    const rows = this.build()
    const first = rows.findIndex(line => line.item === this.cursor)
    if (first === -1) return
    const last = rows.findLastIndex(line => line.item === this.cursor)
    const scroll = Math.min(this.scroll, this.maxScroll)
    if (first < scroll) this.scroll = first
    else if (last >= scroll + this.windowRows) this.scroll = Math.min(first, last - this.windowRows + 1)
    else return
    this.isFollowing = false
  }

  /** After items were hidden or shown: a cursor on one now hidden comes to the item after it, or the last. */
  settle() {
    this.rows = undefined
    const items = [...new Set(this.build().flatMap(line => (line.item === undefined ? [] : [line.item])))]
    if (!items.includes(this.cursor)) this.cursor = items.find(item => item > this.cursor) ?? items.at(-1) ?? 0
    this.reveal()
  }

  /** Moves the cursor an item up or down. */
  move(step) {
    const rows = this.build()
    const items = [...new Set(rows.filter(line => line.item !== undefined).map(line => line.item))]
    if (items.length === 0) return
    const scroll = Math.min(this.scroll, this.maxScroll)
    const shown = rows.slice(scroll, scroll + this.windowRows)
    if (!shown.some(line => line.item === this.cursor)) {
      // Scrolled out of sight: the cursor comes to what is on screen.
      const near = (step > 0 ? shown : shown.toReversed()).find(line => line.item !== undefined)
      if (near !== undefined) {
        this.cursor = near.item
        return this.reveal()
      }
    }
    const at = items.indexOf(this.cursor)
    let next
    if (at !== -1) next = at + step
    else next = step > 0 ? items.findIndex(item => item > this.cursor) : items.findLastIndex(item => item < this.cursor)
    if (next < 0 || next >= items.length) {
      // At either end the window still moves, so the first and last rows are reached.
      return this.scrollBy(step)
    }
    this.cursor = items[next]
    this.reveal()
  }

  copy() {
    const entry = this.entries()[this.cursor + 1]
    if (entry === undefined || this.isHelp) return
    this.copied(copyText(entry))
  }

  copied(text) {
    copyToClipboard(this.out, text)
    const lines = text.split('\n').length
    this.notice = ` copied · ${lines} ${lines === 1 ? 'line' : 'lines'} `
    this.noticeUntil = Date.now() + 2000
  }

  /** True when the notice has run its time and the rule is to be redrawn. */
  expire() {
    if (this.notice === '' || Date.now() < this.noticeUntil) return false
    this.notice = ''
    return true
  }

  /** Opens or folds everything of the turn that folds (calls, replies, thinking), or what is of one kind. */
  foldAll(isUnfolded, kind) {
    for (const call of this.foldable()) {
      if (kind === undefined || call.kind === kind) this.folds.set(call.id, isUnfolded)
    }
    this.rows = undefined
  }

  help(isShown) {
    if (isShown === this.isHelp) return
    if (isShown) this.turnScroll = this.scroll
    this.isHelp = isShown
    this.scroll = isShown ? 0 : this.turnScroll
    if (isShown) this.isFollowing = false
    this.rows = undefined
  }

  key(name) {
    const page = Math.max(1, this.windowRows - 1)
    if (name === '?' || name === 'h') return this.help(!this.isHelp)
    if (this.isHelp && !SCROLL_KEYS.has(name)) return this.help(false)
    if (this.isHelp && (name === 'up' || name === 'down')) return this.scrollBy(name === 'up' ? -1 : 1)
    switch (name) {
      case 'p':
        return this.show(this.turn - 1)
      case 'n':
        return this.show(this.turn + 1)
      case 'up':
      case 'shift+tab':
        return this.move(-1)
      case 'down':
      case 'tab':
        return this.move(1)
      case 'right':
        return this.fold(true)
      case 'left':
        return this.fold(false)
      case 'c':
        return this.copy()
      case 'z':
        this.isClean = !this.isClean
        return this.settle()
      case 't':
        this.isThinkingHidden = !this.isThinkingHidden
        return this.settle()
      case 'e':
        this.isExpanded = !this.isExpanded
        this.scroll = 0
        this.rows = undefined
        return
      case 'k':
        return this.scrollBy(-1)
      case 'j':
        return this.scrollBy(1)
      case 'u':
      case 'pageup':
        return this.scrollBy(-page)
      case 'd':
      case 'space':
      case 'pagedown':
        return this.scrollBy(page)
      case 'g':
      case 'home':
        this.isFollowing = false
        this.scroll = 0
        this.cursor = this.build().find(line => line.item !== undefined)?.item ?? 0
        return
      case 'G':
      case 'end':
        this.isFollowing = true
        this.scroll = this.maxScroll
        this.cursor = this.build().findLast(line => line.item !== undefined)?.item ?? 0
        return
      case 'enter':
      case 'o':
        return this.fold(undefined)
      case 'a':
        return this.foldAll(true)
      case 'A':
        return this.foldAll(false)
      case 'f':
        return this.foldAll(true, 'diff')
      case 'F':
        return this.foldAll(false, 'diff')
      case 'b':
        return this.foldAll(true, 'bash')
      case 'B':
        return this.foldAll(false, 'bash')
      case 'r':
        return this.foldAll(true, 'text')
      case 'R':
        return this.foldAll(false, 'text')
      case 'm':
        this.isMouseOn = !this.isMouseOn
        this.out.write(this.isMouseOn ? MOUSE_ON : MOUSE_OFF)
        return
    }
  }

  /** What of the header the mouse is over: a key of the keys row, 'title' for the message, '' for neither. */
  over() {
    if (this.pointer === undefined || !this.isMouseOn) return ''
    const { x, y } = this.pointer
    if (y === 1) {
      const hit = this.hits.find(found => x >= found.from && x < found.to)
      return hit === undefined || hit.isOff ? '' : hit.key
    }
    return !this.isHelp && this.count > 0 && y < this.headerRows ? 'title' : ''
  }

  /** The mouse moved; true when what it is over changed, and the header is to be redrawn. */
  point(x, y) {
    this.pointer = { x, y }
    return this.over() !== this.hovered
  }

  /** The cells of screen row `y` the selection covers, from 0 and up to; undefined for none. */
  span(y) {
    const drag = this.selection
    if (drag === undefined) return undefined
    const isForward = drag.from.y < drag.to.y || (drag.from.y === drag.to.y && drag.from.x <= drag.to.x)
    const [first, last] = isForward ? [drag.from, drag.to] : [drag.to, drag.from]
    const row = this.plain[y - 1]
    if (row === undefined || y < first.y || y > last.y) return undefined
    return [Math.max(row.skip, y === first.y ? first.x - 1 : 0), y === last.y ? last.x : Infinity]
  }

  /** What the selection holds, as the rows on screen read; '' for nothing. */
  selectionText() {
    const rows = []
    this.plain.forEach((row, at) => {
      const span = this.span(at + 1)
      if (span !== undefined) rows.push(cellSlice(row.text, span[0], span[1]).text.trimEnd())
    })
    return rows.join('\n').trim() === '' ? '' : rows.join('\n')
  }

  /** The button went down: the keys row answers at once, the rest when it is let go. */
  press(x, y) {
    this.selection = undefined
    this.pressed = undefined
    if (y === 1) return this.click(x, y)
    this.pressed = { x, y }
  }

  /** The mouse moved, the button held or not; true when the selection changed. */
  drag(x, y, isHeld) {
    if (!isHeld) this.pressed = undefined
    if (this.pressed === undefined) return false
    if (this.selection === undefined && x === this.pressed.x && y === this.pressed.y) return false
    this.selection = { from: this.pressed, to: { x, y } }
    return true
  }

  /** The button was let go: a drag is copied, a press in place is a click. */
  release() {
    const { pressed } = this
    this.pressed = undefined
    if (pressed === undefined) return
    const text = this.selectionText()
    if (text !== '') return this.copied(text)
    this.selection = undefined
    this.click(pressed.x, pressed.y)
  }

  click(x, y) {
    if (y === 1) {
      const hit = this.hits.find(found => x >= found.from && x < found.to)
      if (hit !== undefined) this.key(hit.key)
      return
    }
    if (this.isHelp) return this.help(false)
    if (y < this.headerRows) return this.key('e')
    if (y === this.headerRows) return
    const line = this.build()[this.scroll + y - this.headerRows - 1]
    if (line?.item === undefined) return
    this.cursor = line.item
    if (line.call !== undefined) this.fold(undefined)
  }

  draw() {
    const width = this.columns
    const rows = this.build()
    const max = this.maxScroll
    if (this.isFollowing) this.scroll = max
    this.scroll = Math.max(0, Math.min(max, this.scroll))
    const shown = rows.slice(this.scroll, this.scroll + this.windowRows)
    // A cursor the window left out of sight comes to the nearest item still in
    // it: the top one going down, the bottom one going up.
    if (!this.isHelp && !shown.some(line => line.item === this.cursor)) {
      const near = (this.scroll >= this.drawnScroll ? shown : shown.toReversed()).find(line => line.item !== undefined)
      if (near !== undefined) this.cursor = near.item
    }
    if (!this.isHelp) this.drawnScroll = this.scroll
    const frame = []

    // Row 1: the keys, each a press target.
    this.hits = []
    const isOff = { p: this.turn <= 0, n: this.turn >= this.count - 1 }
    let nav = ''
    let used = 1
    for (const item of NAV) {
      const label =
        item.key === 'e' && this.isExpanded ? 'collapse' : item.key === 'z' && this.isClean ? 'full' : item.key === 't' && this.isThinkingHidden ? 'show 💭' : item.label
      const cells = textWidth(item.key) + 1 + textWidth(label)
      if (used + cells + 2 > width) break
      // A cell either side is the key's too: the press target, lit under the mouse.
      const hit = { key: item.key, from: used, to: used + cells + 2, isOff: isOff[item.key] === true }
      this.hits.push(hit)
      const isOver = !hit.isOff && this.isMouseOn && this.pointer?.y === 1 && this.pointer.x >= hit.from && this.pointer.x < hit.to
      const bg = isOver ? S.hoverBg : S.headerBg
      const tone = hit.isOff ? S.dim : ''
      nav += `${ESC}[${sgr(bg, S.bold, S.cyan, tone)}m ${item.key}${RESET}${ESC}[${sgr(bg, tone)}m ${label} ${RESET}`
      used += cells + 2
    }
    frame.push(`${nav}${ESC}[${S.headerBg}m${ESC}[K${RESET}`)

    // The message is a press target too (it shows whole, or its start again).
    const titleBg = this.over() === 'title' ? S.hoverBg : S.headerBg
    if (this.gapRows === 1) frame.push(`${ESC}[${titleBg}m${ESC}[K${RESET}`)

    // Then which message, and how it starts.
    for (const title of this.titleRows()) {
      frame.push(`${ESC}[${sgr(titleBg, S.bold)}m ${truncate(title, width - 2)}${ESC}[K${RESET}`)
    }

    // The rule, with where the window is: in the tool color, to be read among the dashes.
    // How many rows there are above and below the window, or that it is at an end.
    const below = rows.length - this.scroll - shown.length
    const range = max === 0 ? '' : ` ${this.scroll === 0 ? 'top' : `↑ ${this.scroll}`} · ${below <= 0 ? 'end' : `↓ ${below}`} `
    // The scroll bar: the window's share of the rows, at its place among them.
    const thumb = Math.max(1, Math.round((this.windowRows * this.windowRows) / Math.max(1, rows.length)))
    const thumbAt = max === 0 ? 0 : Math.round((this.scroll / max) * (this.windowRows - thumb))
    const bar = at =>
      max === 0 ? '' : `${ESC}[${width}G${RESET}${at >= thumbAt && at < thumbAt + thumb ? `${ESC}[${S.cyan}m┃` : `${ESC}[${sgr(S.gray, S.dim)}m│`}${RESET}`
    const live = this.notice !== '' ? this.notice : this.isFollowing ? ' following ' : ''
    const rule = '─'.repeat(Math.max(0, width - range.length - live.length - 2))
    frame.push(`${ESC}[${S.gray}m${rule}${ESC}[${S.tool}m${live}${range}${ESC}[${S.gray}m──${RESET}`)

    const bodyAt = frame.length
    for (let at = 0; at < this.windowRows; at++) {
      const line = shown[at]
      if (this.isHelp) frame.push(`${paint(line, width - BAR)}${bar(at)}`)
      else frame.push(`${RESET}${line?.item === this.cursor ? `${ESC}[${S.cyan}m▌ ` : '  '}${paint(line, width - GUTTER - BAR)}${bar(at)}`)
    }

    // A selection leaves out the cursor's cells beside the turn's rows.
    this.plain = frame.map((line, at) => ({ text: plainOf(line), skip: at >= bodyAt && !this.isHelp ? GUTTER : 0 }))
    let text = `${ESC}[?2026h`
    frame.forEach((line, at) => {
      text += `${ESC}[${at + 1};1H${line}`
    })
    // The selection, drawn over its rows in reverse.
    this.plain.forEach((row, at) => {
      const span = this.span(at + 1)
      if (span === undefined) return
      const cut = cellSlice(row.text, span[0], span[1])
      if (cut.text !== '') text += `${ESC}[${at + 1};${cut.start + 1}H${ESC}[${S.inverse}m${cut.text}${RESET}`
    })
    this.out.write(`${text}${ESC}[?2026l`)
    this.hovered = this.over()
  }
}

/** One row as terminal text, cleared (or filled with its tint) to the edge. */
function paint(line, width) {
  if (line === undefined) return `${RESET}${ESC}[K`
  let text = ''
  let used = 0
  for (const seg of line.segs) {
    const style = sgr(line.bg, seg.s)
    text += style === '' ? `${RESET}${seg.t}` : `${RESET}${ESC}[${style}m${seg.t}`
    used += textWidth(seg.t)
  }
  if (line.bg !== undefined) return `${text}${RESET}${ESC}[${line.bg}m${' '.repeat(Math.max(0, width - used))}${RESET}`
  return `${text}${RESET}${ESC}[K`
}

// ───────────────────────────── input ─────────────────────────────

// Presses, and every move of the mouse: the header lights what it is over.
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1003h${ESC}[?1006h`
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1003l${ESC}[?1000l`

const SEQUENCES = {
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  '[H': 'home',
  '[F': 'end',
  OH: 'home',
  OF: 'end',
  '[1~': 'home',
  '[4~': 'end',
  '[7~': 'home',
  '[8~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  '[Z': 'shift+tab',
}

/** Splits a chunk of terminal input into key names and mouse events. */
function* parseInput(chunk) {
  let at = 0
  while (at < chunk.length) {
    const rest = chunk.slice(at)
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest)
    if (mouse !== null) {
      yield { mouse: { button: Number(mouse[1]), x: Number(mouse[2]), y: Number(mouse[3]), isDown: mouse[4] === 'M' } }
      at += mouse[0].length
      continue
    }
    if (rest[0] === ESC) {
      // Any control sequence is taken whole, known or not; a bare Esc is the key.
      const sequence = /^\x1b(\[[0-9;<=>?]*[ -/]*[@-~]|O[A-Za-z])/.exec(rest)
      if (sequence !== null) {
        const name = SEQUENCES[sequence[1]]
        if (name !== undefined) yield { key: name }
        at += sequence[0].length
        continue
      }
      if (rest.length === 1) yield { key: 'escape' }
      at += rest.length === 1 || rest[1] === ESC ? 1 : 2
      continue
    }
    const ch = [...rest][0]
    at += ch.length
    if (ch === '\r' || ch === '\n') yield { key: 'enter' }
    else if (ch === '\t') yield { key: 'tab' }
    else if (ch === ' ') yield { key: 'space' }
    else if (ch === '\x03') yield { key: 'ctrl+c' }
    else if (ch === '\x04') yield { key: 'ctrl+d' }
    else if (ch === '\x0c') yield { key: 'ctrl+l' }
    else yield { key: ch }
  }
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv) {
  const args = {}
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === '--session') args.session = argv[++at]
    else if (argv[at] === '--snapshot') args.snapshot = argv[++at]
    else if (argv[at] === '--clean') args.isClean = true
    else if (argv[at] === '--cwd') args.cwd = argv[++at]
    else if (argv[at] === '--help' || argv[at] === '-h') args.isHelp = true
    else if (argv[at] === '--version') args.isVersion = true
    else args.file = argv[at]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.isVersion) {
    process.stdout.write(`ccpopout ${VERSION}\n`)
    process.exit(0)
  }
  if (args.isHelp || (args.file === undefined && args.session === undefined)) {
    process.stderr.write('usage: popout.mjs <transcript.jsonl> | --session <id> [--cwd <dir>] [--snapshot <messages.json>] [--clean]\n')
    process.exit(args.isHelp ? 0 : 2)
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('popout: needs a terminal\n')
    process.exit(2)
  }

  const transcript = new Transcript(transcriptResolver(args))
  const view = new View(transcript, process.stdout)
  view.isClean = args.isClean === true
  transcript.poll()
  if (args.snapshot !== undefined) {
    // Read once and removed: the conversation is not left lying in a file.
    try {
      const messages = JSON.parse(fs.readFileSync(args.snapshot, 'utf8'))
      if (transcript.prompts.length === 0 && Array.isArray(messages)) transcript.seed(messages)
    } catch {}
    fs.rmSync(args.snapshot, { force: true })
  }
  view.changed()

  let isClosed = false
  const close = code => {
    if (isClosed) return
    isClosed = true
    process.stdout.write(`${MOUSE_OFF}${RESET}${ESC}[?25h${ESC}[?1049l`)
    try {
      process.stdin.setRawMode(false)
    } catch {}
    process.exit(code)
  }

  process.stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J${MOUSE_ON}`)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  process.stdin.on('data', chunk => {
    let isDirty = false
    for (const event of parseInput(chunk)) {
      if (event.mouse !== undefined && (event.mouse.button & 32) !== 0) {
        // A move: drawn only when it changes what the mouse is over, or selects.
        const isOver = view.point(event.mouse.x, event.mouse.y)
        if (view.drag(event.mouse.x, event.mouse.y, (event.mouse.button & 3) === 0) || isOver) isDirty = true
        continue
      }
      isDirty = true
      if (event.mouse !== undefined) {
        const { button, x, y, isDown } = event.mouse
        view.point(x, y)
        if (button === 0 && isDown) view.press(x, y)
        else if (button === 0) view.release()
        else {
          // The rows move under a selection: it is let go.
          view.selection = undefined
          view.pressed = undefined
          if (button === 64) view.scrollBy(-WHEEL_ROWS)
          else if (button === 65) view.scrollBy(WHEEL_ROWS)
        }
      } else if (event.key === 'ctrl+c' || event.key === 'ctrl+d') {
        return close(0)
      } else if ((event.key === 'q' || event.key === 'escape') && !view.isHelp) {
        return close(0)
      } else if (event.key === 'ctrl+l') {
        process.stdout.write(`${ESC}[2J`)
      } else {
        view.selection = undefined
        view.key(event.key)
      }
    }
    if (isDirty) view.draw()
  })
  process.stdout.on('resize', () => {
    view.rows = undefined
    view.selection = undefined
    process.stdout.write(`${ESC}[2J`)
    view.draw()
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => close(0))
  process.on('uncaughtException', error => {
    process.stdout.write(`${MOUSE_OFF}${RESET}${ESC}[?25h${ESC}[?1049l`)
    console.error(error)
    process.exit(1)
  })

  setInterval(() => {
    const isChanged = transcript.poll()
    if (isChanged) {
      view.changed()
      view.selection = undefined
    }
    if (isChanged || view.expire()) view.draw()
  }, POLL_MS)

  view.draw()
}

main()
