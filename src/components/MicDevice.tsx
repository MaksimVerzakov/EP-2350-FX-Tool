import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ThemeMode } from '../types/config';

interface MicDeviceProps {
  activeSlot: number; // 0, 1, 2, 3
  onSelectSlot: (slot: number) => void;
  activeSampleSlot?: number; // 0, 1, 2, 3
  onSelectSampleSlot?: (slot: number) => void;
  onSampleTrigger?: (down: boolean) => void;
  handlePos: number; // 0.0 to 1.0
  onHandleChange: (pos: number) => void;
  onShakeTrigger: () => void;
  theme?: ThemeMode;
}

const TING_LOUVER_Y = [
  4.295,
  19.487,
  34.661,
  49.835,
  65.009,
  80.183,
  95.361,
  110.535,
  125.709,
  140.883,
  156.057,
  171.235
];

interface SideButtonProps {
  cy: number;
  title: string;
  bodyFill: string;
  highlightFill: string;
  shadowFill: string;
  capFill: string;
  isPressed?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseUp?: (e: React.MouseEvent) => void;
  onMouseLeave?: () => void;
}

/**
 * 3D cylindrical push-button mounted on the 45° axonometric right side wall of the mic,
 * matching the physical EP-2350 / TE hardware silhouette.
 */
const SideButton: React.FC<SideButtonProps> = ({
  cy,
  title,
  bodyFill,
  highlightFill,
  shadowFill,
  capFill,
  isPressed = false,
  onClick,
  onMouseDown,
  onMouseUp,
  onMouseLeave
}) => {
  const capCy = cy + 2.5;
  const barrelPath = `M 555 ${cy - 10} L 568.5 ${cy - 10} A 4.6 12.5 0 0 1 568.5 ${cy + 15} L 555 ${cy + 15} A 3.0 12.5 0 0 1 555 ${cy - 10} Z`;

  return (
    <g>
      {/* Recessed Mounting Collar on the 45° Side Wall */}
      <ellipse
        cx={555.5}
        cy={cy + 3.2}
        rx={3.4}
        ry={13.5}
        fill="#141617"
        stroke="#000000"
        strokeWidth="0.9"
      />
      {/* Interactive 3D Cylindrical Button (presses inward toward chassis) */}
      <g
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        className={`cursor-pointer group transition-transform duration-75 ${
          isPressed ? '-translate-x-[2.5px]' : 'active:-translate-x-[2.5px]'
        }`}
      >
        <title>{title}</title>
        {/* Invisible expanded hit area */}
        <rect x="550" y={cy - 14} width="26" height="33" fill="transparent" />
        {/* Cylindrical Barrel Base */}
        <path
          d={barrelPath}
          fill={bodyFill}
          className="group-hover:brightness-105 group-active:brightness-95"
        />
        {/* Upper Specular Highlight Band */}
        <path
          d={`M 553.8 ${cy - 8.2} L 568.5 ${cy - 8.2} L 568.5 ${cy - 3.6} L 553.0 ${cy - 3.6} Z`}
          fill={highlightFill}
          opacity="0.7"
        />
        {/* Lower Cylindrical Shadow Band */}
        <path
          d={`M 553.2 ${cy + 7.5} L 568.5 ${cy + 7.5} A 4.6 12.5 0 0 1 568.5 ${cy + 15} L 555 ${cy + 15} A 3.0 12.5 0 0 1 553.2 ${cy + 7.5} Z`}
          fill={shadowFill}
        />
        {/* Crisp Barrel Contour */}
        <path d={barrelPath} fill="none" stroke="#000000" strokeWidth="1.2" strokeLinejoin="round" />
        {/* Outer 3D Elliptical End Cap */}
        <ellipse
          cx={568.5}
          cy={capCy}
          rx={4.6}
          ry={12.5}
          fill={capFill}
          stroke="#000000"
          strokeWidth="1.2"
          className="group-hover:brightness-105 group-active:brightness-95"
        />
        {/* Subtle Inner Molded Cap Ring */}
        <ellipse
          cx={568.7}
          cy={capCy}
          rx={2.3}
          ry={7.8}
          fill="none"
          stroke="#000000"
          strokeOpacity="0.22"
          strokeWidth="0.8"
        />
      </g>
    </g>
  );
};

export const MicDevice: React.FC<MicDeviceProps> = ({
  activeSlot,
  onSelectSlot,
  activeSampleSlot = 0,
  onSelectSampleSlot,
  onSampleTrigger,
  handlePos,
  onHandleChange,
  onShakeTrigger,
  theme = 'fx'
}) => {
  const isTing = theme === 'ting';
  const [isSqueezing, setIsSqueezing] = useState(false);
  const [isCartoonShaking, setIsCartoonShaking] = useState(false);
  const [isSamplePressing, setIsSamplePressing] = useState(false);
  const dragStartY = useRef(0);
  const dragStartX = useRef(0);
  const dragStartVal = useRef(handlePos);
  const hasDragged = useRef(false);
  const shakeTimerRef = useRef<number | null>(null);

  const cyclePreset = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextSlot = activeSlot + 1 >= 4 ? -1 : activeSlot + 1;
    onSelectSlot(nextSlot);
  };

  const cycleSampleSlot = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelectSampleSlot?.((activeSampleSlot + 1) % 4);
  };

  const triggerCartoonShake = useCallback(() => {
    setIsCartoonShaking(true);
    onShakeTrigger();
    if (shakeTimerRef.current) window.clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = window.setTimeout(() => setIsCartoonShaking(false), 420);
  }, [onShakeTrigger]);

  // Spacebar hotkey triggers both DSP shake and cartoon shake animation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        triggerCartoonShake();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [triggerCartoonShake]);

  useEffect(() => {
    return () => {
      if (shakeTimerRef.current) window.clearTimeout(shakeTimerRef.current);
    };
  }, []);

  // Handle Drag: Mouse or touch drag to squeeze/release the lever
  const handleHandleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsSqueezing(true);
    hasDragged.current = false;
    dragStartY.current = e.clientY;
    dragStartX.current = e.clientX;
    dragStartVal.current = handlePos;
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isSqueezing) return;
      const dy = e.clientY - dragStartY.current;
      const dx = e.clientX - dragStartX.current;
      if (Math.abs(dy) > 3 || Math.abs(dx) > 3) {
        hasDragged.current = true;
      }
      // Dragging inward (down/right): increases towards 1.0 (pressed)
      // Dragging outward (up/left): decreases towards 0.0 (released)
      const sensitivity = 85;
      const delta = (dy + dx * 0.8) / sensitivity;
      const newVal = Math.max(0.0, Math.min(1.0, dragStartVal.current + delta));
      onHandleChange(Math.round(newVal * 100) / 100);
    },
    [isSqueezing, onHandleChange]
  );

  const handleMouseUp = useCallback(() => {
    if (!isSqueezing) return;
    setIsSqueezing(false);
    if (!hasDragged.current) {
      // Click without drag: toggle between fully pressed (1.0) and released (0.0)
      const nextVal = handlePos >= 0.5 ? 0.0 : 1.0;
      onHandleChange(nextVal);
    }
    // If dragged: stays at the set position so the user can listen to the decreased effect!
  }, [isSqueezing, handlePos, onHandleChange]);

  useEffect(() => {
    if (isSqueezing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isSqueezing, handleMouseMove, handleMouseUp]);

  // Lever squeeze angle: hinges at (338.805, 240.78), rotates inward by up to 7.5 degrees
  // When handlePos is 1.0 (pressed by default), lever is rotated inward (7.5deg) and effect is enabled.
  // Releasing the handle (handlePos -> 0.0) rotates outward (0deg) and decreases the effect.
  const leverAngle = handlePos * 7.5;

  return (
    <div className="flex flex-col items-center select-none relative">
      {/* Container matching Teenage Engineering EP-2350 silhouette */}
      <div 
        className="relative"
        style={{ width: 275, height: 545 }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="275 2.0 305 588.0"
          preserveAspectRatio="xMidYMin meet"
          className="w-full h-full overflow-visible"
          style={{ overflow: 'visible' }}
          fill="none"
        >
          <defs>
            {/* LED Active Red Glow Filter */}
            <filter id="ledGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* CARTOON SHAKE MOVEMENT (SEMI-TRANSPARENT GHOST COPIES) */}
          {isCartoonShaking && (
            <g className="pointer-events-none select-none" style={{ overflow: 'visible' }}>
              {/* Outer Ghost Copy (rotated further, lighter opacity) */}
              <g
                style={{
                  transformOrigin: '445px 420px',
                  animation: 'cartoonShakeGhost2 420ms cubic-bezier(0.2, 0.9, 0.4, 1.1) forwards'
                }}
              >
                <use href="#micGraphic" />
              </g>

              {/* Inner Ghost Copy (rotated medium, higher opacity) */}
              <g
                style={{
                  transformOrigin: '445px 420px',
                  animation: 'cartoonShakeGhost1 420ms cubic-bezier(0.2, 0.9, 0.4, 1.1) forwards'
                }}
              >
                <use href="#micGraphic" />
              </g>
            </g>
          )}

          {/* HORIZONTAL ORANGE AFFORDANCE ARROWS (ALWAYS VISIBLE) */}
          <g className="select-none" style={{ overflow: 'visible' }}>
            {/* 1. Horizontal "Push ->" Arrow pointing to the visual middle of the lever */}
            <g
              onMouseDown={handleHandleMouseDown}
              className="cursor-pointer"
              aria-label="Push lever indicator arrow"
            >
              <title>Push or release lever to control effect</title>
              <text
                x="259"
                y="120"
                textAnchor="end"
                fill="#F15A22"
                className="font-te-regular text-[13px] font-bold tracking-wide"
              >
                Push
              </text>
              <line
                x1="265"
                y1="116"
                x2="294"
                y2="116"
                stroke="#F15A22"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <polygon
                points="291 110, 302 116, 291 122"
                fill="#F15A22"
              />
            </g>

            {/* 2. Horizontal "Shake ->" Arrow pointing to the middle of the Mic FX / Ting FX lower block */}
            <g
              onClick={(e) => {
                e.stopPropagation();
                triggerCartoonShake();
              }}
              className="cursor-pointer"
              aria-label="Shake Mic FX block indicator arrow"
            >
              <title>Click Mic FX block to SHAKE</title>
              <text
                x="290"
                y="263"
                textAnchor="end"
                fill="#F15A22"
                className="font-te-regular text-[13px] font-bold tracking-wide"
              >
                Shake
              </text>
              <line
                x1="296"
                y1="259"
                x2="325"
                y2="259"
                stroke="#F15A22"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <polygon
                points="322 253, 333 259, 322 265"
                fill="#F15A22"
              />
            </g>
          </g>

          {/* MAIN STATIONARY FOREGROUND MIC */}
          <g id="micGraphic">
            {/* ========================================================= */}
            {/* TE AXONOMETRIC 3D CHASSIS: CLEAN SOLID 45° BEVELS (NO SHADOW) */}
            {/* ========================================================= */}

          {/* C. 45° EXTRUDED BEVEL PANELS (dx = +6.0, dy = +6.0) */}
          {/* 1. Acoustic Grille Side Bevel (Upper Section) */}
          <polygon
            points="551.475 4.283 557.475 10.283 557.475 188.826 551.475 182.826"
            fill={isTing ? '#c2b69f' : '#727d84'}
            stroke="#000000"
            strokeWidth="1.0"
            strokeMiterlimit="10"
          />

          {/* 2. Lower Faceplate Side Bevel */}
          <polygon
            points="551.475 182.826 557.475 188.826 557.475 340.555 551.475 334.555"
            fill={isTing ? '#d5d6d0' : '#dbdddb'}
            stroke="#000000"
            strokeWidth="1.0"
            strokeMiterlimit="10"
          />

          {/* 3. Bottom Chassis Bevel */}
          <polygon
            points="338.805 334.555 344.805 340.555 557.475 340.555 551.475 334.555"
            fill={isTing ? '#d5d6d0' : '#dbdddb'}
            stroke="#000000"
            strokeWidth="1.0"
            strokeMiterlimit="10"
          />

          {/* D. AUTHENTIC 45° DIAGONAL HATCHING LINES (TE Blueprint Aesthetic) */}
          {/* Bottom Bevel Hatching Lines */}
          {Array.from({ length: 58 }).map((_, i) => {
            const x = 340 + i * 3.65;
            return (
              <line
                key={`hatch-b-${i}`}
                x1={x}
                y1={334.555}
                x2={x + 6.0}
                y2={340.555}
                stroke="#000000"
                strokeWidth="0.75"
                strokeMiterlimit="10"
              />
            );
          })}

          {/* Right Side Bevel Hatching Lines */}
          {Array.from({ length: 90 }).map((_, i) => {
            const y = 5 + i * 3.65;
            return (
              <line
                key={`hatch-r-${i}`}
                x1={551.475}
                y1={y}
                x2={557.475}
                y2={y + 6.0}
                stroke="#000000"
                strokeWidth="0.75"
                strokeMiterlimit="10"
              />
            );
          })}

          {/* 1. SQUEEZE HANDLE LEVER (Hinged at 338.805, 240.78) */}
          {/* Fully pressed by default (leverAngle = 7.5deg, handlePos = 1.0) enables effect */}
          {/* Click to toggle; drag outward (left/up) to release handle and decrease effect */}
          <g
            onMouseDown={handleHandleMouseDown}
            className={isSqueezing ? 'cursor-grabbing' : 'cursor-pointer'}
            style={{
              transformOrigin: '338.805px 240.78px',
              transform: `rotate(${leverAngle}deg)`,
              transition: isSqueezing ? 'none' : 'transform 0.16s cubic-bezier(0.18, 0.89, 0.32, 1.28)'
            }}
          >
            <title>Squeeze lever: Fully pressed enables effect (Click to toggle, drag to decrease/increase)</title>
            {/* Squeeze lever body */}
            <path
              fill={isTing ? '#00503A' : '#F15A22'}
              d="M338.805 240.78a3.466 3.466 0 0 1-3.465-3.465v-26.173a25.2 25.2 0 0 0-1.164-7.567L292.02 69.755c-1.212-3.85.572-8.034 4.219-9.761 22.007-10.42 46.614-16.249 72.582-16.249"
            />
            <path
              stroke="#000"
              strokeWidth="1.2"
              strokeMiterlimit="10"
              d="M338.805 240.78a3.466 3.466 0 0 1-3.465-3.465v-26.173a25.2 25.2 0 0 0-1.164-7.567L292.02 69.755c-1.212-3.85.572-8.034 4.219-9.761 22.007-10.42 46.614-16.249 72.582-16.249"
            />
          </g>

          {/* Top circle detail */}
          <path stroke="#000" strokeWidth="1.2" strokeMiterlimit="10" d="M353.679 70.65a9.494 9.494 0 1 0 0-18.99 9.494 9.494 0 0 0 0 18.99Z" />

          {/* ========================================================= */}
          {/* 2. 3D SIDE-MOUNTED CYLINDRICAL HARDWARE BUTTONS           */}
          {/* ========================================================= */}

          {/* BUTTON 1: PRESET SELECTOR (Orange) */}
          <SideButton
            cy={51}
            title="Preset Selector Button"
            bodyFill="#F15A22"
            highlightFill="#ff7d4d"
            shadowFill="#b53708"
            capFill="#f56a36"
            onClick={cyclePreset}
          />

          {/* BUTTON 2: SAMPLE SLOT SELECTOR (White on FX / Green on Ting) */}
          <SideButton
            cy={127}
            title="Sample Selector Button (Slots 1-4)"
            bodyFill={isTing ? '#00503A' : '#E4E3DF'}
            highlightFill={isTing ? '#006e50' : '#f5f4f0'}
            shadowFill={isTing ? '#002d20' : '#a8aaa5'}
            capFill={isTing ? '#005c43' : '#ecebe7'}
            onClick={cycleSampleSlot}
          />

          {/* BUTTON 3: SAMPLE TRIGGER (Grey on FX / Off-White on Ting) */}
          <SideButton
            cy={256}
            title="Sample Trigger Button (Play Selected Sample)"
            bodyFill={isTing ? '#E8E9E4' : '#D1D3D4'}
            highlightFill={isTing ? '#f7f8f4' : '#e6e8e9'}
            shadowFill={isTing ? '#b2b5ad' : '#8c8f92'}
            capFill={isTing ? '#eff0ec' : '#dcdfe0'}
            isPressed={isSamplePressing}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              e.stopPropagation();
              setIsSamplePressing(true);
              onSampleTrigger?.(true);
            }}
            onMouseUp={(e) => {
              e.stopPropagation();
              if (isSamplePressing) {
                setIsSamplePressing(false);
                onSampleTrigger?.(false);
              }
            }}
            onMouseLeave={() => {
              if (isSamplePressing) {
                setIsSamplePressing(false);
                onSampleTrigger?.(false);
              }
            }}
          />

          {/* 3. MICROPHONE GRILLE (Acoustic Top Section) */}
          <path
            fill={isTing ? '#c8bca5' : '#818E95'}
            stroke="#000"
            strokeWidth="1.2"
            strokeMiterlimit="10"
            d="M551.475 182.826h-212.67V4.283A3.78 3.78 0 0 1 342.584.5h205.08a3.813 3.813 0 0 1 3.811 3.815z"
          />

          {isTing ? (
            <>
              {/* TING LOUVERED HORIZONTAL RIB GRILLE & CIRCULAR SPEAKER CUTOUT */}
              {/* Center Circular Acoustic Foam Cavity */}
              <circle
                cx={445.229}
                cy={91.652}
                r={61.708}
                fill="#231F20"
                stroke="#141617"
                strokeWidth="0.8"
              />

              {/* 12 Molded Horizontal Louver Ribs */}
              {TING_LOUVER_Y.map((ry, idx) => (
                <g key={`ting-rib-${idx}`}>
                  <rect
                    x={338.805}
                    y={ry}
                    width={212.67}
                    height={7.58}
                    fill="#DBD0B9"
                    stroke="#000"
                    strokeWidth="0.9"
                  />
                  {/* Subtle top highlight on each molded rib */}
                  <line
                    x1={339.6}
                    y1={ry + 1.1}
                    x2={550.6}
                    y2={ry + 1.1}
                    stroke="#ede6d6"
                    strokeWidth="0.9"
                  />
                </g>
              ))}

              {/* Lower 4 Indicator Dots in Louver Grooves */}
              {[106.792, 121.965, 137.138, 152.344].map((cy, idx) => (
                <circle
                  key={`ting-low-dot-${idx}`}
                  cx={521.08}
                  cy={cy}
                  r={3.2}
                  fill="#4D5158"
                  stroke="#000"
                  strokeWidth="0.8"
                />
              ))}
            </>
          ) : (
            <>
              {/* Laser-cut Perforation Pattern Dots (All 14 rows from authentic TE device vector) */}
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M352.104 8.097a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM367.294 8.097a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001ZM382.483 8.097a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001ZM397.673 8.097a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001ZM412.863 8.097a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0ZM428.052 8.097a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0ZM443.242 8.097a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0ZM458.431 8.097a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0ZM473.622 8.097a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001ZM488.811 8.097a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM504.001 8.097a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001ZM549.571 8.097a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM519.191 8.097a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0ZM534.38 8.097a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001ZM519.191 175.184a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0ZM534.38 175.184a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM352.104 23.286a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002Z" />
              <path fill="#231F20" d="M367.294 23.286a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M382.483 23.286a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M397.673 23.286a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M412.863 23.286a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 23.286a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 23.286a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 23.286a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 23.286a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M488.811 23.286a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M504.001 23.286a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 23.286a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM352.104 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001Z" />
              <path fill="#231F20" d="M367.294 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M382.483 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M397.673 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M412.863 38.476a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 38.476a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 38.476a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 38.476a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M488.811 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M504.001 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 38.476a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001ZM352.104 53.665a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002Z" />
              <path fill="#231F20" d="M367.294 53.665a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M382.483 53.665a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M397.673 53.665a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M412.863 53.665a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 53.665a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 53.665a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 53.665a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 53.665a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001M488.811 53.665a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M504.001 53.665a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394.001" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 53.665a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM352.104 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002Z" />
              <path fill="#231F20" d="M367.294 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M382.483 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M397.673 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M412.863 68.856a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 68.856a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 68.856a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 68.856a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M488.811 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M504.001 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 68.856a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM352.104 84.046a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002Z" />
              <path fill="#231F20" d="M367.294 84.046a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394 0M382.483 84.046a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394 0M397.673 84.046a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394 0M412.863 84.046a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 84.046a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 84.046a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 84.046a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 84.046a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394 0M488.811 84.046a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M504.001 84.046a5.697 5.697 0 1 1-11.394-.001 5.697 5.697 0 0 1 11.394 0" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 84.046a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM352.104 99.235a5.697 5.697 0 0 1-11.393 0 5.697 5.697 0 0 1 11.393 0Z" />
              <path fill="#231F20" d="M367.294 99.235a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M382.483 99.235a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M397.673 99.235a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M412.863 99.235a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 99.235a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 99.235a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 99.235a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 99.235a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M488.811 99.235a5.697 5.697 0 0 1-11.393 0 5.697 5.697 0 0 1 11.393 0M504.001 99.235a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 99.235a5.697 5.697 0 0 1-11.393 0 5.697 5.697 0 0 1 11.393 0ZM352.104 114.425a5.697 5.697 0 1 1-11.393-.001 5.697 5.697 0 0 1 11.393.001Z" />
              <path fill="#231F20" d="M367.294 114.425a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M382.483 114.425a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M397.673 114.425a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M412.863 114.425a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M428.052 114.425a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M443.242 114.425a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M458.431 114.425a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M473.622 114.425a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M488.811 114.425a5.697 5.697 0 1 1-11.393-.001 5.697 5.697 0 0 1 11.393.001M504.001 114.425a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 114.425a5.697 5.697 0 1 1-11.393-.001 5.697 5.697 0 0 1 11.393.001ZM352.104 129.614a5.697 5.697 0 1 1-11.393-.001 5.697 5.697 0 0 1 11.393.001Z" />
              <path fill="#231F20" d="M367.294 129.614a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M382.483 129.614a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M397.673 129.614a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M412.863 129.614a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M428.052 129.614a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M443.242 129.614a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M458.431 129.614a5.696 5.696 0 1 1-11.392 0 5.696 5.696 0 0 1 11.392 0M473.622 129.614a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M488.811 129.614a5.697 5.697 0 1 1-11.393-.001 5.697 5.697 0 0 1 11.393.001M504.001 129.614a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 129.614a5.697 5.697 0 1 1-11.393-.001 5.697 5.697 0 0 1 11.393.001ZM352.104 144.804a5.697 5.697 0 0 1-11.393 0 5.697 5.697 0 0 1 11.393 0Z" />
              <path fill="#231F20" d="M367.294 144.804a5.697 5.697 0 1 1-11.395 0 5.697 5.697 0 0 1 11.395 0M382.483 144.804a5.697 5.697 0 1 1-11.395 0 5.697 5.697 0 0 1 11.395 0M397.673 144.804a5.697 5.697 0 1 1-11.39 0 5.697 5.697 0 0 1 11.39 0M412.863 144.804a5.697 5.697 0 1 1-11.393 0 5.697 5.697 0 0 1 11.393 0M428.052 144.804a5.697 5.697 0 1 1-11.393 0 5.697 5.697 0 0 1 11.393 0M443.242 144.804a5.697 5.697 0 1 1-11.393 0 5.697 5.697 0 0 1 11.393 0M458.431 144.804a5.697 5.697 0 1 1-11.393 0 5.697 5.697 0 0 1 11.393 0M473.622 144.804a5.697 5.697 0 1 1-11.395 0 5.697 5.697 0 0 1 11.395 0M488.811 144.804a5.697 5.697 0 0 1-11.393 0 5.697 5.697 0 0 1 11.393 0M504.001 144.804a5.697 5.697 0 1 1-11.39 0 5.697 5.697 0 0 1 11.39 0" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 144.804a5.697 5.697 0 0 1-11.393 0 5.697 5.697 0 0 1 11.393 0ZM352.104 159.995a5.697 5.697 0 0 1-11.393 0 5.696 5.696 0 0 1 11.393 0Z" />
              <path fill="#231F20" d="M367.294 159.995a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M382.483 159.995a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M397.673 159.995a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M412.863 159.995a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 159.995a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 159.995a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 159.995a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 159.995a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002M488.811 159.995a5.697 5.697 0 0 1-11.393 0 5.696 5.696 0 0 1 11.393 0M504.001 159.995a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002" />
              <path fill="#4D5158" stroke="#000" strokeWidth="0.5" strokeMiterlimit="10" d="M549.571 159.995a5.697 5.697 0 0 1-11.393 0 5.696 5.696 0 0 1 11.393 0ZM352.104 175.184a5.697 5.697 0 1 1-11.395-.003 5.697 5.697 0 0 1 11.395.003ZM367.294 175.184a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM382.483 175.184a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM397.673 175.184a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM412.863 175.184a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M428.052 175.184a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M443.242 175.184a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M458.431 175.184a5.696 5.696 0 1 1-11.393 0 5.696 5.696 0 0 1 11.393 0M473.622 175.184a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM488.811 175.184a5.697 5.697 0 1 1-11.395-.003 5.697 5.697 0 0 1 11.395.003ZM504.001 175.184a5.697 5.697 0 1 1-11.394-.002 5.697 5.697 0 0 1 11.394.002ZM549.571 175.184a5.697 5.697 0 1 1-11.395-.003 5.697 5.697 0 0 1 11.395.003Z" />

              {/* 4. FLUSH CAPSULE SLOTS (Vertical slot apertures on right of grille) */}
              <path
                fill="#989FA5"
                stroke="#000"
                strokeWidth="1.2"
                strokeMiterlimit="10"
                d="M521.08 159.389c-3.885 0-7.045-3.16-7.045-7.044v-45.552c0-3.838 3.095-6.843 7.044-6.843s7.045 3.006 7.045 6.843v45.552a7.05 7.05 0 0 1-7.044 7.044ZM521.09 83.503c-3.885 0-7.046-3.16-7.046-7.045V30.977c0-3.838 3.095-6.843 7.046-6.843s7.044 3.006 7.044 6.843v45.481c0 3.885-3.161 7.045-7.044 7.045Z"
              />

              {/* Lower Slot Indicator Dots */}
              <path fill="#4D5158" d="M521.08 156.142a3.798 3.798 0 1 0 0-7.596 3.798 3.798 0 0 0 0 7.596ZM521.08 140.935a3.797 3.797 0 1 0 .002-7.594 3.797 3.797 0 0 0-.002 7.594ZM521.08 125.763a3.798 3.798 0 1 0 0-7.596 3.798 3.798 0 0 0 0 7.596ZM521.08 110.59a3.798 3.798 0 1 0 0-7.596 3.798 3.798 0 0 0 0 7.596Z" />
            </>
          )}

          {/* UPPER SLOT: 4 INTERACTIVE PRESET LED APERTURES */}
          {[
            { slot: 0, cy: 30.9275 },
            { slot: 1, cy: 46.1005 },
            { slot: 2, cy: 61.2735 },
            { slot: 3, cy: 76.4465 }
          ].map(({ slot, cy }) => {
            const isActive = slot <= activeSlot;
            return (
              <g
                key={slot}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectSlot(activeSlot === slot ? -1 : slot);
                }}
                className="cursor-pointer group"
              >
                <title>{activeSlot === slot ? `Preset ${slot + 1} (Click to switch FX OFF)` : `Preset ${slot + 1}`}</title>
                {/* Hit area */}
                <circle cx={521.08} cy={cy} r={8} fill="transparent" />

                {/* Outer Bezel Rim */}
                <circle
                  cx={521.08}
                  cy={cy}
                  r={3.798}
                  fill="#181a1c"
                  stroke="#000"
                  strokeWidth="0.8"
                />

                {/* Core LED Lamp */}
                <circle
                  cx={521.08}
                  cy={cy}
                  r={2.8}
                  fill={isActive ? '#ff3b30' : '#2b3034'}
                  filter={isActive ? 'url(#ledGlow)' : undefined}
                />

                {/* Specular highlight for active LED */}
                {isActive && (
                  <circle cx={520.3} cy={cy - 0.9} r={0.9} fill="#ffffff" opacity={0.9} />
                )}
              </g>
            );
          })}

          {/* LOWER SLOT: 4 INTERACTIVE SAMPLE LED APERTURES */}
          {[
            { slot: 0, cy: 106.792 },
            { slot: 1, cy: 121.965 },
            { slot: 2, cy: 137.138 },
            { slot: 3, cy: 152.344 }
          ].map(({ slot, cy }) => {
            const isActive = slot <= activeSampleSlot;
            return (
              <g
                key={`sample-led-${slot}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectSampleSlot?.(slot);
                }}
                className="cursor-pointer group"
              >
                <title>{`Sample Slot ${slot + 1}`}</title>
                {/* Hit area */}
                <circle cx={521.08} cy={cy} r={8} fill="transparent" />

                {/* Outer Bezel Rim */}
                <circle
                  cx={521.08}
                  cy={cy}
                  r={3.798}
                  fill="#181a1c"
                  stroke="#000"
                  strokeWidth="0.8"
                />

                {/* Core LED Lamp */}
                <circle
                  cx={521.08}
                  cy={cy}
                  r={2.8}
                  fill={isActive ? '#ffffff' : '#2b3034'}
                  filter={isActive ? 'url(#ledGlow)' : undefined}
                />

                {/* Specular highlight for active LED */}
                {isActive && (
                  <circle cx={520.3} cy={cy - 0.9} r={0.9} fill="#ffffff" opacity={0.9} />
                )}
              </g>
            );
          })}

          {/* 5. LOWER CHASSIS FACEPLATE (Big Block with MIC FX / TING FX — Click to SHAKE) */}
          <g
            onClick={(e) => {
              e.stopPropagation();
              triggerCartoonShake();
            }}
            className="cursor-pointer group"
            aria-label="Click Mic FX block to SHAKE"
          >
            <title>Click Mic FX block to SHAKE</title>
            <path
              fill={isTing ? '#E8E9E4' : '#E4E3DF'}
              stroke="#000"
              strokeWidth="1.2"
              strokeMiterlimit="10"
              d="M338.805 182.804h212.67v147.938a3.814 3.814 0 0 1-3.812 3.813H342.617a3.814 3.814 0 0 1-3.812-3.813z"
            />

            {/* 4 Precision Corner Screws with 45° angled slot */}
            {[
              { cx: 353.992, cy: 197.79 },
              { cx: 536.269, cy: 197.79 },
              { cx: 353.992, cy: 319.31 },
              { cx: 536.269, cy: 319.31 }
            ].map((screw, i) => (
              <g key={i}>
                <circle
                  cx={screw.cx}
                  cy={screw.cy}
                  r={9.043}
                  fill={isTing ? '#dfe0db' : '#d6d8d7'}
                  stroke="#000"
                  strokeWidth="1.2"
                />
                {/* 45° screw slot */}
                <line
                  x1={screw.cx - 5.5}
                  y1={screw.cy - 5.5}
                  x2={screw.cx + 5.5}
                  y2={screw.cy + 5.5}
                  stroke="#141617"
                  strokeWidth="1.5"
                />
              </g>
            ))}

            {isTing ? (
              <>
                {/* Authentic 'TING' Typography (Orange #F15A22) */}
                <path
                  fill="#F15A22"
                  d="M 368.929 214.165 v 11.399 c 0.000 0.519 0.420 0.939 0.939 0.939 h 3.744 c 0.519 0.000 0.939 0.422 0.939 0.939 l 0.012 22.432 c 0.000 0.519 0.422 0.939 0.939 0.939 h 1.879 a 0.939 0.939 0 0 0 0.939 -0.939 l -0.012 -22.430 c 0.000 -0.519 0.420 -0.941 0.939 -0.941 h 3.771 a 0.939 0.939 0 0 0 0.939 -0.939 v -11.399 a 0.939 0.939 0 0 0 -0.939 -0.939 h -13.148 a 0.939 0.939 0 0 0 -0.939 0.939 M 389.536 213.226 h -1.877 a 0.941 0.941 0 0 0 -0.941 0.939 v 35.685 c 0.000 0.519 0.422 0.939 0.941 0.939 h 1.877 a 0.939 0.939 0 0 0 0.939 -0.939 v -35.685 a 0.939 0.939 0 0 0 -0.939 -0.939 M 425.182 231.850 v 1.877 c 0.000 0.519 0.420 0.941 0.939 0.941 h 3.884 c 0.217 0.000 0.364 0.238 0.252 0.426 a 5.933 5.933 0 0 1 -5.050 2.876 c -3.165 0.012 -5.857 -2.584 -5.952 -5.747 a 5.929 5.929 0 0 1 10.227 -4.265 0.951 0.951 0 0 0 0.695 0.312 h 3.444 a 0.939 0.939 0 0 0 0.939 -0.939 v -4.804 c 0.000 -5.057 -3.886 -9.408 -8.937 -9.646 a 9.385 9.385 0 0 0 -9.844 9.379 v 19.267 c 0.000 5.057 3.886 9.408 8.937 9.646 a 9.392 9.392 0 0 0 9.844 -9.379 v -9.944 a 0.939 0.939 0 0 0 -0.939 -0.939 l -7.500 -0.002 a 0.941 0.941 0 0 0 -0.939 0.941 M 402.535 212.852 c -5.050 0.238 -8.935 4.587 -8.935 9.644 v 27.344 c 0.000 0.519 0.420 0.939 0.939 0.939 h 1.877 a 0.939 0.939 0 0 0 0.939 -0.939 v -18.124 a 5.635 5.635 0 0 1 11.269 0.000 v 18.124 c 0.000 0.519 0.422 0.939 0.941 0.939 h 1.877 a 0.939 0.939 0 0 0 0.939 -0.939 v -27.609 a 9.385 9.385 0 0 0 -9.844 -9.379"
                />
                {/* Authentic 'FX' Typography (Deep Green #00503A) */}
                <path
                  fill="#00503A"
                  d="M 455.416 215.176 v 4.833 h 6.948 v 1.209 h -6.948 v 6.043 h -1.209 v -13.293 h 9.365 v 1.207 z M 474.797 215.085 l -4.366 5.530 4.366 5.530 v 1.116 h -1.209 v -0.697 l -3.926 -4.974 -3.928 4.974 v 0.697 h -1.209 v -1.118 l 4.364 -5.528 -4.364 -5.530 v -1.116 h 1.209 v 0.697 l 3.928 4.974 3.926 -4.974 v -0.697 h 1.209 z"
                />
              </>
            ) : (
              <>
                {/* Authentic 'MIC' Typography (black) */}
                <path
                  fill="#000"
                  d="M391.474 240.119h-2.43v-23.662l-7.292 13.976h-2.316l-7.292-13.976v23.662h-2.43v-26.587h3.608l7.254 13.901 7.254-13.901h3.647v26.587zM395.382 213.534h2.43v26.586h-2.43zM421.738 231.915l-.265 1.178a8.744 8.744 0 0 1-8.583 7.026h-3.001c-4.824 0-8.773-3.949-8.773-8.773v-9.04c0-4.862 3.95-8.774 8.773-8.774h3.001a8.66 8.66 0 0 1 6.418 2.811 8.65 8.65 0 0 1 2.165 4.216l.265 1.177-2.392.456-.228-1.176a6.3 6.3 0 0 0-1.558-3.039 6.46 6.46 0 0 0-4.671-2.013h-3.001c-3.494 0-6.343 2.848-6.343 6.343v9.04c0 3.494 2.848 6.342 6.343 6.342h3.001c2.999 0 5.621-2.089 6.228-5.052l.227-1.177z"
                />

                {/* Authentic 'FX' Typography (orange #F15A22) */}
                <path
                  fill="#F15A22"
                  d="M428.052 226.92h1.342v-6.044l6.949.002v-1.343h-6.949v-4.699h8.157v-1.342h-9.499zM448.768 214.701v-1.207h-1.342v.74l-3.861 4.889-3.861-4.889v-.74h-1.342v1.207l4.347 5.506-4.332 5.487-.015.019v1.207h1.342v-.74l3.861-4.89 3.861 4.89v.74h1.342v-1.206l-4.348-5.507 4.333-5.488z"
                />
              </>
            )}
          </g>

          {/* 6. REINFORCED RUBBER CABLE SEGMENT & CORRUGATED STRAIN RELIEF */}
          <g onClick={(e) => e.stopPropagation()}>
            <path
              fill={isTing ? '#1d4d3c' : '#D1D3D4'}
              d="M420.295 510.223c5.516-.966 5.987-8.759.601-10.406-9.892-2.092-27.87-3.097-33.629-3.374-.836-.04-1.316-.944-.898-1.671 12.004-20.912 17.838-45.201 18.244-69.249-.006-.243.144-22.135.148-22.382h-10.874l.075 21.819v-.332c.304 17.825-3.899 36.651-10.996 52.973-2.72 7.395-8.888 14.338-9.232 22.35v.185c0 6.587 9.616 6.389 19.533 7.291 9.918.901 18.568 1.658 27.548 2.601"
            />
            <path
              stroke="#000"
              strokeWidth="1.2"
              strokeMiterlimit="10"
              d="M420.295 510.223c5.516-.966 5.987-8.759.601-10.406-9.892-2.092-27.87-3.097-33.629-3.374-.836-.04-1.316-.944-.898-1.671 12.004-20.912 17.838-45.201 18.244-69.249-.006-.243.144-22.135.148-22.382h-10.874l.075 21.819v-.332c.304 17.825-3.899 36.651-10.996 52.973-2.72 7.395-8.888 14.338-9.232 22.35v.185c0 6.587 9.616 6.389 19.533 7.291 9.918.901 18.568 1.658 27.548 2.601"
            />

            {/* 7. CORRUGATED STRAIN RELIEF & CONNECTOR (Accordion Bellows with Per-Rib 45° Extrusion) */}
            {(() => {
              const d = 3.2;
              const sideBevelFill = isTing ? '#ba3807' : '#586166';
              const bottomBevelFill = isTing ? '#8c2603' : '#464d52';
              const neckBevelFill = isTing ? '#8c2603' : '#4a5257';

              const wideRibs = [
                { x1: 384.364, x2: 414.743, y1: 334.555, y2: 342.092, neckLeft: 393.844, neckRight: 405.237 },
                { x1: 384.364, x2: 414.743, y1: 349.686, y2: 357.270, neckLeft: 393.844, neckRight: 405.237 },
                { x1: 384.364, x2: 414.743, y1: 364.866, y2: 372.472, neckLeft: 393.844, neckRight: 405.237 },
                { x1: 384.364, x2: 414.743, y1: 380.066, y2: 387.916, neckLeft: 393.844, neckRight: 405.237 },
                { x1: 384.024, x2: 414.403, y1: 395.521, y2: 403.372, neckLeft: 393.816, neckRight: 404.690 }
              ];

              const narrowNecks = [
                { x1: 393.844, x2: 405.237, y1: 342.093, y2: 349.688 },
                { x1: 393.844, x2: 405.237, y1: 357.271, y2: 364.866 },
                { x1: 393.844, x2: 405.237, y1: 372.466, y2: 380.060 },
                { x1: 393.844, x2: 405.237, y1: 387.920, y2: 395.514 }
              ];

              return (
                <g>
                  {/* Recessed Neck Right 45° Bevels */}
                  {narrowNecks.map((neck, i) => (
                    <polygon
                      key={`neck-bevel-${i}`}
                      points={`${neck.x2} ${neck.y1} ${neck.x2 + d} ${neck.y1 + d} ${neck.x2 + d} ${neck.y2} ${neck.x2} ${neck.y2}`}
                      fill={neckBevelFill}
                      stroke="#000"
                      strokeWidth="0.9"
                      strokeLinejoin="round"
                    />
                  ))}

                  {/* Per-Rib 45° Right & Bottom Overhang Bevels */}
                  {wideRibs.map((rib, i) => (
                    <g key={`rib-bevels-${i}`}>
                      {/* Left overhang bottom bevel */}
                      <polygon
                        points={`${rib.x1} ${rib.y2} ${rib.neckLeft} ${rib.y2} ${rib.neckLeft} ${rib.y2 + d} ${rib.x1 + d} ${rib.y2 + d}`}
                        fill={bottomBevelFill}
                        stroke="#000"
                        strokeWidth="0.9"
                        strokeLinejoin="round"
                      />
                      {/* Right overhang bottom bevel */}
                      <polygon
                        points={`${rib.neckRight} ${rib.y2} ${rib.x2} ${rib.y2} ${rib.x2 + d} ${rib.y2 + d} ${rib.neckRight + d} ${rib.y2 + d}`}
                        fill={bottomBevelFill}
                        stroke="#000"
                        strokeWidth="0.9"
                        strokeLinejoin="round"
                      />
                      {/* Rib right side bevel */}
                      <polygon
                        points={`${rib.x2} ${rib.y1} ${rib.x2 + d} ${rib.y1 + d} ${rib.x2 + d} ${rib.y2 + d} ${rib.x2} ${rib.y2}`}
                        fill={sideBevelFill}
                        stroke="#000"
                        strokeWidth="0.9"
                        strokeLinejoin="round"
                      />
                    </g>
                  ))}
                </g>
              );
            })()}

            <path
              fill={isTing ? '#F15A22' : '#818E95'}
              stroke="#000"
              strokeWidth="1.2"
              strokeMiterlimit="10"
              d="M414.743 380.066h-30.379v7.85h30.379zM414.743 364.866h-30.379v7.606h30.379zM414.743 334.555h-30.379v7.537h30.379zM414.743 349.686h-30.379v7.584h30.379z"
            />
            <path
              fill={isTing ? '#F15A22' : '#818E95'}
              stroke="#000"
              strokeWidth="1.2"
              strokeMiterlimit="10"
              d="M405.237 342.093h-11.393v7.595h11.393zM405.237 357.271h-11.393v7.595h11.393zM405.237 372.466h-11.393v7.594h11.393zM414.403 395.521h-30.379v7.851h30.379zM405.237 387.92h-11.393v7.594h11.393z"
            />

            {/* Flexible Corrugated Bellows - extends behind Audition Module and off the bottom of the screen */}
            {Array.from({ length: 52 }, (_, i) => 520.391 + i * 10.456).map((yVal, i) => (
              <path
                key={i}
                fill={isTing ? '#00503A' : '#D1D3D4'}
                stroke="#000"
                strokeWidth="1.2"
                strokeMiterlimit="10"
                d={`M418.334 ${yVal}c2.18.43 4.533-.372 5.644-2.296 1.606-2.781.325-6.601-3.742-7.781-13.586-2.743-26.006-2.124-39.785-4.675-3.86-.715-7.413 2.827-6.225 6.569.49 1.543 1.658 2.887 3.53 3.457 13.279 3.12 27.142 2.071 40.576 4.726z`}
              />
            ))}
          </g>
        </g>
      </svg>
    </div>
  </div>
);
};
