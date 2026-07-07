import { type StepData, type DslAction, SELECTOR_VALUE_ACTIONS, ZERO_FIELD_ACTIONS, ON_FAILURE_ACTIONS } from './step-types';
import {
  GotoFields,
  SelectorValueFields,
  SelectorFields,
  PatternField,
  KeyboardField,
  EvaluateFields,
  SleepField,
  HumanInputFields,
  ZeroFields,
} from './step-fields';
import { CommonOptions } from './common-options';
import { OnFailureSection } from './on-failure-section';

interface Props {
  index: number;
  step: StepData;
  onChange: (index: number, step: StepData) => void;
  onDelete: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  isFirst: boolean;
  isLast: boolean;
}

const ACTION_BADGE_COLORS: Record<DslAction, string> = {
  goto: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  fill: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  type: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  click: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  select: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  wait_for: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  wait_for_url: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  frame: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  main_frame: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  popup: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  keyboard: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300',
  evaluate: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300',
  sleep: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300',
  screenshot: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  reload: 'bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300',
  request_human_input: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};

function stepSummary(step: StepData): string {
  const s = step as Record<string, unknown>;
  if (s.url) return String(s.url);
  if (s.selector) return String(s.selector);
  if (s.pattern) return String(s.pattern);
  if (s.key) return String(s.key);
  if (s.label) return String(s.label);
  if (s.ms != null) return `${s.ms}ms`;
  return '';
}

export function StepCard({ index, step, onChange, onDelete, onMoveUp, onMoveDown, isFirst, isLast }: Props) {
  const action = step.action;
  const badgeColor = ACTION_BADGE_COLORS[action] ?? 'bg-muted text-foreground';
  const summary = stepSummary(step);

  function handleFieldChange(key: string, value: unknown) {
    onChange(index, { ...step, [key]: value });
  }

  function renderFields() {
    if (action === 'goto') return <GotoFields step={step as Record<string, unknown>} onChange={handleFieldChange} />;
    if (SELECTOR_VALUE_ACTIONS.includes(action as typeof SELECTOR_VALUE_ACTIONS[number])) {
      return <SelectorValueFields step={step as Record<string, unknown>} onChange={handleFieldChange} />;
    }
    if (action === 'frame') {
      return <SelectorFields step={step as Record<string, unknown>} onChange={handleFieldChange} showFirst={false} />;
    }
    if (action === 'click' || action === 'wait_for') {
      return <SelectorFields step={step as Record<string, unknown>} onChange={handleFieldChange} showFirst />;
    }
    if (action === 'wait_for_url') return <PatternField step={step as Record<string, unknown>} onChange={handleFieldChange} />;
    if (action === 'keyboard') return <KeyboardField step={step as Record<string, unknown>} onChange={handleFieldChange} />;
    if (action === 'evaluate') return <EvaluateFields step={step as Record<string, unknown>} onChange={handleFieldChange} />;
    if (action === 'sleep') return <SleepField step={step as Record<string, unknown>} onChange={handleFieldChange} />;
    if (action === 'request_human_input') return <HumanInputFields step={step as Record<string, unknown>} onChange={handleFieldChange} />;
    if (ZERO_FIELD_ACTIONS.includes(action as typeof ZERO_FIELD_ACTIONS[number])) return <ZeroFields />;
    return <ZeroFields />;
  }

  const showOnFailure = ON_FAILURE_ACTIONS.includes(action as typeof ON_FAILURE_ACTIONS[number]);

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-xs font-mono text-muted-foreground w-6 shrink-0">{index + 1}</span>

        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-mono font-medium ${badgeColor}`}>
          {action}
        </span>

        {summary && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono">
            {summary}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMoveUp(index)}
            disabled={isFirst}
            className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMoveDown(index)}
            disabled={isLast}
            className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => onDelete(index)}
            className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Delete step"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="border-t border-border px-4 py-3">
        {renderFields()}
      </div>

      {/* Advanced */}
      <details className="border-t border-border">
        <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted select-none">
          Advanced options
        </summary>
        <div className="px-4 pb-3 pt-2">
          <CommonOptions step={step as Record<string, unknown>} onChange={handleFieldChange} />
        </div>
      </details>

      {/* On Failure */}
      {showOnFailure && (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted select-none">
            On failure
            {step.on_failure != null && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                {(step.on_failure as { action: string }).action}
              </span>
            )}
          </summary>
          <div className="px-4 pb-3 pt-2">
            <OnFailureSection step={step as Record<string, unknown>} onChange={handleFieldChange} />
          </div>
        </details>
      )}
    </div>
  );
}
