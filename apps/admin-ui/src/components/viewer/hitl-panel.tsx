import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/api/sessions';
import { hitlApi } from '@/api/hitl';
import { StatusBadge } from '@/components/shared/status-badge';

interface Props {
  sessionId: string;
  open: boolean;
  onToggle: () => void;
  onSendClipboard?: (text: string) => void;
}

const SECTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.06em',
  color: 'var(--faint-fg)',
  marginBottom: '10px',
};

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '8px',
};

const ROW_KEY_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--muted-fg)',
};

const ROW_VALUE_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--fg)',
  fontWeight: 500,
};

export function HitlPanel({ sessionId, onSendClipboard }: Props) {
  const qc = useQueryClient();
  const [clipboard, setClipboard] = useState('');
  const [resolvedStep, setResolvedStep] = useState<number | null>(null);
  const [restartConfirm, setRestartConfirm] = useState(false);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => sessionsApi.get(sessionId),
    refetchInterval: 3_000,
  });

  const resolveMutation = useMutation({
    mutationFn: (stepIndex: number) =>
      hitlApi.submitInput(sessionId, {
        input_type: 'confirm',
        value: 'resolved',
        step_index: stepIndex,
      }),
    onSuccess: (_, stepIndex) => {
      setResolvedStep(stepIndex);
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });

  const acknowledgeMutation = useMutation({
    mutationFn: () => hitlApi.acknowledge(sessionId),
    onSuccess: () => {
      setRestartConfirm(false);
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });

  const handleSendClipboard = useCallback(() => {
    if (!clipboard) return;
    onSendClipboard?.(clipboard);
    setClipboard('');
  }, [clipboard, onSendClipboard]);

  const pending = session?.pending_input_request as
    | { input_type: string; label?: string; step_index: number }
    | null
    | undefined;

  const canResolve = !!pending && resolvedStep !== pending.step_index;
  const alreadyResolved = !!pending && resolvedStep === pending.step_index;

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        width: '320px',
        background: 'var(--card)',
        borderLeft: '1px solid var(--border)',
      }}
    >
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: '14px' }}
      >
        {/* Human input needed */}
        {pending && (
          <div
            style={{
              border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
              background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
              borderRadius: '10px',
              padding: '13px',
              marginBottom: '18px',
            }}
          >
            <div
              className="flex items-center gap-2"
              style={{ marginBottom: '4px' }}
            >
              <span style={{ fontSize: '13px' }}>⚠️</span>
              <span
                style={{
                  fontSize: '12.5px',
                  fontWeight: 700,
                  color: 'var(--warning)',
                }}
              >
                Human input needed
              </span>
            </div>
            <p
              style={{
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--muted-fg)',
                marginBottom: '6px',
              }}
            >
              {pending.input_type}
            </p>
            {pending.label && (
              <p
                style={{
                  fontSize: '13px',
                  color: 'var(--fg)',
                  marginBottom: '12px',
                }}
              >
                {pending.label}
              </p>
            )}
            <button
              onClick={() => resolveMutation.mutate(pending.step_index)}
              disabled={!canResolve || resolveMutation.isPending}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: '7px',
                border: 'none',
                background: alreadyResolved
                  ? 'color-mix(in srgb, var(--success) 60%, transparent)'
                  : 'var(--success)',
                color: '#fff',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: canResolve && !resolveMutation.isPending ? 'pointer' : 'default',
                opacity: !canResolve || resolveMutation.isPending ? 0.6 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {resolveMutation.isPending
                ? 'Resolving…'
                : alreadyResolved
                  ? 'Resolved'
                  : 'Mark as resolved'}
            </button>
          </div>
        )}

        {/* Clipboard */}
        <div style={{ marginBottom: '20px' }}>
          <p style={SECTION_LABEL_STYLE}>Clipboard</p>
          <div className="flex gap-2">
            <input
              type="password"
              value={clipboard}
              onChange={(e) => setClipboard(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendClipboard()}
              placeholder="Text to paste into VNC"
              style={{
                flex: 1,
                height: '34px',
                padding: '0 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '7px',
                fontSize: '12px',
                color: 'var(--fg)',
                outline: 'none',
              }}
            />
            <button
              onClick={handleSendClipboard}
              disabled={!clipboard || !onSendClipboard}
              style={{
                height: '34px',
                padding: '0 12px',
                background: 'var(--primary)',
                border: 'none',
                borderRadius: '7px',
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--primary-fg)',
                cursor: clipboard && onSendClipboard ? 'pointer' : 'default',
                opacity: !clipboard || !onSendClipboard ? 0.45 : 1,
                transition: 'opacity 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              Send
            </button>
          </div>
          {!onSendClipboard && (
            <p
              style={{
                fontSize: '11px',
                color: 'var(--faint-fg)',
                marginTop: '5px',
              }}
            >
              Clipboard paste is available in VNC mode only.
            </p>
          )}
        </div>

        {/* Session status */}
        <div style={{ marginBottom: '20px' }}>
          <p style={SECTION_LABEL_STYLE}>Session Status</p>
          <div style={ROW_STYLE}>
            <span style={ROW_KEY_STYLE}>State</span>
            <StatusBadge value={session?.state} />
          </div>
          <div style={ROW_STYLE}>
            <span style={ROW_KEY_STYLE}>Health</span>
            <StatusBadge value={session?.health_result_type} />
          </div>
          <div style={ROW_STYLE}>
            <span style={ROW_KEY_STYLE}>Interventions</span>
            <span style={ROW_VALUE_STYLE}>{session?.hitl_attempt_count ?? 0}</span>
          </div>
          <div style={{ ...ROW_STYLE, marginBottom: 0 }}>
            <span style={ROW_KEY_STYLE}>Retries</span>
            <span style={ROW_VALUE_STYLE}>{session?.retry_count ?? 0}</span>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div
        style={{
          padding: '14px',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <p
          style={{
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--error)',
            marginBottom: '10px',
          }}
        >
          Danger Zone
        </p>

        {!restartConfirm ? (
          <button
            onClick={() => setRestartConfirm(true)}
            style={{
              width: '100%',
              padding: '7px 12px',
              background: 'transparent',
              border: '1px solid var(--error)',
              borderRadius: '7px',
              fontSize: '12.5px',
              fontWeight: 500,
              color: 'var(--error)',
              cursor: 'pointer',
            }}
          >
            Restart session
          </button>
        ) : (
          <div>
            <p
              style={{
                fontSize: '12px',
                color: 'var(--warning)',
                marginBottom: '10px',
              }}
            >
              This will acknowledge the failure and trigger a retry. Are you sure?
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setRestartConfirm(false)}
                style={{
                  flex: 1,
                  height: '30px',
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => acknowledgeMutation.mutate()}
                disabled={acknowledgeMutation.isPending}
                style={{
                  flex: 1,
                  height: '30px',
                  background: 'var(--error)',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#fff',
                  cursor: acknowledgeMutation.isPending ? 'default' : 'pointer',
                  opacity: acknowledgeMutation.isPending ? 0.6 : 1,
                }}
              >
                {acknowledgeMutation.isPending ? 'Sending…' : 'Confirm'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
