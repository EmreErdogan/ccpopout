// What install.mjs and uninstall.mjs share: where Herdr Desktop keeps its
// files, how to ask the running window, and the ccpopout block in a layout.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const MOD = 'ccpopout'
/** The layouts Herdr ships: it adds no mods to them, and replaces them at start. */
export const SHIPPED = ['main', 'terminals', 'win98']
/** What a layout this installer duplicated from a shipped one is called. */
export const SUFFIX = '-ccpopout'

/** The block that keeps the mod alive: 0 px wide, drawing nothing. */
export const BLOCK = { id: 'ccpopout', type: 'block', size: { px: 0 }, content: { mod: MOD } }

/** Desktop's folder, as Desktop finds it. */
export function appHome() {
  const env = name => (process.env[name] ?? '') || undefined
  return env('HERDR_APP_HOME') ?? join(env('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'herdr-app')
}

export const layoutPath = name => join(appHome(), 'layouts', `${name}.json`)
export const modPath = () => join(appHome(), 'mods', MOD)

const bin = () => process.env.HERDR_APP_BIN ?? 'herdr-app'

/** `herdr-app <args>`'s output as JSON; throws with its message when it fails. */
export function herdrApp(...args) {
  let out
  try {
    out = execFileSync(bin(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${bin()} was not found: run this where Herdr Desktop runs, or set HERDR_APP_BIN`)
    throw new Error(`${bin()} ${args[0]} ${args[1] ?? ''}: ${(error.stderr || error.stdout || error.message).trim()}`)
  }
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

/** Runs a Desktop command with JSON arguments. */
export const run = (command, args = {}) => herdrApp('do', command, JSON.stringify(args))

/** The name of the layout the window shows; throws where no window is open. */
export function shownLayout() {
  const status = herdrApp('status')
  if (typeof status?.layout !== 'string') throw new Error('Herdr Desktop did not say which layout it shows: is it open?')
  return status.layout
}

export function readLayout(name) {
  return JSON.parse(readFileSync(layoutPath(name), 'utf8'))
}

export const exists = name => existsSync(layoutPath(name))

/** Whether a layout tree has the mod's block anywhere. */
export function hasBlock(node) {
  if (node === null || typeof node !== 'object') return false
  if (node.content?.mod === MOD) return true
  return Object.values(node).some(value => (Array.isArray(value) ? value.some(hasBlock) : hasBlock(value)))
}

/** The tree with the mod's blocks taken out. */
export function withoutBlock(node) {
  if (Array.isArray(node)) return node.filter(child => child?.content?.mod !== MOD).map(withoutBlock)
  if (node === null || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withoutBlock(value)]))
}

/** The tree with the mod's block added at the end of its root. */
export function withBlock(root) {
  if (Array.isArray(root.children)) return { ...root, children: [...root.children, BLOCK] }
  // A root that is one block carries the window's own settings: not moved by guesswork.
  throw new Error(`the layout's root is not a row or column: add ${JSON.stringify(BLOCK)} to it by hand`)
}
