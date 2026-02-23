import { Page } from 'playwright';

/**
 * Screenshot Fallback Mode per spec FR-36.
 *
 * When VNC frame rate drops below 1 FPS for >30 seconds,
 * captures screenshots at 2-second intervals for the viewer.
 * Resumes VNC streaming when bandwidth recovers.
 *
 * Screenshots stored in shared /tmp volume accessible by noVNC sidecar.
 */
export class ScreenshotFallback {
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private lowFpsStartTime: number | null = null;
  private readonly LOW_FPS_THRESHOLD = 1;
  private readonly LOW_FPS_DURATION_MS = 30000;
  private readonly CAPTURE_INTERVAL_MS = 2000;
  private readonly SCREENSHOT_PATH = '/tmp/fallback-screenshot.png';

  constructor(private readonly page: Page) {}

  /**
   * Called periodically with current VNC frame rate.
   * Triggers fallback mode when FPS stays below threshold.
   */
  reportFrameRate(fps: number): void {
    if (fps < this.LOW_FPS_THRESHOLD) {
      if (this.lowFpsStartTime === null) {
        this.lowFpsStartTime = Date.now();
      }

      const duration = Date.now() - this.lowFpsStartTime;
      if (duration > this.LOW_FPS_DURATION_MS && !this.active) {
        console.warn(`VNC frame rate below ${this.LOW_FPS_THRESHOLD} FPS for ${duration}ms, activating screenshot fallback`);
        this.startCapture();
      }
    } else {
      this.lowFpsStartTime = null;
      if (this.active) {
        console.log('VNC bandwidth recovered, deactivating screenshot fallback');
        this.stopCapture();
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  getScreenshotPath(): string {
    return this.SCREENSHOT_PATH;
  }

  private startCapture(): void {
    this.active = true;

    this.timer = setInterval(async () => {
      try {
        await this.page.screenshot({ path: this.SCREENSHOT_PATH });
      } catch {
        // Page may be navigating, skip this frame
      }
    }, this.CAPTURE_INTERVAL_MS);
  }

  private stopCapture(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.stopCapture();
    this.lowFpsStartTime = null;
  }
}
