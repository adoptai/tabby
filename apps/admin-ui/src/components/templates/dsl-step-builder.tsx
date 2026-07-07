import { useState, useCallback } from 'react';
import { DSL_ACTIONS, type DslAction, type StepData, INTERNAL_KEYS } from './step-types';
import { StepCard } from './step-card';
import { JsonEditorPanel } from './json-editor-panel';

interface Props {
  value: unknown[];
  onChange: (steps: unknown[]) => void;
}

type Mode = 'visual' | 'json';

/** Parse raw unknown[] into StepData[], preserving unknown fields in _rest. */
function parseSteps(raw: unknown[]): StepData[] {
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null) {
      return { action: 'goto' as DslAction, _rest: {} };
    }
    const obj = item as Record<string, unknown>;
    const action = (obj.action as DslAction) ?? ('goto' as DslAction);
    const rest: Record<string, unknown> = {};
    const known: Record<string, unknown> = { action };

    for (const [k, v] of Object.entries(obj)) {
      if (k === 'action') continue;
      known[k] = v;
    }

    return { ...known, action, _rest: rest } as StepData;
  });
}

/** Serialize StepData[] back to plain objects, stripping internal tracking keys. */
function serializeSteps(steps: StepData[]): unknown[] {
  return steps.map(({ _rest, ...rest }) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (INTERNAL_KEYS.has(k)) continue;
      if (v === undefined || v === '') continue;
      out[k] = v;
    }
    // _rest fields come last so known fields win on conflict
    for (const [k, v] of Object.entries(_rest ?? {})) {
      if (!(k in out)) out[k] = v;
    }
    return out;
  });
}

function defaultStep(action: DslAction): StepData {
  return { action, _rest: {} };
}

export function DslStepBuilder({ value, onChange }: Props) {
  const [mode, setMode] = useState<Mode>('visual');
  const [steps, setSteps] = useState<StepData[]>(() => parseSteps(value));
  const [addDropdownOpen, setAddDropdownOpen] = useState(false);

  function commit(next: StepData[]) {
    setSteps(next);
    onChange(serializeSteps(next));
  }

  const handleStepChange = useCallback((index: number, updated: StepData) => {
    setSteps((prev) => {
      const next = [...prev];
      next[index] = updated;
      onChange(serializeSteps(next));
      return next;
    });
  }, [onChange]);

  function handleDelete(index: number) {
    commit(steps.filter((_, i) => i !== index));
  }

  function handleMoveUp(index: number) {
    if (index === 0) return;
    const next = [...steps];
    const a = next[index - 1]!;
    const b = next[index]!;
    next[index - 1] = b;
    next[index] = a;
    commit(next);
  }

  function handleMoveDown(index: number) {
    if (index === steps.length - 1) return;
    const next = [...steps];
    const a = next[index]!;
    const b = next[index + 1]!;
    next[index] = b;
    next[index + 1] = a;
    commit(next);
  }

  function handleAddStep(action: DslAction) {
    commit([...steps, defaultStep(action)]);
    setAddDropdownOpen(false);
  }

  function handleJsonApply(parsed: StepData[]) {
    commit(parsed);
  }

  function toggleMode() {
    setMode((m) => (m === 'visual' ? 'json' : 'visual'));
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        {/* Add Step dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setAddDropdownOpen((o) => !o)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm hover:bg-muted flex items-center gap-1.5"
          >
            + Add Step
            <span className="text-muted-foreground text-xs">▾</span>
          </button>

          {addDropdownOpen && (
            <>
              {/* Backdrop */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setAddDropdownOpen(false)}
              />
              <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
                <div className="grid grid-cols-2 gap-px bg-border p-px">
                  {DSL_ACTIONS.map((action) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => handleAddStep(action)}
                      className="bg-card px-3 py-2 text-left text-xs font-mono hover:bg-muted"
                    >
                      {action}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-background p-1">
          <button
            type="button"
            onClick={() => setMode('visual')}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              mode === 'visual' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            }`}
          >
            Visual
          </button>
          <button
            type="button"
            onClick={toggleMode}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              mode === 'json' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            }`}
          >
            JSON
          </button>
        </div>
      </div>

      {/* Content */}
      {mode === 'visual' ? (
        <div className="space-y-3">
          {steps.length === 0 && (
            <div className="rounded-xl border border-dashed border-border py-10 text-center">
              <p className="text-sm text-muted-foreground">No steps yet. Use "Add Step" to begin.</p>
            </div>
          )}
          {steps.map((step, i) => (
            <StepCard
              key={i}
              index={i}
              step={step}
              onChange={handleStepChange}
              onDelete={handleDelete}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
              isFirst={i === 0}
              isLast={i === steps.length - 1}
            />
          ))}
        </div>
      ) : (
        <JsonEditorPanel steps={steps} onApply={handleJsonApply} />
      )}

      {mode === 'visual' && steps.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {steps.length} step{steps.length !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}
