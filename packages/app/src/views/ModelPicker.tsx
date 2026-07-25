import { useState } from 'react';

/**
 * Model picker for the agents that run on the local `claude` CLI — the CLI's
 * `--model` for `untacit extract` and `untacit interview`.
 *
 * The empty value means "whatever Claude Code defaults to", which is the right
 * answer almost always. The presets are Claude Code's own aliases; "otro…"
 * opens a free-text field because the accepted ids are whatever the installed
 * Claude Code understands, and pinning a closed list here would go stale.
 */

const PRESETS = ['opus', 'sonnet', 'haiku'] as const;
const OTHER = '__other__';

export function ModelPicker({
  value,
  onChange,
  disabled = false,
  id = 'agent-model',
}: {
  /** Model id, or '' for Claude Code's default. */
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  // Sticky once chosen: typing a non-preset id must not bounce the field back
  // into the select on every keystroke.
  const [custom, setCustom] = useState(
    value !== '' && !(PRESETS as readonly string[]).includes(value),
  );

  return (
    <label htmlFor={id}>
      modelo del agente
      <span className="row" style={{ gap: 6 }}>
        <select
          id={id}
          disabled={disabled}
          value={custom ? OTHER : value}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setCustom(true);
              onChange('');
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          <option value="">por defecto</option>
          {PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
          <option value={OTHER}>otro…</option>
        </select>
        {custom && (
          <input
            type="text"
            disabled={disabled}
            value={value}
            placeholder="id del modelo"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </span>
    </label>
  );
}
