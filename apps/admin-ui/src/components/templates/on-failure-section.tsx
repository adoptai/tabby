import { HUMAN_INPUT_TYPES } from './step-types';

interface OnFailureValue {
  action: 'skip' | 'abort' | 'request_help';
  message?: string;
  input_type?: string;
  screenshot?: boolean;
}

interface Props {
  step: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground mb-1';

export function OnFailureSection({ step, onChange }: Props) {
  const raw = step.on_failure as OnFailureValue | undefined;
  const action = raw?.action ?? '';

  function setField(field: keyof OnFailureValue, value: unknown) {
    const current = (step.on_failure as OnFailureValue | undefined) ?? { action: 'skip' };
    onChange('on_failure', { ...current, [field]: value });
  }

  function handleActionChange(next: string) {
    if (!next) {
      onChange('on_failure', undefined);
      return;
    }
    const base: OnFailureValue = { action: next as OnFailureValue['action'] };
    onChange('on_failure', base);
  }

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Action</label>
        <select
          value={action}
          onChange={(e) => handleActionChange(e.target.value)}
          className={inputClass}
        >
          <option value="">— none —</option>
          <option value="skip">skip</option>
          <option value="abort">abort</option>
          <option value="request_help">request_help</option>
        </select>
      </div>

      {action === 'request_help' && (
        <>
          <div>
            <label className={labelClass}>Message</label>
            <input
              type="text"
              value={raw?.message ?? ''}
              onChange={(e) => setField('message', e.target.value || undefined)}
              placeholder="Please help with this step"
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass}>Input Type (optional)</label>
            <select
              value={raw?.input_type ?? ''}
              onChange={(e) => setField('input_type', e.target.value || undefined)}
              className={inputClass}
            >
              <option value="">— none —</option>
              {HUMAN_INPUT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={raw?.screenshot ?? false}
              onChange={(e) => setField('screenshot', e.target.checked || undefined)}
              className="h-4 w-4 rounded border-border"
            />
            Capture screenshot
          </label>
        </>
      )}
    </div>
  );
}
