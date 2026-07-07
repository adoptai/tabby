import { useState } from 'react';

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  requireInput?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  requireInput,
  onConfirm,
  onCancel,
}: Props) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const canConfirm = !requireInput || input === requireInput;

  if (!open) return null;

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--elev)',
          border: '1px solid var(--border-2)',
          borderRadius: '12px',
          padding: '24px',
          width: '420px',
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
        }}
      >
        <h3
          style={{
            fontSize: '18px',
            fontWeight: 700,
            color: 'var(--fg)',
            marginBottom: '8px',
          }}
        >
          {title}
        </h3>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--muted-fg)',
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>

        {requireInput && (
          <div style={{ marginTop: '20px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '12.5px',
                color: 'var(--muted-fg)',
                marginBottom: '6px',
              }}
            >
              Type{' '}
              <code
                style={{
                  background: 'var(--card-2)',
                  padding: '1px 5px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: 'var(--fg)',
                }}
              >
                {requireInput}
              </code>{' '}
              to confirm
            </label>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '13px',
                color: 'var(--fg)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}

        <div
          className="flex justify-end gap-3"
          style={{ marginTop: '24px' }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px',
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--fg)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm || loading}
            style={{
              padding: '8px 16px',
              background: destructive ? 'var(--error)' : 'var(--primary)',
              border: 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 600,
              color: destructive ? '#fff' : 'var(--primary-fg)',
              cursor: !canConfirm || loading ? 'default' : 'pointer',
              opacity: !canConfirm || loading ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {loading ? 'Processing…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
