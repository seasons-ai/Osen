// The Osen mark for the UI. Colours come from the theme tokens (--leaf, --rain),
// so the mark recolours itself when the theme changes. The brand/svg files have
// the dark theme's colours baked in and stay for the site, README and documents.
// small — the simplified mark without veins, for sizes under 48 px (the rail uses 32 px).
import type { ReactNode } from "react";

const LOBE = "M0,0 C-11,-10 -10,-30 0,-44 C10,-30 11,-10 0,0 Z";

export function OsenMark({ size = 32, small = size < 48 }: { size?: number; small?: boolean }): ReactNode {
  return (
    <svg viewBox="-48 -48 96 96" width={size} height={size} aria-hidden="true" focusable="false">
      <g transform="translate(0 6)">
        <g style={{ fill: "var(--leaf)" }}>
          <path d={LOBE} />
          <path transform="rotate(-40) scale(0.86)" d={LOBE} />
          <path transform="rotate(40) scale(0.86)" d={LOBE} />
          <path transform="rotate(-82) scale(0.64)" d={LOBE} />
          <path transform="rotate(82) scale(0.64)" d={LOBE} />
        </g>
        {small ? (
          <>
            <line y1={4} y2={31} style={{ stroke: "var(--rain)" }} strokeWidth={5} strokeLinecap="round" />
            <circle r={6.5} style={{ fill: "var(--rain)" }} />
          </>
        ) : (
          <>
            <g style={{ stroke: "var(--rain)" }} strokeWidth={2.4} strokeLinecap="round" fill="none">
              <line y1={-6} y2={-30} />
              <line transform="rotate(-40)" y1={-6} y2={-25} />
              <line transform="rotate(40)" y1={-6} y2={-25} />
              <line transform="rotate(-82)" y1={-6} y2={-18} />
              <line transform="rotate(82)" y1={-6} y2={-18} />
              <line y1={4} y2={30} />
            </g>
            <circle r={4.6} style={{ fill: "var(--rain)" }} />
          </>
        )}
      </g>
    </svg>
  );
}
