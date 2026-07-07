declare module '@novnc/novnc/lib/rfb.js' {
  interface RFBOptions {
    wsProtocols?: string[];
    credentials?: { password?: string };
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    addEventListener(event: string, handler: (e: any) => void): void;
    disconnect(): void;
    clipboardPasteFrom(text: string): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
  }
}
