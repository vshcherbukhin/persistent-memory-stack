import { fileURLToPath } from 'node:url'
import { run } from './host-runtime.mjs'
import { pythonInvocation } from './python-runtime.mjs'
for (const pattern of ['test_usage_telemetry.py', 'test_anthropic_compat.py', 'test_dependency_pins.py']) {
  const python = pythonInvocation(['-m', 'unittest', 'discover', '-s', 'tests', '-p', pattern])
  await run(python.command, python.args, { cwd: fileURLToPath(new URL('../apps/graphiti-service', import.meta.url)) })
}
