import { HUMAN_INPUT_TYPES } from './step-types';

interface FieldProps {
  step: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground mb-1';
const checkboxLabelClass = 'flex items-center gap-2 text-sm';

function TextField({
  label,
  fieldKey,
  step,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  fieldKey: string;
  step: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        type="text"
        value={(step[fieldKey] as string) ?? ''}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        placeholder={placeholder}
        className={inputClass + (mono ? ' font-mono' : '')}
      />
    </div>
  );
}

function CheckboxField({
  label,
  fieldKey,
  step,
  onChange,
}: {
  label: string;
  fieldKey: string;
  step: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <label className={checkboxLabelClass}>
      <input
        type="checkbox"
        checked={(step[fieldKey] as boolean) ?? false}
        onChange={(e) => onChange(fieldKey, e.target.checked)}
        className="h-4 w-4 rounded border-border"
      />
      {label}
    </label>
  );
}

export function GotoFields({ step, onChange }: FieldProps) {
  return (
    <div className="space-y-3">
      <TextField label="URL" fieldKey="url" step={step} onChange={onChange} placeholder="https://example.com" mono />
      {step.url_expression != null && (
        <TextField
          label="URL Expression (JS)"
          fieldKey="url_expression"
          step={step}
          onChange={onChange}
          placeholder="'https://example.com/' + tenantId"
          mono
        />
      )}
      {step.url_expression == null && (
        <button
          type="button"
          onClick={() => onChange('url_expression', '')}
          className="text-xs text-primary hover:underline"
        >
          + Add url_expression
        </button>
      )}
    </div>
  );
}

export function SelectorValueFields({ step, onChange }: FieldProps) {
  return (
    <div className="space-y-3">
      <TextField label="Selector" fieldKey="selector" step={step} onChange={onChange} placeholder="input#username" mono />
      <TextField label="Value" fieldKey="value" step={step} onChange={onChange} placeholder="${USERNAME}" mono />
    </div>
  );
}

export function SelectorFields({ step, onChange, showFirst }: FieldProps & { showFirst?: boolean }) {
  return (
    <div className="space-y-3">
      <TextField label="Selector" fieldKey="selector" step={step} onChange={onChange} placeholder="button.submit" mono />
      {showFirst && (
        <CheckboxField label="First match only" fieldKey="first" step={step} onChange={onChange} />
      )}
    </div>
  );
}

export function PatternField({ step, onChange }: FieldProps) {
  return (
    <TextField
      label="URL Pattern (regex or glob)"
      fieldKey="pattern"
      step={step}
      onChange={onChange}
      placeholder="**/dashboard**"
      mono
    />
  );
}

export function KeyboardField({ step, onChange }: FieldProps) {
  return (
    <TextField
      label="Key"
      fieldKey="key"
      step={step}
      onChange={onChange}
      placeholder="Enter"
      mono
    />
  );
}

export function EvaluateFields({ step, onChange }: FieldProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Expression (JS)</label>
        <textarea
          value={(step.expression as string) ?? ''}
          onChange={(e) => onChange('expression', e.target.value)}
          rows={3}
          placeholder="document.querySelector('#token')?.value"
          className={inputClass + ' font-mono resize-y'}
        />
      </div>
      <TextField
        label="Store as (variable name)"
        fieldKey="store_as"
        step={step}
        onChange={onChange}
        placeholder="myVar"
        mono
      />
    </div>
  );
}

export function SleepField({ step, onChange }: FieldProps) {
  return (
    <div>
      <label className={labelClass}>Duration (ms)</label>
      <input
        type="number"
        min={0}
        value={(step.ms as number) ?? ''}
        onChange={(e) => onChange('ms', e.target.value === '' ? '' : Number(e.target.value))}
        placeholder="1000"
        className={inputClass}
      />
    </div>
  );
}

export function HumanInputFields({ step, onChange }: FieldProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Input Type</label>
        <select
          value={(step.input_type as string) ?? ''}
          onChange={(e) => onChange('input_type', e.target.value)}
          className={inputClass}
        >
          <option value="">— select —</option>
          {HUMAN_INPUT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <TextField label="Label" fieldKey="label" step={step} onChange={onChange} placeholder="Enter your OTP" />
      <TextField label="Field Selector (optional)" fieldKey="field_selector" step={step} onChange={onChange} placeholder="input#otp" mono />
      <TextField label="Submit Selector (optional)" fieldKey="submit_selector" step={step} onChange={onChange} placeholder="button[type=submit]" mono />
      <TextField label="Placeholder (optional)" fieldKey="placeholder" step={step} onChange={onChange} placeholder="6-digit code" />
    </div>
  );
}

export function ZeroFields() {
  return <p className="text-xs text-muted-foreground italic">No fields for this step type.</p>;
}
