import { mkdirSync, writeFileSync } from 'node:fs'
const directory = new URL('../generated/', import.meta.url)
mkdirSync(directory, { recursive: true })
writeFileSync(new URL('package.json', directory), '{"type":"module"}\n')
