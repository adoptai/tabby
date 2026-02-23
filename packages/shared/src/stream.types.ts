// ============================================================
// BrowserStreamProvider Interface (per spec section 11.5)
// ============================================================

export interface StreamHandle {
  sessionId: string;
  startedAt: string;            // ISO 8601
}

export interface InputEvent {
  type: 'mouse' | 'keyboard';
  data: Record<string, unknown>;
}

export interface StreamMetrics {
  fps: number;
  latencyMs: number;
  connected: boolean;
}

export interface CdpStreamConfig {
  quality: number;        // 1-80
  maxWidth: number;       // max 1920
  maxHeight: number;      // max 1080
  everyNthFrame: number;  // min 1
}

export interface BrowserStreamProvider {
  /**
   * Start streaming for a session. Activates the VNC/CDP streaming pipeline.
   */
  startStream(sessionId: string): Promise<StreamHandle>;

  /**
   * Stop streaming for a session. Deactivates the streaming pipeline.
   */
  stopStream(sessionId: string): Promise<void>;

  /**
   * Generate a signed, short-lived URL for the stream viewer.
   */
  getStreamUrl(sessionId: string, userId: string): Promise<{ url: string; expires_at: string }>;

  /**
   * Send a user input event to the browser session.
   */
  sendInput(sessionId: string, event: InputEvent): Promise<void>;

  /**
   * Check if streaming is currently active for a session.
   */
  isStreaming(sessionId: string): Promise<boolean>;

  /**
   * Get the current frame rate and connection quality metrics.
   */
  getStreamMetrics(sessionId: string): Promise<StreamMetrics>;
}
