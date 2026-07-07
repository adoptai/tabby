import { useState, useEffect } from 'react';
import type { StepData } from './step-types';

interface Props {
  steps: StepData[];
  onApply: (steps: StepData[]) => void;
}

function stepsToJson(steps: StepData[]): string {
  const serialized = steps.map(({ _rest, ...rest }) => {
    const { ...fields } = rest;
    // Strip undefined values and merge _rest back in
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) clean[k] = v;
    }
    return { ...clean, ...(_rest ?? {}) };
  });
  return JSON.stringify(serialized, null, 2);
}

export function JsonEditorPanel({ steps, onApply }: Props) {
  const [text, setText] = useState(() => stepsToJson(steps));
  const [error, setError] = useState<string | null>(null);

  // Sync when steps change externally (e.g. add/delete from visual mode)
  useEffect(() => {
    setText(stepsToJson(steps));
    setError(null);
  }, [steps]);

  function handleApply() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`JSON parse error: ${(e as Error).message}`);
      return;
    }

    if (!Array.isArray(parsed)) {
      setError('Root value must be an array of steps.');
      return;
    }

    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (typeof item !== 'object' || item === null || !('action' in item)) {
        setError(`Step ${i + 1} is missing required "action" field.`);
        return;
      }
    }

    setError(null);
    onApply(parsed as StepData[]);
  }

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        rows={20}
        spellCheck={false}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
      />

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleApply}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Apply
      </button>
    </div>
  );
}
