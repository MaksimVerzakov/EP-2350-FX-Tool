import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { ThemeMode } from '../types/config';
import { bottomBevelPoints, rightBevelPoints, useBlockWidth } from './useBlockWidth';
import { themeColor } from '../theme/tokens';

interface DeviceConnectorProps {
  theme: ThemeMode;
  isSupported: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  /** Current pack differs from what was last read from / saved to the mic. */
  hasUnsavedChanges: boolean;
  onConnect: () => void;
  /** Resolves true when the pack was written to the mic. */
  onSave: () => Promise<boolean>;
  onEject: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved';

const EDGE = '#141617';
/**
 * Block face size: 10 x 3 grid cells of 25px (+1px so both borders sit on grid lines), the same as the
 * logo and Export/Import blocks. On phones it stretches to the FX card's width (measured, see useBlockWidth).
 * Bevels add 5px on the right and bottom; the block is lifted by that depth so its back face,
 * not its front, sits on the grid.
 */
const BLOCK_H = 76;
/** Header row height, identical to the Export/Import block. */
const HEADER_H = 25;
/** Inner body size (inside the 1px border, below the header row). */
const BODY_H = BLOCK_H - 2 - HEADER_H;

/** Flat floppy glyph in the style of the EP-133 "FLOPPY!" screen icon (cut-outs are transparent). */
export const FloppyIcon: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
  <svg viewBox="0 0 16 16" className={className} style={style} aria-hidden="true">
    <path
      fillRule="evenodd"
      fill="currentColor"
      d="M1 1h11.2L15 3.8V15H1V1Zm3 0v4.4h6.6V1H4Zm4.4.9h1.4v2.6H8.4V1.9ZM3.4 8.6v5.4h9.2V8.6H3.4Z"
    />
  </svg>
);

/** Flat eject glyph matching the floppy: solid triangle over a bar. */
export const EjectIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
    <path fill="currentColor" d="M8 1.6 14.6 9.4H1.4L8 1.6ZM1.4 11.4h13.2V14.4H1.4v-3Z" />
  </svg>
);

/** Plug scale (px per source unit) and geometry of the source drawing (vertical, tip down). */
const PLUG_SCALE = 0.72;
const PLUG_TIP_END = 78.0; // source y of the USB-C tip end
const PLUG_CORD_X = 220.062; // source x of the cord centre line
const PLUG_BOOT_END = 72.563; // source y of the boot's bottom bevel (where the USB-C tip begins)
const PLUG_REST_GAP = 6; // gap between the tip and the body's bottom edge at rest
/** How far the plug drops when plugged: the whole USB-C tip disappears below the bottom edge. */
const PLUG_TRAVEL = PLUG_REST_GAP + (PLUG_TIP_END - PLUG_BOOT_END) * PLUG_SCALE + 0.5;

/**
 * USB-C cable hanging into the connector body from the top, with the same form as the plug in
 * Teenage Engineering's EP sample tool (strain relief, boot with 45° bevels, USB-C tip). It is
 * still at rest; on hover it drops into the mic (the tip disappears below the body's bottom edge)
 * and lifts out on a loop, and while connecting it stays plugged in.
 */
const UsbCable: React.FC<{
  width: number;
  height: number;
  mode: 'loop' | 'in' | 'out';
  dim: boolean;
  pageColor: string;
  cordColor: string;
}> = ({ width, height, mode, dim, pageColor, cordColor }) => {
  const contact = '#dbdddb';
  const stroke = { stroke: EDGE, strokeWidth: 0.9, vectorEffect: 'non-scaling-stroke' as const, strokeMiterlimit: 10 };
  const s = PLUG_SCALE;
  const tx = width / 2 - PLUG_CORD_X * s;
  const ty = height - PLUG_REST_GAP - PLUG_TIP_END * s;
  const motion = mode === 'loop' ? 'ep-plug-loop' : mode === 'in' ? 'ep-plug-in' : '';
  return (
    <svg
      className="absolute inset-0 pointer-events-none overflow-hidden"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      opacity={dim ? 0.45 : 1}
      data-testid="usb-cable"
      data-mode={mode}
    >
      <g className={motion} style={{ ['--ep-plug-travel' as string]: `${PLUG_TRAVEL}px` }}>
        <g transform={`translate(${tx} ${ty}) scale(${s})`}>
          {/* Cord (runs up past the top of the body) */}
          <line x1="220.062" y1="51.312" x2="220.062" y2="-60" stroke={cordColor} strokeWidth="3.75" />
          {/* Strain relief */}
          <path
            d="M220.063,38.812c-2.071,0-3.75,.56-3.75,1.25v17.5h5v-5h2.5v-12.5c0-.69-1.679-1.25-3.75-1.25Z"
            fill={contact}
            {...stroke}
          />
          {/* Boot + 45° right and bottom bevels */}
          <rect x="212.562" y="52.562" width="12.5" height="17.5" fill={contact} {...stroke} />
          <polygon points="225.062 70.062 225.062 52.562 227.562 55.062 227.562 72.562 225.062 70.062" fill={contact} {...stroke} />
          <polygon points="212.562 70.062 215.062 72.563 227.562 72.562 225.062 70.062 212.562 70.062" fill={contact} {...stroke} />
          {/* USB-C tip */}
          <path
            d="M215.688,71.666h0c0-.524,.725-.948,1.619-.948h5.227c.894,0,1.619,.425,1.619,.948h0v5.393h-8.465v-5.393h0Z"
            fill={pageColor}
            {...stroke}
          />
          <path
            d="M217.307,78.007c-.894,0-1.619-.425-1.619-.948h0c0-.524,.725-.948,1.619-.948h5.227c.894,0,1.619,.425,1.619,.948h0c0,.524-.725,.948-1.619,.948h-5.227Z"
            fill={pageColor}
            {...stroke}
          />
        </g>
      </g>
    </svg>
  );
};

/** 11px modular corner ring, as used on every TE-style block. */
const Ring: React.FC<{ pos: string; tone: string }> = ({ pos, tone }) => (
  <span className={`w-[11px] h-[11px] rounded-full border absolute ${pos} pointer-events-none ${tone}`} />
);

export const DeviceConnector: React.FC<DeviceConnectorProps> = ({
  theme,
  isSupported,
  isConnected,
  isConnecting,
  hasUnsavedChanges,
  onConnect,
  onSave,
  onEject
}) => {
  const isTing = theme === 'ting';
  const [hovered, setHovered] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  useEffect(() => {
    if (!isConnected) setSaveState('idle');
    setHovered(false);
  }, [isConnected]);

  const lightBevel = themeColor('bevel', isTing);
  const bodyFace = 'bg-te-face';
  const bodyHover = 'group-hover:bg-te-face-hover';
  const darkBevel = themeColor('ink-deep', isTing);
  const ink = themeColor('ink', isTing);
  const pageColor = themeColor('page', isTing);
  const lightRing = 'border-te-ink/40';

  const canSave = hasUnsavedChanges && saveState === 'idle';

  const handleSave = async () => {
    if (!canSave) return;
    setSaveState('saving');
    const ok = await onSave().catch(() => false);
    if (!ok) {
      setSaveState('idle');
      return;
    }
    setSaveState('saved');
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaveState('idle'), 1600);
  };

  const [wrapRef, W] = useBlockWidth<HTMLDivElement>();
  const H = BLOCK_H;
  const bevel = (points: string, fill: string, key: string) => (
    <polygon key={key} points={points} fill={fill} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
  );

  return (
    <div ref={wrapRef} className="w-full sm:w-auto relative -left-[5px] -top-[5px] pr-[5px] pb-[5px]" data-testid="device-connector">
      {/* 45° axonometric bevels (bottom & right), colour-matched to the faces beside them */}
      <svg
        className="absolute inset-0 pointer-events-none"
        style={{ width: W + 5, height: H + 5 }}
        viewBox={`0 0 ${W + 5} ${H + 5}`}
        fill="none"
      >
        {bevel(bottomBevelPoints(0, W - 1, H), lightBevel, 'bottom')}
        {bevel(
          rightBevelPoints(W, 0, HEADER_H),
          isConnected ? darkBevel : '#c94a1b',
          'right-top'
        )}
        {bevel(rightBevelPoints(W, HEADER_H, H - 1), lightBevel, 'right-bottom')}
      </svg>

      <div className="relative z-10 border border-te-edge flex w-full sm:w-[251px]" style={{ height: H }}>
        {!isConnected ? (
          <button
            type="button"
            onClick={onConnect}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
            disabled={!isSupported || isConnecting}
            aria-label={isSupported ? 'Connect the mic' : 'Connect the mic (requires Chrome or Edge)'}
            title={
              isSupported
                ? 'Connect your EP-2350 over USB-C to load and save its presets'
                : 'Web Serial is not available in this browser. Use Chrome or Edge on desktop.'
            }
            className="group w-full h-full flex flex-col cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-te-accent focus-visible:ring-inset"
          >
            {/* Header row: orange, like EXPORT */}
            <span
              className={`relative w-full flex items-center justify-center border-b border-te-edge transition-colors bg-te-accent ${
                isSupported && !isConnecting ? 'group-hover:bg-te-accent-hover' : ''
              }`}
              style={{ height: HEADER_H }}
            >
              <Ring pos="left-[7px] top-[6px]" tone="border-te-edge/55" />
              <span className="font-te-medium text-te-sm tracking-wider uppercase leading-none text-white whitespace-nowrap">
                {!isSupported ? 'chrome / edge only' : isConnecting ? 'connecting…' : 'connect the mic'}
              </span>
              <Ring pos="right-[7px] top-[6px]" tone="border-te-edge/55" />
            </span>
            {/* Body row: grey like the TOOL block, cable only (animates on hover) */}
            <span className={`relative w-full flex-1 overflow-hidden transition-colors ${bodyFace} ${isSupported && !isConnecting ? bodyHover : ''}`}>
              <Ring pos="top-[7px] left-[7px]" tone={lightRing} />
              <Ring pos="top-[7px] right-[7px]" tone={lightRing} />
              <Ring pos="bottom-[7px] left-[7px]" tone={lightRing} />
              <Ring pos="bottom-[7px] right-[7px]" tone={lightRing} />
              <UsbCable
                width={W - 2}
                height={BODY_H}
                mode={!isSupported ? 'out' : isConnecting ? 'in' : hovered ? 'loop' : 'out'}
                dim={!isSupported}
                pageColor={pageColor}
                cordColor={ink}
              />
            </span>
          </button>
        ) : (
          <div className="w-full h-full grid grid-cols-2" role="group" aria-label="Connected mic actions">
            {/* Two equal columns: on the 251px desktop block the divider lands on the 125px grid line,
                and on phones (full-width block) SAVE and EJECT stay the same width. */}
            {/* SAVE column: orange header + grey body with the floppy icon */}
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              aria-label="Save to the mic"
              title={
                saveState === 'saved'
                  ? 'Saved to the mic'
                  : hasUnsavedChanges
                  ? 'Save changes to the mic (writes config.json and reloads the active preset)'
                  : 'Nothing to save: the mic already has this pack'
              }
              className="group flex flex-col cursor-pointer disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-te-accent focus-visible:ring-inset"
            >
              <span
                className={`relative flex items-center justify-center bg-te-accent border-b border-r border-te-edge transition-colors ${canSave ? 'group-hover:bg-te-accent-hover' : ''}`}
                style={{ height: HEADER_H }}
              >
                <Ring pos="left-[7px] top-[6px]" tone="border-te-edge/55" />
                <span className="font-te-medium text-te-sm tracking-wider uppercase leading-none text-white">
                  save
                </span>
              </span>
              <span className={`relative flex-1 flex items-center justify-center transition-colors ${bodyFace} ${canSave ? bodyHover : ''}`}>
                <Ring pos="top-[7px] left-[7px]" tone={lightRing} />
                <Ring pos="bottom-[7px] left-[7px]" tone={lightRing} />
                {saveState === 'saved' ? (
                  <Check className="w-[22px] h-[22px] text-te-accent" strokeWidth={3} data-testid="saved-indicator" />
                ) : (
                  <FloppyIcon
                    className={`w-[22px] h-[22px] transition-colors ${saveState === 'saving' ? 'animate-pulse' : ''}`}
                    style={{ color: hasUnsavedChanges ? '#f15a22' : '#b7bcbb' }}
                  />
                )}
              </span>
            </button>

            {/* EJECT column: black header + grey body with the eject icon */}
            <button
              type="button"
              onClick={onEject}
              aria-label="Eject the mic"
              title="Eject: disconnect from the mic. Also eject the TINGDISK drive in your OS before unplugging."
              className="group flex flex-col cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-te-accent focus-visible:ring-inset"
            >
              <span
                className={`relative flex items-center justify-center border-b border-te-edge transition-colors ${
                  'bg-te-ink group-hover:bg-te-ink-hover'
                }`}
                style={{ height: HEADER_H }}
              >
                <span className="font-te-medium text-te-sm tracking-wider uppercase leading-none text-white">
                  eject
                </span>
                <Ring pos="right-[7px] top-[6px]" tone="border-white/40" />
              </span>
              <span className={`relative flex-1 flex items-center justify-center transition-colors ${bodyFace} ${bodyHover}`}>
                <Ring pos="top-[7px] right-[7px]" tone={lightRing} />
                <Ring pos="bottom-[7px] right-[7px]" tone={lightRing} />
                <EjectIcon className={`w-[20px] h-[20px] transition-colors group-hover:text-te-accent ${'text-te-ink'}`} />
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
