import { html } from '../../vendor/htm.mjs';
import { useState, useEffect } from '../../vendor/preact-hooks.mjs';
import * as api from '../api.js';


export function CompactPanel({ name }) {
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState('');
  const [defaultVal, setDefaultVal] = useState(0);
  const [effective, setEffective] = useState(0);
  const [override, setOverride] = useState(null);
  const [result, setResult] = useState('');

  const refresh = async () => {
    try {
      const d = await api.getCompactInterval(name);
      setDefaultVal(d.default ?? 0);
      setOverride(d.override);
      setEffective(d.effective ?? 0);
      setValue(String(d.override ?? d.default ?? 0));
      setLoaded(true);
    } catch (err) {
      setResult('Load failed: ' + (err.message || 'unknown'));
    }
  };

  useEffect(() => { refresh(); }, [name]);

  const onSave = async () => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0) {
      setResult('Value must be an integer >= 0');
      return;
    }
    setResult('Saving…');
    try {
      await api.setCompactInterval(name, n);
      setResult('Saved');
      setTimeout(() => setResult(''), 1500);
      refresh();
    } catch (err) {
      setResult('Failed: ' + (err.message || 'unknown'));
    }
  };

  const onClear = async () => {
    setResult('Clearing…');
    try {
      await api.setCompactInterval(name, null);
      setResult('Reverted to default');
      setTimeout(() => setResult(''), 1500);
      refresh();
    } catch (err) {
      setResult('Failed: ' + (err.message || 'unknown'));
    }
  };

  return html`
    <div style="margin-top:14px;border-top:1px dashed var(--line);padding-top:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="color:var(--muted);font-weight:700;font-size:13px">Compact Interval (heartbeats)</span>
        <span class="meta">${result}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="number" min="0" step="1" value=${value}
          onInput=${(e) => setValue(e.target.value)}
          style="width:90px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:13px" />
        <button onClick=${onSave} style="padding:4px 10px;font-size:12px">Save</button>
        <button class="secondary" onClick=${onClear} style="padding:4px 10px;font-size:12px">Revert to default</button>
        <span class="meta" style="font-size:12px">
          ${loaded ? `default=${defaultVal} effective=${effective} (0 disables)` : 'loading…'}
        </span>
      </div>
    </div>
  `;
}
