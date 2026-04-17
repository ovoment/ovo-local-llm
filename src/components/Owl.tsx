import { useEffect, useRef, useState } from "react";

export type OwlState =
  | "idle"       // default — big open eyes
  | "thinking"   // eyes upward, question marks
  | "typing"     // focused squint
  | "sleeping"   // closed eyes + zzz
  | "happy"      // curved happy eyes + sparkles
  | "surprised"  // huge dilated pupils
  | "error"      // X eyes
  | "struggling"; // grabbed — flailing, sweat drops, shake animation

export type OwlSize = "xs" | "sm" | "md" | "lg" | "xl";

export const OWL_SIZES: Record<OwlSize, number> = {
  xs: 32,
  sm: 64,
  md: 128,
  lg: 220,
  xl: 320,
};

export interface OwlProps {
  state?: OwlState;
  size?: number | OwlSize;
  className?: string;
  accent?: string;
}

const PALETTE = {
  body: "#D97757",
  bodyShadow: "#B85D3F",
  belly: "#F4D4B8",
  face: "#F4D4B8",
  eyeRing: "#FAF3E7",
  eyeStroke: "#8B4432",
  iris: "#2C1810",
  beak: "#E8A053",
  beakStroke: "#B8702F",
  feet: "#8B6542",
  feetShadow: "#6B4A2A",
  blush: "#E88B6F",
  toes: "#8B4A2A",
};

function Eyes({ state, gazeX = 0, gazeY = 0 }: { state: OwlState; gazeX?: number; gazeY?: number }) {
  const ringProps = {
    fill: PALETTE.eyeRing,
    stroke: PALETTE.eyeStroke,
    strokeWidth: 2.5,
  };

  if (state === "sleeping") {
    return (
      <g>
        <circle cx="290" cy="225" r="48" {...ringProps} />
        <circle cx="390" cy="225" r="48" {...ringProps} />
        <path d="M 264 225 Q 290 240 316 225" stroke={PALETTE.iris} strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M 364 225 Q 390 240 416 225" stroke={PALETTE.iris} strokeWidth="5" fill="none" strokeLinecap="round" />
        <text x="460" y="160" fill={PALETTE.eyeStroke} fontSize="28" fontFamily="serif" fontWeight="bold" className="ovo-owl-zzz-1">z</text>
        <text x="482" y="132" fill={PALETTE.eyeStroke} fontSize="36" fontFamily="serif" fontWeight="bold" className="ovo-owl-zzz-2">Z</text>
      </g>
    );
  }

  if (state === "happy") {
    return (
      <g>
        <circle cx="290" cy="225" r="48" {...ringProps} />
        <circle cx="390" cy="225" r="48" {...ringProps} />
        <path d="M 260 238 Q 290 208 320 238" stroke={PALETTE.iris} strokeWidth="6" fill="none" strokeLinecap="round" />
        <path d="M 360 238 Q 390 208 420 238" stroke={PALETTE.iris} strokeWidth="6" fill="none" strokeLinecap="round" />
      </g>
    );
  }

  if (state === "error") {
    return (
      <g>
        <circle cx="290" cy="225" r="48" {...ringProps} />
        <circle cx="390" cy="225" r="48" {...ringProps} />
        <g stroke={PALETTE.iris} strokeWidth="7" strokeLinecap="round">
          <line x1="270" y1="205" x2="310" y2="245" />
          <line x1="310" y1="205" x2="270" y2="245" />
          <line x1="370" y1="205" x2="410" y2="245" />
          <line x1="410" y1="205" x2="370" y2="245" />
        </g>
      </g>
    );
  }

  if (state === "struggling") {
    return (
      <g>
        <circle cx="290" cy="225" r="48" {...ringProps} />
        <circle cx="390" cy="225" r="48" {...ringProps} />
        <circle cx="295" cy="222" r="26" fill={PALETTE.iris} />
        <circle cx="385" cy="222" r="26" fill={PALETTE.iris} />
        <circle cx="305" cy="214" r="5" fill="#FFFFFF" />
        <circle cx="395" cy="214" r="5" fill="#FFFFFF" />
        <path d="M 248 218 Q 254 202 268 200" stroke={PALETTE.eyeStroke} strokeWidth="3" fill="none" strokeLinecap="round" />
        <path d="M 412 200 Q 426 202 432 218" stroke={PALETTE.eyeStroke} strokeWidth="3" fill="none" strokeLinecap="round" />
      </g>
    );
  }

  const irisR = state === "surprised" ? 28 : state === "typing" ? 18 : 22;
  const irisOffsetY = state === "thinking" ? -8 : 0;
  const pupilR = state === "surprised" ? 4 : state === "typing" ? 5 : 7;
  const irisClass = state === "typing" ? "ovo-owl-iris-typing" : "";
  const eyeClass =
    state === "idle" || state === "thinking" || state === "typing" || state === "surprised"
      ? "ovo-owl-eye-blink"
      : "";

  return (
    <g>
      <g className={eyeClass}>
        <circle cx="290" cy="225" r="48" {...ringProps} />
        <g className={irisClass}>
          <circle cx={295 + gazeX} cy={230 + irisOffsetY + gazeY} r={irisR} fill={PALETTE.iris} />
          <circle cx={302 + gazeX} cy={222 + irisOffsetY + gazeY} r={pupilR} fill="#FFFFFF" />
          <circle cx={287 + gazeX} cy={237 + irisOffsetY + gazeY} r="3" fill="#FFFFFF" />
        </g>
      </g>
      <g className={eyeClass}>
        <circle cx="390" cy="225" r="48" {...ringProps} />
        <g className={irisClass}>
          <circle cx={385 + gazeX} cy={230 + irisOffsetY + gazeY} r={irisR} fill={PALETTE.iris} />
          <circle cx={392 + gazeX} cy={222 + irisOffsetY + gazeY} r={pupilR} fill="#FFFFFF" />
          <circle cx={377 + gazeX} cy={237 + irisOffsetY + gazeY} r="3" fill="#FFFFFF" />
        </g>
      </g>
      {state === "typing" && (
        <path d="M 440 190 Q 446 202 440 212 Q 434 202 440 190 Z" fill="#5FA8D3" opacity="0.8" className="ovo-owl-flutter" />
      )}
    </g>
  );
}

function Accessory({ state }: { state: OwlState }) {
  if (state === "thinking") {
    return (
      <g shapeRendering="crispEdges">
        <rect x="438" y="128" width="10" height="10" fill="#FAF3E7" stroke={PALETTE.eyeStroke} strokeWidth="3" className="ovo-owl-thought-bob ovo-owl-thought-bob-a" />
        <rect x="450" y="108" width="14" height="14" fill="#FAF3E7" stroke={PALETTE.eyeStroke} strokeWidth="3" className="ovo-owl-thought-bob ovo-owl-thought-bob-b" />
        <g className="ovo-owl-thought-bob ovo-owl-thought-bob-c">
          <polygon
            points="496,40 624,40 624,56 640,56 640,72 656,72 656,120 640,120 640,136 624,136 624,152 496,152 496,136 480,136 480,120 464,120 464,72 480,72 480,56 496,56"
            fill="#FAF3E7"
            stroke={PALETTE.eyeStroke}
            strokeWidth="4"
            strokeLinejoin="miter"
          />
          <rect x="516" y="88" width="16" height="16" fill="#2F80ED" className="ovo-owl-think-dot ovo-owl-think-dot-1" />
          <rect x="552" y="88" width="16" height="16" fill="#2F80ED" className="ovo-owl-think-dot ovo-owl-think-dot-2" />
          <rect x="588" y="88" width="16" height="16" fill="#2F80ED" className="ovo-owl-think-dot ovo-owl-think-dot-3" />
        </g>
      </g>
    );
  }
  if (state === "typing") {
    const keyboardRows: Array<{ y: number; keys: number; indent: number }> = [
      { y: 422, keys: 14, indent: 0 },
      { y: 434, keys: 13, indent: 6 },
      { y: 446, keys: 12, indent: 14 },
      { y: 458, keys: 11, indent: 22 },
    ];
    const keyboardKeys: JSX.Element[] = [];
    keyboardRows.forEach((row, rowIdx) => {
      const rowW = 500 - row.indent * 2;
      const gap = 2;
      const keyW = (rowW - gap * (row.keys - 1)) / row.keys;
      const keyH = 10;
      const startX = 92 + row.indent;
      for (let i = 0; i < row.keys; i++) {
        const x = startX + i * (keyW + gap);
        keyboardKeys.push(
          <g key={`kb-r${rowIdx}-k${i}`}>
            <rect x={x} y={row.y} width={keyW} height={keyH} rx="1.5" fill="#3D434C" />
            <rect x={x + 0.5} y={row.y + 0.5} width={keyW - 1} height={keyH - 3} rx="1" fill="#B8C0CB" />
          </g>,
        );
      }
    });

    return (
      <g>
        <g className="ovo-owl-editor-float">
          <rect x="198" y="8" width="284" height="96" rx="5" fill="#1E1E2E" stroke="#2C1810" strokeWidth="1.5" />
          <rect x="198" y="8" width="284" height="18" rx="5" fill="#2A2A3E" />
          <rect x="198" y="20" width="284" height="6" fill="#2A2A3E" />
          <circle cx="212" cy="17" r="3.5" fill="#FF5F57" />
          <circle cx="224" cy="17" r="3.5" fill="#FEBC2E" />
          <circle cx="236" cy="17" r="3.5" fill="#28C840" />
          <rect x="214" y="38" width="120" height="9" rx="2" fill="#22C55E" opacity="0.9" className="ovo-owl-code-line ovo-owl-code-line-1" />
          <rect x="246" y="54" width="156" height="9" rx="2" fill="#22C55E" opacity="0.9" className="ovo-owl-code-line ovo-owl-code-line-2" />
          <rect x="246" y="70" width="96" height="9" rx="2" fill="#5FA8D3" opacity="0.85" className="ovo-owl-code-line ovo-owl-code-line-3" />
          <rect x="214" y="86" width="72" height="6" rx="1.5" fill="#94A3B8" opacity="0.35" className="ovo-owl-code-line ovo-owl-code-line-4" />
          <rect x="246" y="98" width="118" height="6" rx="1.5" fill="#94A3B8" opacity="0.35" className="ovo-owl-code-line ovo-owl-code-line-5" />
        </g>
        <g>
          <path d="M 78 478 L 602 478 L 590 418 L 90 418 Z" fill="#2A2F38" />
          <path d="M 86 472 L 594 472 L 584 422 L 96 422 Z" fill="#4A5058" />
          {keyboardKeys}
          <g>
            <rect x="240" y="470" width="200" height="7" rx="1.5" fill="#3D434C" />
            <rect x="241" y="470.5" width="198" height="4" rx="1" fill="#B8C0CB" />
          </g>
          <g fill="#3D434C">
            <rect x="196" y="470" width="38" height="7" rx="1.5" />
            <rect x="446" y="470" width="38" height="7" rx="1.5" />
            <rect x="490" y="470" width="38" height="7" rx="1.5" />
            <rect x="534" y="470" width="38" height="7" rx="1.5" />
            <rect x="152" y="470" width="38" height="7" rx="1.5" />
          </g>
          <rect x="90" y="418" width="500" height="2" fill="#6A7480" opacity="0.6" />
        </g>
        <g className="ovo-owl-typing-arm-l">
          <path
            d="M 212 340 Q 176 380 196 440 Q 228 450 262 440 Q 278 395 258 350 Q 240 335 212 340 Z"
            fill={PALETTE.bodyShadow}
            stroke={PALETTE.eyeStroke}
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <g stroke={PALETTE.eyeStroke} strokeWidth="1.5" fill="none" opacity="0.55" strokeLinecap="round">
            <path d="M 214 370 Q 220 405 212 432" />
            <path d="M 236 370 Q 244 410 238 436" />
          </g>
        </g>
        <g className="ovo-owl-typing-arm-r">
          <path
            d="M 468 340 Q 504 380 484 440 Q 452 450 418 440 Q 402 395 422 350 Q 440 335 468 340 Z"
            fill={PALETTE.bodyShadow}
            stroke={PALETTE.eyeStroke}
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <g stroke={PALETTE.eyeStroke} strokeWidth="1.5" fill="none" opacity="0.55" strokeLinecap="round">
            <path d="M 466 370 Q 460 405 468 432" />
            <path d="M 444 370 Q 436 410 442 436" />
          </g>
        </g>
      </g>
    );
  }
  if (state === "happy") {
    return (
      <g stroke={PALETTE.beak} strokeWidth="3" strokeLinecap="round" fill="none">
        <g className="ovo-owl-sparkle-1">
          <line x1="120" y1="200" x2="140" y2="210" />
          <line x1="130" y1="175" x2="140" y2="195" />
        </g>
        <g className="ovo-owl-sparkle-2">
          <line x1="560" y1="200" x2="540" y2="210" />
          <line x1="550" y1="175" x2="540" y2="195" />
        </g>
      </g>
    );
  }
  if (state === "error") {
    return (
      <g className="ovo-owl-error-text">
        <text
          x="340"
          y="72"
          textAnchor="middle"
          fontFamily="'Courier New', monospace"
          fontSize="46"
          fontWeight="900"
          fill="#E53935"
          stroke="#7A0000"
          strokeWidth="2.5"
          paintOrder="stroke"
          letterSpacing="4"
        >
          ERROR
        </text>
        <g stroke="#E53935" strokeWidth="4" strokeLinecap="round" fill="none" className="ovo-owl-error-bolt">
          <path d="M 180 60 L 200 80 L 190 90 L 210 110" />
          <path d="M 500 60 L 480 80 L 490 90 L 470 110" />
        </g>
      </g>
    );
  }
  if (state === "struggling") {
    return (
      <g>
        <g fill="#5FA8D3" opacity="0.85">
          <path d="M 170 210 Q 164 226 170 240 Q 176 226 170 210 Z" />
          <path d="M 510 210 Q 504 226 510 240 Q 516 226 510 210 Z" />
          <path d="M 140 280 Q 134 298 140 314 Q 146 298 140 280 Z" />
        </g>
        <g stroke={PALETTE.eyeStroke} strokeWidth="4" strokeLinecap="round" fill="none" opacity="0.65">
          <path d="M 100 250 Q 125 245 145 260" />
          <path d="M 90 320 Q 118 320 140 335" />
          <path d="M 580 250 Q 555 245 535 260" />
          <path d="M 590 320 Q 562 320 540 335" />
        </g>
        <g stroke={PALETTE.eyeStroke} strokeWidth="3" strokeLinecap="round" fill="none">
          <path d="M 198 170 Q 175 140 165 110" />
          <path d="M 482 170 Q 505 140 515 110" />
        </g>
      </g>
    );
  }
  return null;
}

function Mouth({ state }: { state: OwlState }) {
  if (state === "struggling" || state === "surprised") {
    return (
      <g>
        <ellipse cx="340" cy="292" rx="18" ry="22" fill="#2C1810" />
        <ellipse cx="340" cy="298" rx="10" ry="12" fill="#B8405E" />
      </g>
    );
  }
  return null;
}

export function Owl({ state = "idle", size = "md", className = "", accent }: OwlProps) {
  const px = typeof size === "number" ? size : OWL_SIZES[size];
  const body = accent ?? PALETTE.body;
  const stateClass = `ovo-owl-${state}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });

  const tracksGaze = state === "idle" || state === "thinking" || state === "typing" || state === "surprised";

  useEffect(() => {
    if (!tracksGaze) {
      setGaze({ x: 0, y: 0 });
      return;
    }
    const handleMove = (e: MouseEvent) => {
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height * 0.47;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const maxDist = Math.max(rect.width, rect.height) * 0.9;
      const norm = Math.min(Math.hypot(dx, dy), maxDist) / maxDist;
      const angle = Math.atan2(dy, dx);
      const rangeX = 10;
      const rangeY = 7;
      setGaze({
        x: Math.cos(angle) * norm * rangeX,
        y: Math.sin(angle) * norm * rangeY,
      });
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, [tracksGaze]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 680 480"
      width={px}
      height={(px * 480) / 680}
      className={`${stateClass} ${className}`.trim()}
      role="img"
      aria-label={`owl ${state}`}
    >
      <path d="M 140 418 Q 340 410 540 418 L 540 436 Q 340 428 140 436 Z" fill={PALETTE.feet} />
      <ellipse cx="220" cy="418" rx="18" ry="3" fill={PALETTE.feetShadow} opacity="0.5" />
      <ellipse cx="420" cy="418" rx="22" ry="3" fill={PALETTE.feetShadow} opacity="0.5" />

      <path d="M 255 138 L 248 92 L 288 128 Z" fill={PALETTE.bodyShadow} />
      <path d="M 425 138 L 432 92 L 392 128 Z" fill={PALETTE.bodyShadow} />

      <path
        d="M 340 110 C 228 112 192 218 198 312 C 204 398 272 428 340 428 C 408 428 476 398 482 312 C 488 218 452 108 340 110 Z"
        fill={body}
      />
      <ellipse cx="340" cy="325" rx="78" ry="98" fill={PALETTE.belly} />

      <path d="M 210 240 Q 188 315 212 398 Q 248 385 250 325 Q 248 268 210 240 Z" fill={PALETTE.bodyShadow} />
      <path d="M 470 240 Q 492 315 468 398 Q 432 385 430 325 Q 432 268 470 240 Z" fill={PALETTE.bodyShadow} />

      <g stroke="#8B4432" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.6">
        <path d="M 218 290 Q 230 295 238 315" />
        <path d="M 218 330 Q 230 335 238 355" />
        <path d="M 462 290 Q 450 295 442 315" />
        <path d="M 462 330 Q 450 335 442 355" />
      </g>

      <ellipse cx="340" cy="228" rx="118" ry="98" fill={state === "error" ? "#E0DCD4" : PALETTE.face} />

      <Eyes state={state} gazeX={gaze.x} gazeY={gaze.y} />

      {state !== "struggling" && state !== "surprised" && (
        <path
          d="M 340 260 L 322 285 L 340 302 L 358 285 Z"
          fill={PALETTE.beak}
          stroke={PALETTE.beakStroke}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      )}

      <Mouth state={state} />

      <ellipse cx="240" cy="268" rx="16" ry="9" fill={PALETTE.blush} opacity="0.55" />
      <ellipse cx="440" cy="268" rx="16" ry="9" fill={PALETTE.blush} opacity="0.55" />

      <g stroke={PALETTE.toes} strokeWidth="5" strokeLinecap="round" fill="none">
        <path d="M 303 410 L 298 432" />
        <path d="M 320 410 L 320 432" />
        <path d="M 337 410 L 342 432" />
        <path d="M 343 410 L 338 432" />
        <path d="M 360 410 L 360 432" />
        <path d="M 377 410 L 382 432" />
      </g>

      <Accessory state={state} />
    </svg>
  );
}

export default Owl;
