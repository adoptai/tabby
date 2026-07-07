import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router';
import { sessionsApi } from '@/api/sessions';
import { VncViewer } from './vnc-viewer';
import { CdpViewer } from './cdp-viewer';
import { HitlPanel } from './hitl-panel';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export function ViewerPage() {
  const { id } = useParams<{ id: string }>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [streamData, setStreamData] = useState<{ token: string; mode: string } | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('connecting');
  const rfbClipboardRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    if (!id) return;
    sessionsApi
      .stream(id)
      .then((res) => {
        const token =
          res.stream_token ??
          (() => {
            try {
              return new URL(res.url, window.location.origin).hash.replace('#', '');
            } catch {
              return '';
            }
          })();
        const mode = res.mode ?? 'vnc';
        setStreamData({ token, mode });
        // CDP has no explicit connect callback — mark connected optimistically
        if (mode === 'cdp') setConnStatus('connected');
      })
      .catch((err) => {
        const message =
          err?.response?.data?.error?.message ??
          err?.response?.data?.message ??
          'Failed to get stream URL';
        setFetchError(message);
        setConnStatus('disconnected');
      });
  }, [id]);

  const handleRfbReady = useCallback(
    (rfb: { clipboardPasteFrom: (text: string) => void }) => {
      rfbClipboardRef.current = (text: string) => rfb.clipboardPasteFrom(text);
      setConnStatus('connected');
    },
    [],
  );

  const handleDisconnect = useCallback(() => {
    setConnStatus('disconnected');
  }, []);

  const handleSendClipboard = useCallback((text: string) => {
    rfbClipboardRef.current?.(text);
  }, []);

  const isVnc = streamData ? streamData.mode !== 'cdp' : true;
  const modeLabel = streamData ? (isVnc ? 'VNC Stream' : 'CDP Stream') : 'Stream';

  const statusDotColor =
    connStatus === 'connected'
      ? 'var(--success)'
      : connStatus === 'connecting'
        ? 'var(--warning)'
        : 'var(--error)';

  const statusDotGlow =
    connStatus === 'connected'
      ? '0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent)'
      : connStatus === 'connecting'
        ? '0 0 0 3px color-mix(in srgb, var(--warning) 22%, transparent)'
        : '0 0 0 3px color-mix(in srgb, var(--error) 22%, transparent)';

  return (
    <div
      className="-m-6 flex flex-col overflow-hidden"
      style={{
        height: 'calc(100vh - 3.5rem)',
        background: '#08090b',
      }}
    >
      {/* Top connection bar */}
      <div
        className="flex items-center gap-3 px-3 shrink-0"
        style={{
          height: '38px',
          background: 'var(--card)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {/* Back button */}
        <Link
          to={id ? `/sessions/${id}` : '/sessions'}
          className="flex items-center gap-1 px-2 text-[12px] font-medium transition-colors"
          style={{
            height: '26px',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            color: 'var(--fg)',
            textDecoration: 'none',
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = 'var(--card-2)')
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = 'var(--card)')
          }
        >
          ‹ Back
        </Link>

        {/* Connection status */}
        <div className="flex items-center gap-2 flex-1">
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: statusDotColor,
              boxShadow: statusDotGlow,
              display: 'inline-block',
              flexShrink: 0,
              transition: 'background 0.2s, box-shadow 0.2s',
            }}
          />
          <span
            style={{
              fontSize: '12.5px',
              fontWeight: 600,
              color: 'var(--fg)',
            }}
          >
            {modeLabel}
          </span>
          {id && (
            <span
              style={{
                fontSize: '11px',
                fontFamily: 'monospace',
                color: 'var(--faint-fg)',
              }}
            >
              {id}
            </span>
          )}
        </div>

        {/* HITL panel toggle */}
        <button
          onClick={() => setPanelOpen((o) => !o)}
          style={{
            height: '26px',
            padding: '0 10px',
            background: 'var(--card-2)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 500,
            color: 'var(--fg)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          HITL Panel
          <span style={{ fontSize: '10px', opacity: 0.6 }}>{panelOpen ? '›' : '‹'}</span>
        </button>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Viewer */}
        <div
          className="flex-1 relative overflow-hidden"
          style={{ background: '#0a0a0c' }}
        >
          {fetchError ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <p style={{ color: 'var(--error)', fontSize: '13px' }}>{fetchError}</p>
              <Link
                to={id ? `/sessions/${id}` : '/sessions'}
                style={{ color: 'var(--primary)', fontSize: '13px' }}
              >
                ← Back to session
              </Link>
            </div>
          ) : !streamData || !id ? (
            <div
              className="flex items-center justify-center h-full"
              style={{ color: 'var(--muted-fg)', fontSize: '13px' }}
            >
              Connecting to stream&hellip;
            </div>
          ) : isVnc ? (
            <VncViewer
              sessionId={id}
              token={streamData.token}
              onRfbReady={handleRfbReady}
              onDisconnect={handleDisconnect}
            />
          ) : (
            <CdpViewer
              sessionId={id}
              token={streamData.token}
              onDisconnect={handleDisconnect}
            />
          )}

          {/* Bottom-left mode info */}
          {streamData && (
            <div
              className="absolute bottom-2 left-3 pointer-events-none"
              style={{
                fontFamily: 'monospace',
                fontSize: '11px',
                color: 'var(--faint-fg)',
              }}
            >
              {isVnc ? 'vnc' : 'cdp'} · {connStatus}
            </div>
          )}
        </div>

        {/* HITL side panel */}
        {panelOpen && id && (
          <HitlPanel
            sessionId={id}
            open={panelOpen}
            onToggle={() => setPanelOpen((o) => !o)}
            onSendClipboard={isVnc ? handleSendClipboard : undefined}
          />
        )}
      </div>
    </div>
  );
}
