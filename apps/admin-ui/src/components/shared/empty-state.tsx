export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: '1px dashed var(--border-2)',
        borderRadius: '12px',
        padding: '60px 20px',
        textAlign: 'center',
        background: 'var(--card)',
      }}
    >
      <p
        style={{
          fontSize: '15px',
          fontWeight: 600,
          color: 'var(--fg)',
        }}
      >
        {title}
      </p>
      {description && (
        <p
          style={{
            fontSize: '12.5px',
            color: 'var(--muted-fg)',
            marginTop: '5px',
          }}
        >
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: '16px' }}>{action}</div>}
    </div>
  );
}
