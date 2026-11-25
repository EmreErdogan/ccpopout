#!/usr/bin/env node
// Installs the ccpopout mod in Herdr Desktop, so that `/popout left` opens
// ccpopout's side pane on the left. Run it where Desktop runs, with Desktop
// open: node herdr-app/install.mjs
//
// 1. Copies herdr-app/ccpopout to Desktop's mods folder (an older copy is replaced).
// 2. Where the window shows a layout Herdr ships, which takes no mods,
//    duplicates it as <name>-ccpopout and switches to that.
// 3. Adds the mod's block, 0 px wide, to the layout shown, unless it is there.
// 4. Checks the mod with `herdr-app check`.
//
// Running it again updates the mod and changes nothing else.

import { cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPED, SUFFIX, exists, hasBlock, herdrApp, modPath, readLayout, run, shownLayout, withBlock } from './common.mjs'

const say = text => console.log(`ccpopout: ${text}`)

try {
  let layout = shownLayout()

  const to = modPath()
  rmSync(to, { recursive: true, force: true })
  cpSync(join(dirname(fileURLToPath(import.meta.url)), 'ccpopout'), to, { recursive: true })
  say(`copied the mod to ${to}`)

  if (SHIPPED.includes(layout)) {
    const copy = `${layout}${SUFFIX}`
    if (exists(copy)) {
      run('layout.switch', { name: copy })
      say(`switched to the layout ${copy}`)
    } else {
      run('layout.clone', { name: layout, as: copy })
      say(`duplicated the layout ${layout} as ${copy}, and switched to it: Herdr adds no mods to its own layouts`)
    }
    layout = copy
    if (shownLayout() !== layout) throw new Error(`Herdr Desktop did not switch to the layout ${layout}`)
  }

  const tree = readLayout(layout)
  if (hasBlock(tree)) {
    say(`the layout ${layout} already has the mod`)
  } else {
    run('layout.set', { layout: withBlock(tree) })
    say(`added the mod to the layout ${layout}`)
  }

  herdrApp('check', to)
  const errors = (herdrApp('status').errors ?? []).filter(error => String(error).includes('ccpopout'))
  if (errors.length > 0) throw new Error(`Herdr Desktop reports: ${errors.join('; ')}`)
  say('installed: /popout left now opens the side pane on the left')
} catch (error) {
  console.error(`ccpopout: not installed: ${error.message}`)
  process.exit(1)
}
