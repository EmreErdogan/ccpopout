#!/usr/bin/env node
// Removes the ccpopout mod from Herdr Desktop. Run it where Desktop runs,
// with Desktop open: node herdr-app/uninstall.mjs
//
// 1. Where the window shows a layout install.mjs made (<name>-ccpopout),
//    switches back to the one it was duplicated from. The copy is kept:
//    it may hold changes of your own.
// 2. Takes the mod's block out of every layout of your own.
// 3. Deletes the mod from Desktop's mods folder.
//
// /popout left then opens the side pane on the right again, and says so.

import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHIPPED, SUFFIX, appHome, hasBlock, layoutPath, modPath, readLayout, run, shownLayout, withoutBlock } from './common.mjs'

const say = text => console.log(`ccpopout: ${text}`)

try {
  let shown = shownLayout()

  const from = readLayout(shown).cloned_from?.name
  if (shown.endsWith(SUFFIX) && typeof from === 'string' && existsSync(layoutPath(from))) {
    run('layout.switch', { name: from })
    say(`switched back to the layout ${from}; ${layoutPath(shown)} is kept`)
    shown = shownLayout()
  }

  const folder = join(appHome(), 'layouts')
  const names = existsSync(folder) ? readdirSync(folder).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)) : []
  for (const name of names) {
    if (SHIPPED.includes(name)) continue
    const tree = readLayout(name)
    if (!hasBlock(tree)) continue
    // The shown layout through the window, so that it applies now; the others in their files.
    if (name === shown) run('layout.set', { layout: withoutBlock(tree) })
    else writeFileSync(layoutPath(name), `${JSON.stringify(withoutBlock(tree), null, 2)}\n`)
    say(`took the mod out of the layout ${name}`)
  }

  const mod = modPath()
  if (existsSync(mod)) {
    rmSync(mod, { recursive: true, force: true })
    say(`deleted ${mod}`)
  }
  say('uninstalled')
} catch (error) {
  console.error(`ccpopout: not uninstalled: ${error.message}`)
  process.exit(1)
}
