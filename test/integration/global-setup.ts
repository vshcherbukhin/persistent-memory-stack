/** Refuse to mutate a normal personal/shared stack even when env vars are set. */
export default async function setupIntegrationTarget(): Promise<void> {
  if (process.env.PM_ALLOW_LIVE_INTEGRATION !== '1' || process.env.PM_TEST_STACK !== '1') {
    throw new Error(
      'This suite is restricted to the disposable DEV stack. Run `npm run dev-test:run`; ' +
      'do not target a personal or shared installation.',
    )
  }

  const baseUrl = process.env.PM_API_BASE ?? 'http://127.0.0.1:18090'
  let response: Response
  try {
    response = await fetch(`${baseUrl}/config`)
  } catch (error) {
    throw new Error(`Could not reach the disposable DEV stack at ${baseUrl}: ${String(error)}`)
  }
  if (!response.ok) throw new Error(`Disposable DEV stack preflight failed: GET /config returned ${response.status}.`)
  const body = await response.json() as { deploymentMode?: unknown; testStack?: unknown }
  if (body.deploymentMode !== 'server' || body.testStack !== true) {
    throw new Error(
      `Refusing to mutate ${baseUrl}: it is not the marked server-mode disposable DEV stack ` +
      `(deploymentMode=${String(body.deploymentMode)}, testStack=${String(body.testStack)}).`,
    )
  }
}
