/**
 * Column chart as inline SVG, built from numbers only (no chart library).
 */

export const CHART_SMALL = { width: 300, height: 110 };
export const CHART_LARGE = { width: 560, height: 220 };
/** Charts that span the full content width. */
export const CHART_WIDE = { width: 1100, height: 240 };
const CHART_AXIS_WIDTH = 34;
const CHART_LABEL_HEIGHT = 22;
const CHART_GRID_LINES = 4;
const CHART_X_LABELS = 5;
const MIN_BAR_WIDTH = 2;
const BAR_SHARE = 0.58;

/** Axis top for a maximum: four equal grid steps of 1, 2, 5 × 10ⁿ (minimum top of 4). */
function niceMax(value: number): number {
  const rough = Math.max(value, CHART_GRID_LINES) / CHART_GRID_LINES;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) || 10) * magnitude;
  return step * CHART_GRID_LINES;
}

/**
 * `values` are bar heights, `labels` the x-axis text (a handful are shown).
 * `axis` adds a y-axis with dashed grid lines.
 */
export function ColumnChart({ values, labels, size, axis = false }: { values: number[]; labels: string[]; size: { width: number; height: number }; axis?: boolean }) {
  const { width, height } = size;
  const left = axis ? CHART_AXIS_WIDTH : 0;
  const plotH = height - CHART_LABEL_HEIGHT;
  const top = axis ? niceMax(Math.max(...values, 0)) : Math.max(...values, 1);
  const slot = (width - left) / Math.max(values.length, 1);
  const barW = Math.max(MIN_BAR_WIDTH, slot * BAR_SHARE);
  const every = Math.max(1, Math.floor((values.length - 1) / (CHART_X_LABELS - 1)));

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Bar chart">
      {axis
        ? Array.from({ length: CHART_GRID_LINES + 1 }, (_, i) => {
            const y = plotH - (plotH * i) / CHART_GRID_LINES;
            return (
              <g key={`grid-${i}`}>
                <line className="grid-line" x1={left} x2={width} y1={y} y2={y} />
                <text x={0} y={y + 3}>{String(Math.round((top * i) / CHART_GRID_LINES))}</text>
              </g>
            );
          })
        : null}
      {values.map((value, i) => {
        const h = value === 0 ? 0 : Math.max(MIN_BAR_WIDTH, (value / top) * plotH);
        return <rect key={`bar-${i}`} className="bar" x={left + i * slot + (slot - barW) / 2} y={plotH - h} width={barW} height={h} />;
      })}
      {values.map((_, i) =>
        i % every === 0 ? (
          <text key={`label-${i}`} x={left + i * slot + slot / 2} y={height - 6} textAnchor={i === 0 ? 'start' : 'middle'}>
            {labels[i]}
          </text>
        ) : null,
      )}
    </svg>
  );
}
