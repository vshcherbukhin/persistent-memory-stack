import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/onboard')
for (const [source, target] of [
  ['templates/persistent-memory-rule.md', 'dist/apps/onboard/templates/persistent-memory-rule.md'],
  ['../../prompts/fact-extraction.md', 'dist/prompts/fact-extraction.md'],
]) {
  const destination = resolve(app, target)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(resolve(app, source), destination)
}
