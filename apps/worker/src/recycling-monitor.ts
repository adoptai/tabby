/**
 * Session Recycling Monitor per spec FR-34.
 *
 * Monitors worker memory usage and session age.
 * Signals controller for recycling when:
 * - Memory exceeds watermark (default 2.5 GB)
 * - Session age exceeds max_session_age_hours (default 24)
 *
 * Recycling procedure (handled by controller):
 * 1. Export artifacts
 * 2. Terminate pod
 * 3. Controller recreates pod and triggers re-login
 */
export class RecyclingMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly startTime = Date.now();

  constructor(
    private readonly sessionId: string,
    private readonly maxAgeHours: number = 24,
    private readonly memoryWatermarkMb: number = 2560, // 2.5 GB
    private readonly onRecycleNeeded: (reason: string) => Promise<void>,
  ) {}

  start(intervalMs: number = 30000): void {
    this.timer = setInterval(() => this.check(), intervalMs);
    console.log(
      `Recycling monitor started: maxAge=${this.maxAgeHours}h, memoryWatermark=${this.memoryWatermarkMb}MB`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    // Check memory watermark
    const heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapUsedMb > this.memoryWatermarkMb) {
      console.warn(`Memory watermark exceeded: ${heapUsedMb}MB > ${this.memoryWatermarkMb}MB`);
      await this.onRecycleNeeded(`memory_watermark_exceeded:${heapUsedMb}MB`);
      return;
    }

    // Check session age
    const ageHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
    if (ageHours > this.maxAgeHours) {
      console.warn(`Session age exceeded: ${ageHours.toFixed(1)}h > ${this.maxAgeHours}h`);
      await this.onRecycleNeeded(`max_age_exceeded:${ageHours.toFixed(1)}h`);
      return;
    }
  }
}
