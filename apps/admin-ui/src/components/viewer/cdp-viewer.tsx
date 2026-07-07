import { useEffect, useRef, useState, useCallback } from 'react';
import { env } from '@/env';

interface Props {
  sessionId: string;
  token: string;
  onDisconnect?: () => void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export function CdpViewer({ sessionId, token, onDisconnect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  const sendCdp = useCallback((method: string, params?: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = nextIdRef.current++;
    ws.send(JSON.stringify({ id, method, params }));
  }, []);

  const connect = useCallback(() => {
    const apiUrl = env.apiUrl();
    const wsBase = apiUrl.replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/cdp-ws?session_id=${sessionId}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      sendCdp('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1920,
        maxHeight: 1080,
        everyNthFrame: 1,
      });
    };

    ws.onmessage = (event) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (msg.method === 'Page.screencastFrame') {
        const { data, sessionId: frameSessionId } = msg.params as {
          data: string;
          sessionId: number;
        };
        sendCdp('Page.screencastFrameAck', { sessionId: frameSessionId });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${data}`;
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      onDisconnect?.();
    };

    ws.onerror = () => {
      setStatus('disconnected');
    };
  }, [sessionId, token, sendCdp, onDisconnect]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const handleMouseEvent = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>, type: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const y = ((e.clientY - rect.top) / rect.height) * canvas.height;

      type CdpMouseType = 'mousePressed' | 'mouseReleased' | 'mouseMoved';
      const cdpType: CdpMouseType =
        type === 'mousedown'
          ? 'mousePressed'
          : type === 'mouseup'
            ? 'mouseReleased'
            : 'mouseMoved';

      const button =
        type === 'mousedown' || type === 'mouseup'
          ? e.button === 0
            ? 'left'
            : e.button === 2
              ? 'right'
              : 'middle'
          : 'none';

      sendCdp('Input.dispatchMouseEvent', {
        type: cdpType,
        x,
        y,
        button,
        clickCount: type === 'mousedown' ? 1 : 0,
      });
    },
    [sendCdp],
  );

  const handleKeyEvent = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>, type: 'keyDown' | 'keyUp') => {
      e.preventDefault();
      sendCdp('Input.dispatchKeyEvent', {
        type,
        key: e.key,
        code: e.code,
        text: type === 'keyDown' && e.key.length === 1 ? e.key : undefined,
      });
    },
    [sendCdp],
  );

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
        <span className="text-muted-foreground">CDP {status}</span>
      </div>
      <canvas
        ref={canvasRef}
        className="flex-1 bg-black cursor-default max-w-full"
        style={{ objectFit: 'contain' }}
        tabIndex={0}
        onMouseMove={(e) => handleMouseEvent(e, 'mousemove')}
        onMouseDown={(e) => handleMouseEvent(e, 'mousedown')}
        onMouseUp={(e) => handleMouseEvent(e, 'mouseup')}
        onKeyDown={(e) => handleKeyEvent(e, 'keyDown')}
        onKeyUp={(e) => handleKeyEvent(e, 'keyUp')}
      />
    </div>
  );
}
