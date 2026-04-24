import { html } from '../../vendor/htm.mjs';
import { useEffect } from '../../vendor/preact-hooks.mjs';
import { useStore } from '../useStore.js';
import { loadMetrics } from '../main.js';


function fmtNum(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return new Intl.NumberFormat().format(value);
}

function fmtSeconds(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${(value / 60).toFixed(1)}m`;
}

function fmtTs(value) {
  return value || '-';
}

function MetricCard({ title, rows }) {
  return html`
    <div class="metric-card">
      <h3>${title}</h3>
      ${rows.map(([label, value]) => html`
        <div key=${label} class="metric-row">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `)}
    </div>
  `;
}

export function ObservabilityPanel({ name }) {
  const metrics = useStore((s) => s.metrics);
  const error = useStore((s) => s.metricsError);

  useEffect(() => {
    if (name && !metrics && !error) loadMetrics(name);
  }, [name]);

  const heartbeat = metrics?.heartbeat || {};
  const compact = metrics?.compact || {};
  const tokens = metrics?.tokens || {};
  const lastTurn = tokens.last_turn || {};
  const lifetime = tokens.lifetime || {};

  return html`
    <section class="panel">
      <div class="panel-head">
        <h2>Observability</h2>
        <span class="meta">${error ? `Error: ${error}` : `Updated: ${fmtTs(metrics?.last_updated)}`}</span>
      </div>
      <div class="metric-grid">
        <${MetricCard}
          title="Heartbeats"
          rows=${[
            ['Count', fmtNum(heartbeat.count)],
            ['Last duration', fmtSeconds(heartbeat.last_duration_seconds)],
            ['Avg duration', fmtSeconds(heartbeat.avg_duration_seconds)],
          ]}
        />
        <${MetricCard}
          title="Compaction"
          rows=${[
            ['Threshold', fmtNum(compact.threshold)],
            ['Count since last', fmtNum(compact.count_since_last)],
            ['Total compacts', fmtNum(compact.total_compacts)],
            ['Last compact at', fmtTs(compact.last_compact_at)],
          ]}
        />
        <${MetricCard}
          title="Tokens"
          rows=${[
            ['Last Turn input / output', `${fmtNum(lastTurn.input_tokens)} / ${fmtNum(lastTurn.output_tokens)}`],
            ['Cache read / create / cached', `${fmtNum(lastTurn.cache_read_input_tokens)} / ${fmtNum(lastTurn.cache_creation_input_tokens)} / ${fmtNum(lastTurn.cached_input_tokens)}`],
            ['Lifetime input / output', `${fmtNum(lifetime.input_tokens)} / ${fmtNum(lifetime.output_tokens)}`],
            ['Lifetime cache read / create / cached', `${fmtNum(lifetime.cache_read_input_tokens)} / ${fmtNum(lifetime.cache_creation_input_tokens)} / ${fmtNum(lifetime.cached_input_tokens)}`],
          ]}
        />
      </div>
    </section>
  `;
}
