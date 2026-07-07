import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  HEALTHY: { bg: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)' },
  PASS: { bg: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)' },
  ACTIVE: { bg: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)' },
  ENABLED: { bg: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)' },
  STARTING: { bg: 'color-mix(in srgb, var(--info) 15%, transparent)', color: 'var(--info)' },
  STAGING: { bg: 'color-mix(in srgb, var(--info) 15%, transparent)', color: 'var(--info)' },
  UNHEALTHY: { bg: 'color-mix(in srgb, var(--warning) 15%, transparent)', color: 'var(--warning)' },
  LOGIN_NEEDED: { bg: 'color-mix(in srgb, var(--warning) 15%, transparent)', color: 'var(--warning)' },
  CANARY: { bg: 'color-mix(in srgb, var(--warning) 15%, transparent)', color: 'var(--warning)' },
  TRANSIENT_FAIL: { bg: 'color-mix(in srgb, var(--warning) 15%, transparent)', color: 'var(--warning)' },
  LOGIN_IN_PROGRESS: { bg: 'color-mix(in srgb, var(--violet) 15%, transparent)', color: 'var(--violet)' },
  FAILED: { bg: 'color-mix(in srgb, var(--error) 15%, transparent)', color: 'var(--error)' },
  AUTH_FAIL: { bg: 'color-mix(in srgb, var(--error) 15%, transparent)', color: 'var(--error)' },
  TERMINATED: { bg: 'color-mix(in srgb, var(--neutral) 15%, transparent)', color: 'var(--neutral)' },
  RETIRED: { bg: 'color-mix(in srgb, var(--neutral) 15%, transparent)', color: 'var(--neutral)' },
  DISABLED: { bg: 'color-mix(in srgb, var(--neutral) 15%, transparent)', color: 'var(--neutral)' },
};

const FALLBACK_STYLE: { bg: string; color: string } = {
  bg: 'color-mix(in srgb, var(--neutral) 15%, transparent)',
  color: 'var(--neutral)',
};

export function StatusBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const display = value ?? 'N/A';
  const { bg, color } = STATUS_STYLES[display] ?? FALLBACK_STYLE;

  return (
    <span
      className={cn('inline-flex items-center', className)}
      style={{
        backgroundColor: bg,
        color,
        fontSize: '11px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '3px 8px',
        borderRadius: '6px',
      }}
    >
      {display}
    </span>
  );
}
