import { useEffect, useRef, useCallback, useState } from 'react';
import { env } from '@/env';

interface Props {
  sessionId: string;
  token: string;
  onDisconnect?: () => void;
  onRfbReady?: (rfb: { clipboardPasteFrom: (text: string) => void }) => void;
}

export function VncViewer({ sessionId, token, onDisconnect, onRfbReady }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  const connect = useCallback(async () => {
    if (!canvasRef.current) return;

    const apiUrl = env.apiUrl();
    const wsBase = apiUrl.replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/vnc-ws?session_id=${sessionId}&token=${encodeURIComponent(token)}`;

    try {
      const { default: RFB } = await import('@novnc/novnc/lib/rfb.js');
      const rfb = new RFB(canvasRef.current, wsUrl, {
        wsProtocols: ['binary'],
      });

      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;

      rfb.addEventListener('connect', () => {
        setStatus('connected');
        onRfbReady?.(rfb);
      });
      rfb.addEventListener('disconnect', () => {
        setStatus('disconnected');
        onDisconnect?.();
      });

      rfbRef.current = rfb;
    } catch (err) {
      console.error('[VncViewer] Failed to initialize RFB:', err);
      setStatus('disconnected');
    }
  }, [sessionId, token, onDisconnect, onRfbReady]);

  useEffect(() => {
    connect();
    return () => {
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [connect]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card text-xs shrink-0">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            status === 'connected'
              ? 'bg-emerald-500'
              : status === 'connecting'
                ? 'bg-amber-500 animate-pulse'
                : 'bg-red-500'
          }`}
        />
        <span className="text-muted-foreground">VNC {status}</span>
      </div>
      <div ref={canvasRef} className="flex-1 bg-black overflow-hidden" />
    </div>
  );
}
