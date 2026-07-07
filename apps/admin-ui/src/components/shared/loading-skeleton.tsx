import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse', className)}
      style={{ background: 'var(--card-2)', borderRadius: '6px' }}
    />
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--border)' }}>
      <table className="w-full">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--card-2) 60%, transparent)' }}>
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i} className="px-4 py-3">
                <Skeleton className="h-4 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r} style={{ borderBottom: r < rows - 1 ? '1px solid var(--border)' : 'none' }}>
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c} className="px-4 py-3">
                  <Skeleton className="h-4 w-24" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div
      className="p-4 space-y-3"
      style={{
        borderRadius: '12px',
        border: '1px solid var(--border)',
        background: 'var(--card)',
      }}
    >
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-8 w-12" />
    </div>
  );
}
