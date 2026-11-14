import React, { useEffect, useRef, useState } from 'react';
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

/** Horizontal USB-C cable whose plug slides into the mic's port on hover / while connecting. */
const UsbCable: React.FC<{ plugged: boolean; dim: boolean }> = ({ plugged, dim }) => (
  <svg viewBox="0 0 96 40" className="w-[96px] h-[40px] shrink-0 overflow-visible" aria-hidden="true">
    {/* Mic-side port (fixed) */}
    <g opacity={dim ? 0.5 : 1}>
      <rect x="80.5" y="10.5" width="14" height="19" fill="#e5e6e6" stroke={EDGE} strokeWidth="0.9" />
      <rect x="83.5" y="16.5" width="8" height="7" rx="3.5" fill={EDGE} />
    </g>
    {/* Cable + plug (slides right when plugged) */}
    <g
      className="transition-transform duration-300 ease-out"
      style={{ transform: plugged ? 'translateX(7px)' : 'translateX(0px)' }}
      opacity={dim ? 0.5 : 1}
    >
      {/* Cable running in from the left edge */}
      <path d="M-14 20H34" stroke="#e5e6e6" strokeWidth="5" strokeLinecap="square" />
      {/* Strain relief */}
      <polygon points="30.5,16.5 38.5,14.5 38.5,25.5 30.5,23.5" fill="#d8dad9" stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
      {/* Boot with 45° bevel (bottom/right) */}
      <polygon points="38.5,12.5 62.5,12.5 65.5,15.5 65.5,30.5 41.5,30.5 38.5,27.5" fill="#000" stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
      <rect x="38.5" y="12.5" width="24" height="15" fill="#f15a22" stroke={EDGE} strokeWidth="0.9" />
      <circle cx="45" cy="20" r="2.4" fill="none" stroke={EDGE} strokeOpacity="0.55" strokeWidth="0.8" />
      {/* USB-C shell + contact tongue */}
      <rect x="62.5" y="15.5" width="15" height="9" rx="4.5" fill="#c9cccb" stroke={EDGE} strokeWidth="0.9" />
      <rect x="66" y="19" width="8" height="2" rx="1" fill={EDGE} />
    </g>
  </svg>
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
  }, [isConnected]);

  const darkFace = isTing ? '#00503a' : '#141617';
  const darkFaceHover = isTing ? '#006348' : '#272a2c';
  const darkBevel = isTing ? '#003828' : '#000000';

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

  const cornerRing = (pos: string, light: boolean) => (
    <span
      className={`w-[11px] h-[11px] rounded-full border absolute ${pos} pointer-events-none ${
        light ? 'border-white/40' : 'border-[#141617]/55'
      }`}
    />
  );

  return (
    <div className="relative pr-[5px] pb-[5px]" data-testid="device-connector">
      {/* 45° axonometric bevels (bottom & right), colour-matched to the faces above them */}
      <svg className="absolute inset-0 w-[241px] h-[71px] pointer-events-none" viewBox="0 0 241 71" fill="none">
        {isConnected ? (
          <>
            <polygon points="0.5,65.5 118,65.5 123,70.5 5.5,70.5" fill="#c94a1b" stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
            <polygon points="118,65.5 235.5,65.5 240.5,70.5 123,70.5" fill={darkBevel} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
          </>
        ) : (
          <polygon points="0.5,65.5 235.5,65.5 240.5,70.5 5.5,70.5" fill={darkBevel} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
        )}
        <polygon points="235.5,0.5 240.5,5.5 240.5,70.5 235.5,65.5" fill={darkBevel} stroke={EDGE} strokeWidth="0.9" strokeLinejoin="round" />
      </svg>

      <div className="relative z-10 w-[236px] h-[66px] border border-[#141617] flex">
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
            className="group w-full h-full relative flex items-center gap-2 pl-1 pr-3 overflow-hidden transition-colors cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f15a22] focus-visible:ring-inset"
            style={{ backgroundColor: hovered && isSupported && !isConnecting ? darkFaceHover : darkFace }}
          >
            <UsbCable plugged={(hovered && isSupported) || isConnecting} dim={!isSupported} />
            <span className="flex flex-col items-start gap-[5px] min-w-0 flex-1">
              <span className="font-te-regular text-[13px] tracking-wider uppercase leading-none text-white whitespace-nowrap">
                {isConnecting ? 'connecting…' : 'connect the mic'}
              </span>
              <span className="font-mono text-[8px] tracking-wider uppercase leading-none text-white/60 whitespace-nowrap">
                {isSupported ? (isConnecting ? 'pick the ep-2350 port' : 'click · usb-c') : 'needs chrome / edge'}
              </span>
            </span>
            {/* Call-to-action dot: pulses to invite a click */}
            {isSupported && (
              <span className="relative w-[11px] h-[11px] shrink-0 self-start mt-[7px]">
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
              title="Write this pack to the mic (config.json) and reload the active preset"
              className="relative flex flex-col items-center justify-center gap-[6px] border-r border-[#141617] bg-[#f15a22] hover:bg-[#ff6b35] cursor-pointer transition-colors disabled:cursor-wait focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset"
            >
              {cornerRing('top-[7px] left-[7px]', false)}
              {hasUnsavedChanges && saveState === 'idle' && (
                <span
                  className="w-[11px] h-[11px] rounded-full border border-[#141617] bg-white absolute top-[7px] right-[7px]"
                  title="Unsaved changes"
                  data-testid="unsaved-indicator"
                />
              )}
              <FloppyIcon className={`w-[20px] h-[20px] text-white ${saveState === 'saving' ? 'animate-pulse' : ''}`} />
              <span className="font-te-regular text-[10px] tracking-wider uppercase leading-none text-white font-bold">
                {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : 'save'}
              </span>
            </button>
            <button
              type="button"
              onClick={onEject}
              aria-label="Eject the mic"
              title="Disconnect from the mic. Also eject the TINGDISK drive in your OS before unplugging."
              className="group relative flex flex-col items-center justify-center gap-[6px] cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f15a22] focus-visible:ring-inset"
              style={{ backgroundColor: darkFace }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = darkFaceHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = darkFace)}
            >
              {cornerRing('top-[7px] right-[7px]', true)}
              <EjectIcon className="w-[20px] h-[20px] text-white group-hover:text-[#f15a22] transition-colors" />
              <span className="font-te-regular text-[10px] tracking-wider uppercase leading-none text-white font-bold">
                eject
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
