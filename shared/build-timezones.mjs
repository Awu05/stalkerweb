#!/usr/bin/env node
// The time zone list (shared/timezones.json) written out for the website and
// the apps, so both offer the same zones by the same names:
//   frontend/src/lib/timezones.generated.js
//   android/.../data/repo/TimezoneList.kt
//
//   node shared/build-timezones.mjs           write them
//   node shared/build-timezones.mjs --check   exit 1 if either differs (the web tests run this)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { zones } = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'timezones.json'), 'utf8'))
const HEADER = 'Generated from shared/timezones.json by shared/build-timezones.mjs — do not edit; change timezones.json and run `node shared/build-timezones.mjs`.'

const js = () => `// ${HEADER}

/** Every time zone a connection can use: [IANA name, country code] — UTC first, then by name. */
export const ZONES = [
${zones.map(([id, cc]) => `  [${JSON.stringify(id)}, ${JSON.stringify(cc)}],`).join('\n')}
]
`

const kotlin = () => `// ${HEADER}
package com.stalkerweb.android.data.repo

/** Every time zone a connection can use: IANA name to country code — UTC first, then by name. */
val TIMEZONE_LIST: List<Pair<String, String>> = listOf(
${zones.map(([id, cc]) => `    ${JSON.stringify(id)} to ${JSON.stringify(cc)},`).join('\n')}
)
`

const OUTPUTS = [
  ['frontend/src/lib/timezones.generated.js', js],
  ['android/app/src/main/java/com/stalkerweb/android/data/repo/TimezoneList.kt', kotlin],
]

const check = process.argv.includes('--check')
const stale = []
for (const [rel, make] of OUTPUTS) {
  const file = path.join(root, rel)
  const want = make()
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
  if (have === want) continue
  if (check) stale.push(rel)
  else { fs.writeFileSync(file, want); console.log(`timezones: wrote ${rel}`) }
}
if (check && stale.length) {
  console.error(`timezones: out of date with shared/timezones.json: ${stale.join(', ')} — run \`node shared/build-timezones.mjs\``)
  process.exit(1)
}
