import { copyFileSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, runNpm } from './host-runtime.mjs'
import { pythonInvocation } from './python-runtime.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, PYTHONPATH: [join(root, '.local/mkdocs-python'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) }
const options = { cwd: root, env }
if (process.argv[2] === 'install') {
  const python = pythonInvocation(['-m', 'pip', 'install', '--disable-pip-version-check', '--target', '.local/mkdocs-python', '-r', 'documentation/requirements.txt'])
  await run(python.command, python.args, options)
  await runNpm(['ci', '--prefix', 'apps/documentation'], options)
} else if (process.argv[2] === 'build') {
  for (const script of ['docs:generate', 'docs:check-navigation', 'docs:check-diagrams']) await runNpm(['run', script], options)
  // Insert the local dependency target explicitly: embedded Windows Python can
  // ignore PYTHONPATH, while ordinary Python still uses the same pinned modules.
  const python = pythonInvocation(['-c', "import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module('mkdocs', run_name='__main__')", join(root, '.local/mkdocs-python'), 'build', '--site-dir', '.local/generated-docs/site'])
  await run(python.command, python.args, options)
  const target = join(root, '.local/generated-docs/site/assets/javascripts')
  mkdirSync(target, { recursive: true })
  copyFileSync(join(root, 'apps/documentation/node_modules/mermaid/dist/mermaid.min.js'), join(target, 'mermaid.min.js'))
} else throw new Error('Usage: node scripts/docs-tool.mjs install|build')
