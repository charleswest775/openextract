import { useRef } from 'react';

/**
 * Organic, blobby loading indicators — 20 variants, SVG + CSS.
 * Uses currentColor so the Hearth accent cascades from the parent.
 *
 * <OrganicLoader />                     — random variant (stable per mount)
 * <OrganicLoader variant={5} size={80}/> — specific variant + size
 */

export type OrganicVariant =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

interface Props {
  variant?: OrganicVariant | 'random';
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Override fill/stroke. Defaults to currentColor so Tailwind text-* classes work. */
  color?: string;
}

const TOTAL = 20;

function pickVariant(): OrganicVariant {
  return (Math.floor(Math.random() * TOTAL) + 1) as OrganicVariant;
}

export default function OrganicLoader({
  variant = 'random',
  size = 200,
  className,
  style,
  color = 'currentColor',
}: Props) {
  // Pick once per mount, keep stable across re-renders
  const pickedRef = useRef<OrganicVariant | null>(null);
  if (pickedRef.current === null) {
    pickedRef.current = variant === 'random' ? pickVariant() : variant;
  }
  const v = pickedRef.current;

  // Always render the inner SVG at 200×200 (matches the coordinate system of
  // every keyframe) and scale down via CSS. Absolute+translate(-50%,-50%) so
  // the inner div stays centered even when the outer is smaller than 200px —
  // grid/flex overflow is not symmetric, but absolute positioning is.
  const scale = size / 200;
  const wrapStyle: React.CSSProperties = {
    width: size,
    height: size,
    position: 'relative',
    color,
    ...style,
  };
  const innerStyle: React.CSSProperties = {
    width: 200,
    height: 200,
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: `translate(-50%, -50%) scale(${scale})`,
    transformOrigin: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div className={className} style={wrapStyle} role="status" aria-label="Loading">
      <OrganicSvgFilters />
      <div style={innerStyle}>
        <Loader variant={v} />
      </div>
    </div>
  );
}

/* SVG filter definitions (goo + goo-soft). Rendered once, lazily. */
function OrganicSvgFilters() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: 'absolute' }}
      aria-hidden="true"
      data-organic-loader-defs
    >
      <defs>
        <filter id="ol-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -11" />
        </filter>
        <filter id="ol-goo-soft">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" />
        </filter>
      </defs>
    </svg>
  );
}

function Loader({ variant }: { variant: OrganicVariant }) {
  // SVG always rendered at 200 user units so pixel-based keyframes work.
  const svgProps = {
    viewBox: '0 0 200 200',
    width: 200,
    height: 200,
    style: { overflow: 'visible' as const, display: 'block' },
  };

  switch (variant) {
    case 1: return (
      <div className="ol-l01-wrap" style={{ transformOrigin: '50% 50%' }}>
        <svg className="ol-l01" {...svgProps}>
          <g transform="translate(50,50)">
            <path d="M 50 0 C 78 0 100 22 100 50 C 100 78 78 100 50 100 C 22 100 0 78 0 50 C 0 22 22 0 50 0 Z" fill="currentColor"/>
          </g>
        </svg>
      </div>
    );
    case 2: return (
      <div className="ol-l02-wrap">
        <svg className="ol-l02" {...svgProps} filter="url(#ol-goo)">
          <ellipse cx="60"  cy="100" rx="22" ry="28" fill="currentColor"/>
          <ellipse cx="140" cy="100" rx="30" ry="20" fill="currentColor"/>
        </svg>
      </div>
    );
    case 3: return (
      <svg className="ol-l03" {...svgProps} filter="url(#ol-goo)">
        <circle r="10" fill="currentColor"/>
        <circle r="14" fill="currentColor"/>
        <circle r="10" fill="currentColor"/>
      </svg>
    );
    case 4: return (
      <div className="ol-l04-wrap">
        <svg className="ol-l04" {...svgProps}>
          <path d="M 100 25 C 140 25 175 60 175 100 C 175 140 140 175 100 175 C 60 175 25 140 25 100 C 25 60 60 25 100 25 Z"
                fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round"/>
        </svg>
      </div>
    );
    case 5: return (
      <div className="ol-l05-wrap">
        <svg {...svgProps}>
          <ellipse cx="100" cy="100" rx="34" ry="34" fill="currentColor"/>
        </svg>
      </div>
    );
    case 6: return (
      <div className="ol-l06-wrap">
        <svg {...svgProps} filter="url(#ol-goo)">
          <circle cx="100" cy="40" r="16" fill="currentColor"/>
          <circle cx="100" cy="62" r="12" fill="currentColor"/>
          <circle cx="100" cy="80" r="8"  fill="currentColor"/>
          <circle cx="100" cy="94" r="5"  fill="currentColor"/>
        </svg>
      </div>
    );
    case 7: return (
      <svg className="ol-l07" {...svgProps} filter="url(#ol-goo)">
        <ellipse className="a" cx="100" cy="100" rx="26" ry="26" fill="currentColor"/>
        <ellipse className="b" cx="100" cy="100" rx="26" ry="26" fill="currentColor"/>
      </svg>
    );
    case 8: return (
      <svg className="ol-l08" {...svgProps}>
        <circle cx="100" cy="100" r="10" fill="none" stroke="currentColor" strokeWidth="3"/>
        <circle cx="100" cy="100" r="10" fill="none" stroke="currentColor" strokeWidth="3"/>
        <circle cx="100" cy="100" r="10" fill="none" stroke="currentColor" strokeWidth="3"/>
        <path className="core" d="M 100 70 C 120 70 130 85 130 100 C 130 115 115 130 100 130 C 85 130 70 115 70 100 C 70 85 80 70 100 70 Z" fill="currentColor"/>
      </svg>
    );
    case 9: return (
      <svg className="ol-l09" {...svgProps}>
        <path d="M 100 40 C 130 40 150 60 150 90 C 150 130 125 160 100 160 C 75 160 50 130 50 90 C 50 60 70 40 100 40 Z" fill="currentColor"/>
      </svg>
    );
    case 10: return (
      <div className="ol-l10-wrap">
        <svg className="ol-l10" {...svgProps}>
          <path d="M 100 30 Q 140 60 170 100 Q 140 140 100 170 Q 60 140 30 100 Q 60 60 100 30 Z" fill="currentColor"/>
        </svg>
      </div>
    );
    case 11: return (
      <div className="ol-l11-wrap">
        <svg className="ol-l11" {...svgProps}>
          <path d="M 100 40 C 140 40 150 70 140 100 C 130 130 120 150 100 160 C 80 150 70 130 60 100 C 50 70 60 40 100 40 Z" fill="currentColor"/>
        </svg>
      </div>
    );
    case 12: return (
      <div className="ol-l12-wrap">
        <svg className="ol-l12" {...svgProps} filter="url(#ol-goo)">
          <circle cx="85"  cy="85"  r="20" fill="currentColor"/>
          <circle cx="115" cy="85"  r="22" fill="currentColor"/>
          <circle cx="85"  cy="115" r="22" fill="currentColor"/>
          <circle cx="115" cy="115" r="20" fill="currentColor"/>
        </svg>
      </div>
    );
    case 13: return (
      <div className="ol-l13-wrap" style={{ display: 'grid', placeItems: 'center' }}>
        <svg className="ol-l13" viewBox="-50 -50 100 100" width={200} height={200} style={{ overflow: 'visible', display: 'block' }}>
          <path d="M 0 -35 C 25 -35 40 -20 38 5 C 35 30 15 38 -5 36 C -30 32 -40 12 -36 -10 C -32 -28 -20 -38 0 -35 Z" fill="currentColor"/>
        </svg>
      </div>
    );
    case 14: return (
      <svg className="ol-l14" {...svgProps}>
        <path d="M 50 100 C 50 70 80 70 100 100 C 120 130 150 130 150 100 C 150 70 120 70 100 100 C 80 130 50 130 50 100 Z"
              fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round"/>
      </svg>
    );
    case 15: return (
      <svg className="ol-l15" {...svgProps} filter="url(#ol-goo)">
        <path d="M 100 40 C 130 40 150 60 150 90 C 150 120 125 140 100 140 C 75 140 50 120 50 90 C 50 60 70 40 100 40 Z" fill="currentColor"/>
        <circle cx="100" cy="150" r="6" fill="currentColor"/>
      </svg>
    );
    case 16: return (
      <svg className="ol-l16" {...svgProps}>
        <rect x="40"  y="70" width="16" height="60" rx="8" fill="currentColor"/>
        <rect x="68"  y="70" width="16" height="60" rx="8" fill="currentColor"/>
        <rect x="96"  y="70" width="16" height="60" rx="8" fill="currentColor"/>
        <rect x="124" y="70" width="16" height="60" rx="8" fill="currentColor"/>
        <rect x="152" y="70" width="16" height="60" rx="8" fill="currentColor"/>
      </svg>
    );
    case 17: return (
      <div className="ol-l17-wrap">
        <svg className="ol-l17" {...svgProps}>
          <path d="M 100 40 C 135 40 160 65 160 100 C 160 135 135 160 100 160 C 65 160 40 135 40 100 C 40 65 65 40 100 40 Z"
                fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" pathLength={200}/>
        </svg>
      </div>
    );
    case 18: return (
      <div className="ol-l18-wrap">
        <svg className="ol-l18" {...svgProps}>
          <path d="M 60 100 C 60 70 80 50 110 50 C 150 50 160 80 150 110 C 140 140 110 150 90 145 C 65 140 60 125 60 100 Z" fill="currentColor"/>
        </svg>
      </div>
    );
    case 19: return (
      <svg className="ol-l19" {...svgProps} filter="url(#ol-goo)">
        <circle cx="50"  cy="100" r="12" fill="currentColor"/>
        <circle cx="75"  cy="100" r="14" fill="currentColor"/>
        <circle cx="100" cy="100" r="15" fill="currentColor"/>
        <circle cx="125" cy="100" r="14" fill="currentColor"/>
        <circle cx="150" cy="100" r="12" fill="currentColor"/>
      </svg>
    );
    case 20: return (
      <svg className="ol-l20" {...svgProps} filter="url(#ol-goo)">
        <circle className="core" cx="100" cy="100" r="18" fill="currentColor"/>
        <g className="ol-l20-a">
          <circle cx="100" cy="50" r="12" fill="currentColor"/>
        </g>
        <g className="ol-l20-b">
          <circle cx="100" cy="150" r="10" fill="currentColor"/>
        </g>
      </svg>
    );
  }
}
