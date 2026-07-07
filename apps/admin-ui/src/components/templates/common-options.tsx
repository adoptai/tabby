interface Props {
  step: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground mb-1';

export function CommonOptions({ step, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className={labelClass}>Timeout (ms)</label>
        <input
          type="number"
          min={0}
          value={(step.timeout_ms as number) ?? ''}
          onChange={(e) => onChange('timeout_ms', e.target.value === '' ? undefined : Number(e.target.value))}
          placeholder="30000"
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Retry Count</label>
        <input
          type="number"
          min={0}
          value={(step.retry_count as number) ?? ''}
          onChange={(e) => onChange('retry_count', e.target.value === '' ? undefined : Number(e.target.value))}
          placeholder="1"
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Retry Backoff</label>
        <select
          value={(step.retry_backoff as string) ?? ''}
          onChange={(e) => onChange('retry_backoff', e.target.value || undefined)}
          className={inputClass}
        >
          <option value="">default (fixed)</option>
          <option value="fixed">fixed</option>
          <option value="exponential">exponential</option>
        </select>
      </div>

      <div>
        <label className={labelClass}>Retry Delay (ms)</label>
        <input
          type="number"
          min={0}
          value={(step.retry_delay_ms as number) ?? ''}
          onChange={(e) => onChange('retry_delay_ms', e.target.value === '' ? undefined : Number(e.target.value))}
          placeholder="1000"
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Retry Max Delay (ms)</label>
        <input
          type="number"
          min={0}
          value={(step.retry_max_delay_ms as number) ?? ''}
          onChange={(e) => onChange('retry_max_delay_ms', e.target.value === '' ? undefined : Number(e.target.value))}
          placeholder="30000"
          className={inputClass}
        />
      </div>

      <div className="flex items-end pb-2">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={(step.sensitive as boolean) ?? false}
            onChange={(e) => onChange('sensitive', e.target.checked || undefined)}
            className="h-4 w-4 rounded border-border"
          />
          Sensitive
        </label>
      </div>
    </div>
  );
}
