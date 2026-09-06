/** Keep the host installer alive while an operation owns a work lease. */
export class IdleLifecycle {
  private lastActivity: number
  private activeWork = 0

  constructor(
    private readonly timeoutMs = 30 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    this.lastActivity = now()
  }

  touch(): void {
    this.lastActivity = this.now()
  }

  beginWork(): () => void {
    this.activeWork++
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeWork--
      // A completed operation starts a fresh idle window, even when its browser
      // disconnected or the operation ran longer than the normal idle timeout.
      this.touch()
    }
  }

  shouldExit(): boolean {
    return this.activeWork === 0 && this.now() - this.lastActivity > this.timeoutMs
  }
}
