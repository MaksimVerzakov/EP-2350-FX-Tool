import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { ThemeMode } from '../types/config';

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
/** Block face size (bevels add 5px on the right and bottom). */
const BLOCK_W = 156;
const BLOCK_H = 66;

/** Flat floppy glyph in the style of the EP-133 "FLOPPY!" screen icon (cut-outs are transparent). */
export const FloppyIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
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

/**
 * USB-C plug hanging from a cord, using the same form as the plug in Teenage Engineering's
 * EP sample tool (strain relief, boot with 45° side/bottom bevels, USB-C tip). The plug drops
 * into the port drawn at the bottom of the card on hover and while connecting.
 */
const UsbPlug: React.FC<{ plugged: boolean; dim: boolean; pageColor: string; cordColor: string }> = ({
  plugged,
  dim,
  pageColor,
  cordColor
}) => {
  const contact = '#dbdddb';
  const stroke = { stroke: EDGE, strokeWidth: 0.9, vectorEffect: 'non-scaling-stroke' as const, strokeMiterlimit: 10 };
  return (
    <svg
      viewBox="207 22 26 63"
      className="h-full w-auto shrink-0 overflow-hidden"
      aria-hidden="true"
      opacity={dim ? 0.45 : 1}
    >
      {/* Port on the mic, at the bottom edge of the card */}
      <rect x="214.9" y="80.4" width="10.3" height="4.6" rx="2.3" fill={EDGE} />
      <g
        className="transition-transform duration-300 ease-out"
        style={{ transform: plugged ? 'translateY(4.4px)' : 'translateY(0px)' }}
      >
        {/* Cord, running up past the top of the card */}
        <line x1="220.062" y1="51.312" x2="220.062" y2="-40" stroke={cordColor} strokeWidth="3.75" />
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
    </svg>
  );
};

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
  }, [isConnected]);

  // Light face for the disconnected card (matches the TOOL block), dark face for EJECT.
  const lightFace = isTing ? '#e8e9e4' : '#e5e6e6';
  const lightFaceHover = isTing ? '#f3f3ef' : '#f2f3f3';
  const lightBevel = isTing ? '#dbd0b9' : '#d8dad9';
  const darkFace = isTing ? '#00503a' : '#141617';
  const darkFaceHover = isTing ? '#006348' : '#272a2c';
  const darkBevel = isTing ? '#003828' : '#000000';
  const ink = isTing ? '#00503a' : '#141617';
  const pageColor = isTing ? '#dbd0b9' : '#abb5ba';

  const handleSave = async () => {
    if (saveState === 'saving') return;
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

  const ring = (pos: string, cls: string) => (
    <span className={`w-[11px] h-[11px] rounded-full border absolute ${pos} pointer-events-none ${cls}`} />
  );

  const half = BLOCK_W / 2;
  const W = BLOCK_W;
  const H = BLOCK_H;

  return (
    <div className="relative pr-[5px] pb-[5px]" data-testid="device-connector">
      {/* 45° axonometric bevels (bottom & right), colour-matched to the faces above them */}
      <svg
        className="absolute inset-0 pointer-events-none"
        style={{ width: W + 5, height: H + 5 }}
        viewBox={`0 0 ${W + 5} ${H + 5}`}
        fill="none"
      >
        {isConnected ? (
          <>
            <polygon points={`0.5,${H - 0.5} ${half},${H - 0.5} ${half + 5},${H + 4.5} 5.5,${H + 4.5}`} fill="#c94a1b" stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
            <polygon points={`${half},${H - 0.5} ${W - 0.5},${H - 0.5} ${W + 4.5},${H + 4.5} ${half + 5},${H + 4.5}`} fill={darkBevel} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
            <polygon points={`${W - 0.5},0.5 ${W + 4.5},5.5 ${W + 4.5},${H + 4.5} ${W - 0.5},${H - 0.5}`} fill={darkBevel} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <polygon points={`0.5,${H - 0.5} ${W - 0.5},${H - 0.5} ${W + 4.5},${H + 4.5} 5.5,${H + 4.5}`} fill={lightBevel} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
            <polygon points={`${W - 0.5},0.5 ${W + 4.5},5.5 ${W + 4.5},${H + 4.5} ${W - 0.5},${H - 0.5}`} fill={lightBevel} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
          </>
        )}
      </svg>

      <div className="relative z-10 border border-[#141617] flex" style={{ width: W, height: H }}>
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
            className="group w-full h-full relative flex items-stretch gap-3 pl-3 pr-3 overflow-hidden transition-colors cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f15a22] focus-visible:ring-inset"
            style={{ backgroundColor: hovered && isSupported && !isConnecting ? lightFaceHover : lightFace }}
          >
            <UsbPlug
              plugged={(hovered && isSupported) || isConnecting}
              dim={!isSupported}
              pageColor={pageColor}
              cordColor={ink}
            />
            <span className="flex flex-col justify-center items-start gap-[4px] min-w-0">
              <span
                className="font-te-regular text-[13px] tracking-wider uppercase leading-none whitespace-nowrap"
                style={{ color: ink }}
              >
                {isConnecting ? 'connecting' : 'connect'}
              </span>
              <span
                className="font-te-regular text-[13px] tracking-wider uppercase leading-none whitespace-nowrap"
                style={{ color: ink }}
              >
                {isConnecting ? 'the mic…' : 'the mic'}
              </span>
              {!isSupported && (
                <span className="font-mono text-[7.5px] tracking-wider uppercase leading-none text-[#73787a] whitespace-nowrap mt-[2px]">
                  needs chrome / edge
                </span>
              )}
            </span>
            {/* Call-to-action dot: pulses to invite a click */}
            {isSupported && (
              <span className="absolute top-[7px] right-[7px] w-[11px] h-[11px]">
                <span
                  className={`absolute inset-0 rounded-full bg-[#f15a22] ${
                    isConnecting ? 'animate-ping' : 'motion-safe:animate-pulse group-hover:animate-none'
                  }`}
                />
                <span className="absolute inset-0 rounded-full border border-[#141617] bg-[#f15a22]" />
              </span>
            )}
          </button>
        ) : (
          <div className="w-full h-full grid grid-cols-2" role="group" aria-label="Connected mic actions">
            <button
              type="button"
              onClick={handleSave}
              disabled={saveState === 'saving'}
              aria-label="Save to the mic"
              title={
                saveState === 'saved'
                  ? 'Saved to the mic'
                  : hasUnsavedChanges
                  ? 'Save to the mic: unsaved changes (writes config.json and reloads the active preset)'
                  : 'Save to the mic (writes config.json and reloads the active preset)'
              }
              className="relative flex items-center justify-center border-r border-[#141617] bg-[#f15a22] hover:bg-[#ff6b35] cursor-pointer transition-colors disabled:cursor-wait focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset"
            >
              {ring('top-[7px] left-[7px]', 'border-[#141617]/55')}
              {hasUnsavedChanges && saveState === 'idle' && (
                <span
                  className="w-[11px] h-[11px] rounded-full border border-[#141617] bg-white absolute top-[7px] right-[7px]"
                  data-testid="unsaved-indicator"
                />
              )}
              {saveState === 'saved' ? (
                <Check className="w-[26px] h-[26px] text-white" strokeWidth={3} data-testid="saved-indicator" />
              ) : (
                <FloppyIcon className={`w-[26px] h-[26px] text-white ${saveState === 'saving' ? 'animate-pulse' : ''}`} />
              )}
            </button>
            <button
              type="button"
              onClick={onEject}
              aria-label="Eject the mic"
              title="Eject: disconnect from the mic. Also eject the TINGDISK drive in your OS before unplugging."
              className="group relative flex items-center justify-center cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f15a22] focus-visible:ring-inset"
              style={{ backgroundColor: darkFace }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = darkFaceHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = darkFace)}
            >
              {ring('top-[7px] right-[7px]', 'border-white/40')}
              <EjectIcon className="w-[24px] h-[24px] text-white group-hover:text-[#f15a22] transition-colors" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
