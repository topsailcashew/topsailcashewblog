import type { GrowthPoint } from "@/lib/subscribers";

/**
 * Daily acquisition against churn, drawn as SVG on the server.
 *
 * No charting library. One chart of thirty bars does not justify 60 kB in a
 * Worker with a 3 MB ceiling, and rendering it on the server means it is in
 * the HTML — visible before hydration, and legible with JavaScript off.
 *
 * Signups go up from the axis, unsubscribes down, so churn is not something
 * you have to read off a legend: it is the part below the line. The cumulative
 * net is drawn over the top, because the bars answer "what happened on the
 * 14th" and the line answers "is this growing", and those are different
 * questions people bring to the same picture.
 */

const WIDTH = 720;
const HEIGHT = 190;
const PAD = { top: 14, right: 8, bottom: 22, left: 34 };

export function GrowthChart({ points }: { points: GrowthPoint[] }) {
  if (points.length === 0) {
    return <p className="muted">No signups yet — the chart starts with the first one.</p>;
  }

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  /*
    A symmetric scale, so a day with three signups and a day with three
    unsubscribes are the same distance from the axis. Scaling each half
    independently would draw one unsubscribe as tall as ten signups, which
    reads as a collapse.
  */
  const peak = Math.max(1, ...points.map((point) => Math.max(point.joined, point.left)));
  const axisY = PAD.top + plotHeight / 2;
  const unit = plotHeight / 2 / peak;

  const slot = plotWidth / points.length;
  const barWidth = Math.max(2, Math.min(14, slot - 3));

  // The net line is cumulative across the window, not the daily net — a line
  // that returned to zero every day would say nothing the bars do not.
  const cumulative: number[] = [];
  for (const point of points) {
    cumulative.push((cumulative[cumulative.length - 1] ?? 0) + point.net);
  }
  const netPeak = Math.max(1, ...cumulative.map(Math.abs));
  const netPath = cumulative
    .map((value, index) => {
      const x = PAD.left + slot * index + slot / 2;
      const y = axisY - (value / netPeak) * (plotHeight / 2 - 6);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const totals = points.reduce(
    (acc, point) => ({ joined: acc.joined + point.joined, left: acc.left + point.left }),
    { joined: 0, left: 0 },
  );

  return (
    <figure className="growth-chart">
      <figcaption className="growth-legend">
        <span className="growth-key growth-key--joined">
          {totals.joined} joined
        </span>
        <span className="growth-key growth-key--left">{totals.left} left</span>
        <span className="growth-key growth-key--net">
          {formatSigned(totals.joined - totals.left)} net over 30 days
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="growth-svg"
        role="img"
        aria-label={`Daily subscriber growth over ${points.length} days: ${totals.joined} joined, ${totals.left} unsubscribed, a net change of ${formatSigned(totals.joined - totals.left)}.`}
      >
        {/* Peak, zero and negative-peak, so the bars have something to be read against. */}
        {[peak, 0, -peak].map((value) => {
          const y = axisY - value * unit;
          return (
            <g key={value}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y}
                y2={y}
                className={value === 0 ? "growth-axis" : "growth-grid"}
              />
              <text x={PAD.left - 7} y={y + 3.5} className="growth-tick">
                {Math.abs(value)}
              </text>
            </g>
          );
        })}

        {points.map((point, index) => {
          const x = PAD.left + slot * index + (slot - barWidth) / 2;
          return (
            <g key={point.date}>
              {point.joined > 0 && (
                <rect
                  x={x}
                  y={axisY - point.joined * unit}
                  width={barWidth}
                  height={point.joined * unit}
                  className="growth-bar growth-bar--joined"
                />
              )}
              {point.left > 0 && (
                <rect
                  x={x}
                  y={axisY}
                  width={barWidth}
                  height={point.left * unit}
                  className="growth-bar growth-bar--left"
                />
              )}
              <title>
                {`${point.date}: +${point.joined} / −${point.left}`}
              </title>
            </g>
          );
        })}

        <path d={netPath} className="growth-net" fill="none" />

        {/* First and last day only. Thirty date labels at this width is a smudge. */}
        <text x={PAD.left} y={HEIGHT - 6} className="growth-tick growth-tick--date">
          {shortDate(points[0].date)}
        </text>
        <text
          x={WIDTH - PAD.right}
          y={HEIGHT - 6}
          textAnchor="end"
          className="growth-tick growth-tick--date"
        >
          {shortDate(points[points.length - 1].date)}
        </text>
      </svg>
    </figure>
  );
}

function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
