import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { GodviewTheme } from '../appearance-themes.js';
import type { MonitorParameterDefinition, MonitorParameterGroup, MonitorParameters } from '@vibefield/puppeteer-views';

// The system-control panel, ported from vibe-field's GodviewTuningPanel.tsx.
// The stage-surface and bubble-colour controls are a live measuring instrument
// and stay memory-only; the monitor sections write through to the stores that
// already own their keys. Terminal appearance is not here because Ghosttea's
// own settings, opened from the app header, already own it durably; the
// terminal safe area is, because that inset is the frame's, not the terminal's.

export interface GodviewTuning {
  stageColor: string;
  stageOpacity: number;
  stageBlur: number;
  bubbleIdleColor: string;
  bubbleWorkingColor: string;
  bubbleBlockedColor: string;
}

/** The token as `#rrggbb`, which is the only value a colour input accepts. */
function tokenColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (resolved === '') return fallback;
  const input = document.createElement('input');
  input.type = 'color';
  input.value = resolved;
  return input.value;
}

/** The Chopsticks reference is flat and opaque by default. The pane renderer's
 * own alpha remains independent, so a transparent terminal is still real. */
export function defaultGodviewTuning(theme: GodviewTheme = 'light'): GodviewTuning {
  const light = theme === 'light';
  return {
    stageColor: tokenColor(`--vf-godview-${theme}-monitor-bg`, light ? '#f7f7f7' : '#0a0a0a'),
    stageOpacity: 100,
    stageBlur: 0,
    bubbleIdleColor: tokenColor(`--vf-godview-${theme}-idle-bg`, light ? '#e5e5e5' : '#2a2a2a'),
    bubbleWorkingColor: tokenColor(`--vf-godview-${theme}-working-bg`, light ? '#222222' : '#eeeeee'),
    bubbleBlockedColor: tokenColor(
      light ? '--vf-card-deep' : '--vf-godview-dark-text-main',
      light ? '#000000' : '#ffffff',
    ),
  };
}

export function godviewTuningStyle(value: GodviewTuning): CSSProperties {
  return {
    '--vf-godview-stage-color': value.stageColor,
    '--vf-godview-stage-opacity': `${value.stageOpacity}%`,
    '--vf-godview-stage-blur': `${value.stageBlur}px`,
    '--vf-godview-bubble-idle': value.bubbleIdleColor,
    '--vf-godview-bubble-working': value.bubbleWorkingColor,
    '--vf-godview-bubble-blocked': value.bubbleBlockedColor,
  } as CSSProperties;
}

/** One group of sliders bound to whichever store owns those keys. */
export interface TweakSection {
  id: string;
  group: MonitorParameterGroup;
  values: MonitorParameters;
  onChange: (key: string, value: number) => void;
}

interface TweakPanelProps {
  open: boolean;
  theme: GodviewTheme;
  value: GodviewTuning;
  sections: readonly TweakSection[];
  onClose: () => void;
  onThemeChange: (theme: GodviewTheme) => void;
  onChange: (patch: Partial<GodviewTuning>) => void;
  onReset: () => void;
}

function displayedValue(definition: MonitorParameterDefinition, value: number): string {
  if (definition.step >= 1) return String(Math.round(value));
  const precision = Math.max(0, Math.ceil(-Math.log10(definition.step)));
  return value.toFixed(precision);
}

function RangeControl({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="vf-godview-tweak-control">
      <span>{label}</span>
      <output>
        {value}
        {unit}
      </output>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="vf-godview-tweak-control is-color">
      <span>{label}</span>
      <output>{value}</output>
      <input type="color" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function ParameterGroup({ group, values, onChange }: Omit<TweakSection, 'id'>) {
  return (
    <fieldset className="vf-godview-tweak-group">
      <legend>{group.title}</legend>
      {group.controls.map((definition) => {
        const value = values[definition.key] ?? definition.defaultValue;
        return (
          <label className="vf-godview-tweak-control" key={definition.key}>
            <span>{definition.label}</span>
            <output>{displayedValue(definition, value)}</output>
            <input
              type="range"
              min={definition.min}
              max={definition.max}
              step={definition.step}
              value={value}
              onChange={(event) => onChange(definition.key, event.currentTarget.valueAsNumber)}
            />
          </label>
        );
      })}
    </fieldset>
  );
}

export function TweakPanel({
  open,
  theme,
  value,
  sections,
  onClose,
  onThemeChange,
  onChange,
  onReset,
}: TweakPanelProps) {
  if (!open) return null;
  // A body-level portal: it stays outside the stage's backdrop filter and above
  // the WebGPU pane compositor, so the measuring instrument always paints last.
  return createPortal(
    <aside
      id="vf-godview-tweak-panel"
      className={`vf-godview-tweak-panel theme-${theme}`}
      aria-label="Godview system controls"
    >
      <header className="vf-godview-tweak-header">
        <span>SYSTEM CONTROL</span>
        <button type="button" aria-label="Close system controls" onClick={onClose}>
          ×
        </button>
      </header>

      <label className="vf-godview-tweak-theme">
        <span>Theme</span>
        <select value={theme} onChange={(event) => onThemeChange(event.currentTarget.value as GodviewTheme)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>

      <fieldset className="vf-godview-tweak-group">
        <legend>STAGE SURFACE</legend>
        <ColorControl
          label="Stage color"
          value={value.stageColor}
          onChange={(stageColor) => onChange({ stageColor })}
        />
        <RangeControl
          label="Stage opacity"
          value={value.stageOpacity}
          min={0}
          max={100}
          unit="%"
          onChange={(stageOpacity) => onChange({ stageOpacity })}
        />
        <RangeControl
          label="Backdrop blur"
          value={value.stageBlur}
          min={0}
          max={80}
          unit="px"
          onChange={(stageBlur) => onChange({ stageBlur })}
        />
      </fieldset>

      <fieldset className="vf-godview-tweak-group">
        <legend>BUBBLE COLORS</legend>
        <ColorControl
          label="Idle fill"
          value={value.bubbleIdleColor}
          onChange={(bubbleIdleColor) => onChange({ bubbleIdleColor })}
        />
        <ColorControl
          label="Working fill"
          value={value.bubbleWorkingColor}
          onChange={(bubbleWorkingColor) => onChange({ bubbleWorkingColor })}
        />
        <ColorControl
          label="Blocked fill"
          value={value.bubbleBlockedColor}
          onChange={(bubbleBlockedColor) => onChange({ bubbleBlockedColor })}
        />
      </fieldset>

      {sections.map((section) => (
        <ParameterGroup key={section.id} group={section.group} values={section.values} onChange={section.onChange} />
      ))}

      <button className="vf-godview-tweak-reset" type="button" onClick={onReset}>
        RESET DEFAULTS
      </button>
    </aside>,
    document.body,
  );
}
