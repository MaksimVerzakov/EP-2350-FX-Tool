import React, { useRef, useState, useEffect } from 'react';
import { Download, Upload, ChevronDown, Check, Plus, Usb } from 'lucide-react';
import { OFFICIAL_TE_PACKS, OfficialPackPreset } from '../constants/defaultPresets';
import { ThemeMode } from '../types/config';
import { bottomBevelPoints, rightBevelPoints, useBlockWidth } from './useBlockWidth';
import { themeColor } from '../theme/tokens';

interface TopBannerProps {
  packName: string;
  onUpdatePackName: (name: string) => void;
  onSelectDefaultPack: (presetPack: OfficialPackPreset) => void;
  onCreateNewPack: () => void;
  onImportJson: (json: string) => void;
  onExportJson: () => void;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
  isDeviceConnected?: boolean;
  isDevicePack?: boolean;
  devicePackName?: string;
  onSelectDevicePack?: () => void;
  /** Device connector block rendered to the left of the Export/Import block. */
  deviceConnector?: React.ReactNode;
}

export const TopBanner: React.FC<TopBannerProps> = ({
  packName,
  onUpdatePackName,
  onSelectDefaultPack,
  onCreateNewPack,
  onImportJson,
  onExportJson,
  theme,
  onChangeTheme,
  isDeviceConnected = false,
  isDevicePack = false,
  devicePackName,
  onSelectDevicePack,
  deviceConnector
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const isTing = theme === 'ting';
  const [logoRef, logoW] = useBlockWidth<HTMLDivElement>();
  const [packRef, packW] = useBlockWidth<HTMLDivElement>();

  // Close pack dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [dropdownOpen]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) onImportJson(content);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="w-full flex flex-col md:flex-row items-stretch sm:items-center md:items-start justify-between gap-0 sm:gap-4 pb-3 md:pb-0 md:h-[100px] select-none transition-colors">
      {/* 1. Iconic TE Modular Badge with Integrated [TING] [FX] Theme Switcher */}
      <div className="w-full sm:w-auto flex flex-col items-start">
        <div ref={logoRef} className="w-full sm:w-auto relative -left-[5px] -top-[5px] pr-[5px] pb-[5px]">
          {/* 45° Axonometric Extruded 3D Bevels (Bottom & Right) */}
          <svg
            className="absolute inset-0 pointer-events-none"
            style={{ width: logoW + 5, height: 81 }}
            viewBox={`0 0 ${logoW + 5} 81`}
            fill="none"
          >
            {/* Bottom bevel under [EP] */}
            <polygon
              points={bottomBevelPoints(0, 100)}
              fill="#f15a22"
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Bottom bevel under [TOOL] */}
            <polygon
              points={bottomBevelPoints(100, logoW - 1)}
              fill={themeColor('bevel', isTing)}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside [FX] */}
            <polygon
              points={rightBevelPoints(logoW, 0, 25)}
              fill="#000000"
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside [TOOL] */}
            <polygon
              points={rightBevelPoints(logoW, 25, 75)}
              fill={themeColor('bevel', isTing)}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
          </svg>

          {/* Front Modular Blocks: 10 x 3 grid cells of 25px (251px x 76px, borders on the grid lines) */}
          <div className="relative z-10 flex w-full sm:w-[251px] h-[76px] border border-te-edge">
            {/* Left [EP] Block (4 cells wide, 2 rows tall) */}
            <div className="w-[100px] h-full flex items-center justify-center relative border-r border-te-edge bg-te-accent">
              {/* 4 Corner Modular Circles */}
              <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute top-[7px] left-[7px]" />
              <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute top-[7px] right-[7px]" />
              <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute bottom-[7px] left-[7px]" />
              <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute bottom-[7px] right-[7px]" />

              <span className="font-te-regular text-[44px] leading-none tracking-tight text-[#e5e6e6] [-webkit-text-stroke:0.8px_#141617] translate-y-[1px]">
                EP
              </span>
            </div>

            {/* Right 2-Row Stack: Top = [TING][FX], Bottom = [TOOL] */}
            <div className="flex-1 min-w-0 h-full flex flex-col">
              {/* Row 1: [TING] and [FX] Theme Picker Blocks */}
              <div
                className="h-[25px] grid grid-cols-2 sm:grid-cols-[75px_1fr] border-b border-te-edge"
                role="group"
                aria-label="Theme selector"
              >
                {/* [TING] Block (Green) */}
                <button
                  type="button"
                  onClick={() => onChangeTheme('ting')}
                  className="bg-[#00503a] hover:bg-[#006348] border-r border-te-edge relative flex items-center justify-center cursor-pointer transition-colors group focus:outline-none"
                  title="Switch to TING theme (Original EP–2350)"
                  aria-pressed={isTing}
                >
                  <span
                    className={`w-[11px] h-[11px] rounded-full border absolute left-[7px] top-[6px] transition-all shrink-0 ${
                      isTing
                        ? 'bg-te-accent border-te-edge'
                        : 'border-white/40 group-hover:border-white/70'
                    }`}
                  />
                  <span
                    className={`font-te-medium text-te-sm tracking-wider uppercase leading-none pl-3.5 transition-colors ${
                      isTing ? 'text-white' : 'text-white/75 group-hover:text-white'
                    }`}
                  >
                    TING
                  </span>
                </button>

                {/* [FX] Block (Black) */}
                <button
                  type="button"
                  onClick={() => onChangeTheme('fx')}
                  className="bg-te-edge hover:bg-[#272a2c] relative flex items-center justify-center cursor-pointer transition-colors group focus:outline-none"
                  title="Switch to FX theme (EP–2350 FX)"
                  aria-pressed={!isTing}
                >
                  <span
                    className={`font-te-medium text-te-sm tracking-wider uppercase leading-none pr-3.5 transition-colors ${
                      !isTing ? 'text-white' : 'text-white/75 group-hover:text-white'
                    }`}
                  >
                    FX
                  </span>
                  <span
                    className={`w-[11px] h-[11px] rounded-full border absolute right-[7px] top-[6px] transition-all shrink-0 ${
                      !isTing
                        ? 'bg-te-accent border-te-edge'
                        : 'border-white/40 group-hover:border-white/70'
                    }`}
                  />
                </button>
              </div>

              {/* Row 2: [TOOL] Block */}
              <div
                className={`flex-1 flex items-center justify-center relative transition-colors ${
                  'bg-te-face'
                }`}
              >
                {/* 4 Corner Modular Circles */}
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] left-[7px] ${
                    'border-te-ink/40'
                  }`}
                />
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] right-[7px] ${
                    'border-te-ink/40'
                  }`}
                />
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] left-[7px] ${
                    'border-te-ink/40'
                  }`}
                />
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] right-[7px] ${
                    'border-te-ink/40'
                  }`}
                />

                <span
                  className={`font-te-regular text-te-md tracking-wider uppercase leading-none ${
                    'text-te-ink'
                  }`}
                >
                  TOOL
                </span>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* 2. Right group: Device Connector block + Export/Import block. On phones Export/Import comes first and the
          connector last, joined to the blocks above; DOM order is phone order so each lower block paints over the
          bottom bevel of the one above it. From sm up the connector sits on the left. */}
      <div className="w-full sm:w-auto mt-[19px] sm:mt-0 flex flex-col sm:flex-row items-stretch sm:items-start gap-0 sm:gap-[19px]">

      {/* Right Modular Block (Same 10 x 3 cell size & 3D format as Left Block: Row 1 = [EXPORT][IMPORT], Row 2 = Pack Dropdown) */}
      <div ref={dropdownRef} className="w-full sm:w-auto sm:order-2 flex flex-col items-start relative">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileChange}
          className="hidden"
        />

        <div ref={packRef} className="w-full sm:w-auto relative -left-[5px] -top-[5px] pr-[5px] pb-[5px]">
          {/* 45° Axonometric Extruded 3D Bevels (Bottom & Right) matching Left Block */}
          <svg
            className="absolute inset-0 pointer-events-none"
            style={{ width: packW + 5, height: 81 }}
            viewBox={`0 0 ${packW + 5} 81`}
            fill="none"
          >
            {/* Bottom bevel under Pack Dropdown Row */}
            <polygon
              points={bottomBevelPoints(0, packW - 1)}
              fill={themeColor('bevel', isTing)}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside [IMPORT] */}
            <polygon
              points={rightBevelPoints(packW, 0, 25)}
              fill={themeColor('ink-deep', isTing)}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside Pack Dropdown Row */}
            <polygon
              points={rightBevelPoints(packW, 25, 75)}
              fill={themeColor('bevel', isTing)}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
          </svg>

          {/* Front Modular Blocks (251px x 76px — identical dimensions to Left Block) */}
          <div className="relative z-10 flex flex-col w-full sm:w-[251px] h-[76px] border border-te-edge">
            {/* Row 1: Two Buttons on Top — [EXPORT] and [IMPORT] */}
            <div
              className="h-[25px] grid grid-cols-2 sm:grid-cols-[125px_1fr] border-b border-te-edge"
              role="group"
              aria-label="Export and Import actions"
            >
              {/* [EXPORT] Button */}
              <button
                type="button"
                onClick={onExportJson}
                className="bg-te-accent hover:bg-te-accent-hover border-r border-te-edge relative flex items-center justify-center gap-1 cursor-pointer transition-colors group focus:outline-none"
                title="Export valid config.json to TINGDISK"
              >
                <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute left-[7px] top-[6px] shrink-0" />
                <Download className="w-2.5 h-2.5 text-white shrink-0 ml-2.5" />
                <span className="font-te-medium text-te-sm tracking-wider uppercase leading-none text-white">
                  EXPORT
                </span>
              </button>

              {/* [IMPORT] Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`${
                  'bg-te-ink hover:bg-te-ink-hover'
                } relative flex items-center justify-center gap-1 cursor-pointer transition-colors group focus:outline-none`}
                title="Import config.json from TINGDISK"
              >
                <Upload className="w-2.5 h-2.5 text-white shrink-0 mr-0.5" />
                <span className="font-te-medium text-te-sm tracking-wider uppercase leading-none text-white pr-2.5">
                  IMPORT
                </span>
                <span className="w-[11px] h-[11px] rounded-full border border-white/40 group-hover:border-white/70 absolute right-[7px] top-[6px] shrink-0" />
              </button>
            </div>

            {/* Row 2: One Dropdown Below — Pack Selector / Name */}
            <div
              className={`flex-1 flex items-center justify-between px-[24px] relative transition-colors ${
                'bg-te-face'
              }`}
            >
              {/* 4 Corner Modular Circles matching [TOOL] Block */}
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] left-[7px] pointer-events-none ${
                  'border-te-ink/40'
                }`}
              />
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] right-[7px] pointer-events-none ${
                  'border-te-ink/40'
                }`}
              />
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] left-[7px] pointer-events-none ${
                  'border-te-ink/40'
                }`}
              />
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] right-[7px] pointer-events-none ${
                  'border-te-ink/40'
                }`}
              />

              {/* Pack Name Input + Dropdown Trigger */}
              <div
                className={`w-full h-[24px] flex items-stretch border ${
                  'bg-te-ink border-te-ink-deep'
                }`}
              >
                {isDevicePack && (
                  <span
                    className="pl-1.5 flex items-center justify-center text-te-accent shrink-0"
                    title="Connected EP-2350 Device Pack"
                    aria-label="Connected device pack"
                    data-testid="connected-device-icon"
                  >
                    <Usb className="w-3 h-3" />
                  </span>
                )}
                <input
                  type="text"
                  value={packName}
                  onChange={(e) => onUpdatePackName(e.target.value.toUpperCase())}
                  className="text-white px-2 font-mono text-te-sm font-bold tracking-wider uppercase border-0 focus:outline-none focus:ring-1 flex-1 min-w-0 bg-transparent focus:ring-te-accent"
                  placeholder="PACK NAME"
                  maxLength={24}
                />
                <button
                  type="button"
                  onClick={() => setDropdownOpen((prev) => !prev)}
                  className={`px-1.5 text-white border-l border-white/20 flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                    'bg-te-ink-raised hover:bg-te-accent'
                  }`}
                  title="Select an official Teenage Engineering preset pack"
                  aria-label="Select default pack"
                >
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform duration-150 ${
                      dropdownOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Official TE Packs Dropdown Menu */}
        {dropdownOpen && (
          <div
            className={`absolute right-[5px] top-[100px] w-[276px] border p-2 z-50 flex flex-col gap-1 ${
              'bg-te-surface border-te-ink'
            }`}
          >
            {isDeviceConnected && devicePackName && (
              <div
                className={`border-b pb-1 mb-0.5 flex flex-col gap-1 ${
                  'border-te-rule'
                }`}
              >
                <div className="flex items-center justify-between px-1">
                  <span className="font-mono text-te-xs font-bold uppercase tracking-wider text-te-accent flex items-center gap-1">
                    <Usb className="w-3 h-3 shrink-0" />
                    ON THE MIC
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onSelectDevicePack?.();
                    setDropdownOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded-[1px] transition-colors cursor-pointer flex flex-col gap-0.5 group ${
                    isDevicePack
                      ? 'bg-te-ink text-white'
                      : 'hover:bg-te-accent hover:text-white text-te-ink'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-te-sm font-bold uppercase tracking-wide flex items-center gap-1.5">
                      <Usb className="w-3 h-3 shrink-0 text-te-accent group-hover:text-white" />
                      {devicePackName}
                    </span>
                    {isDevicePack && (
                      <Check className="w-3 h-3 group-hover:text-white shrink-0 text-te-accent" />
                    )}
                  </div>
                  <span
                    className={`font-mono text-te-xs uppercase truncate ${
                      isDevicePack
                        ? 'text-white/70'
                        : 'text-te-muted group-hover:text-white/85'
                    }`}
                  >
                    LIVE HARDWARE PACK FROM EP-2350
                  </span>
                </button>
              </div>
            )}

            <div
              className={`flex items-center justify-between border-b pb-1 mb-0.5 px-1 ${
                'border-te-rule'
              }`}
            >
              <span className="font-mono text-te-xs font-bold uppercase tracking-wider text-te-accent">
                OFFICIAL TE PRESET PACKS
              </span>
              <span
                className={`font-mono text-te-xs ${
                  'text-te-muted'
                }`}
              >
                LOAD DEFAULTS
              </span>
            </div>

            {OFFICIAL_TE_PACKS.map((item) => {
              const isSelected = !isDevicePack && packName.trim().toUpperCase() === item.name.toUpperCase();
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectDefaultPack(item);
                    setDropdownOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded-[1px] transition-colors cursor-pointer flex flex-col gap-0.5 group ${
                    isSelected
                      ? 'bg-te-ink text-white'
                      : 'hover:bg-te-accent hover:text-white text-te-ink'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-te-sm font-bold uppercase tracking-wide">
                      {item.name}
                    </span>
                    {isSelected && (
                      <Check className="w-3 h-3 group-hover:text-white shrink-0 text-te-accent" />
                    )}
                  </div>
                  <span
                    className={`font-mono text-te-xs uppercase truncate ${
                      isSelected
                        ? 'text-white/70'
                        : 'text-te-muted group-hover:text-white/85'
                    }`}
                  >
                    {item.subtitle}
                  </span>
                </button>
              );
            })}

            <div
              className={`border-t mt-0.5 pt-1 flex flex-col gap-0.5 ${
                'border-te-rule'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  onCreateNewPack();
                  setDropdownOpen(false);
                }}
                className={`w-full text-left px-2 py-1.5 rounded-[1px] transition-colors cursor-pointer flex flex-col gap-0.5 group ${
                  'hover:bg-te-accent hover:text-white text-te-accent'
                }`}
              >
                <div className="flex items-center gap-1">
                  <Plus className="w-3 h-3 shrink-0" />
                  <span className="font-mono text-te-sm font-bold uppercase tracking-wide">
                    NEW PACK
                  </span>
                </div>
                <span
                  className={`font-mono text-te-xs uppercase truncate ${
                    'text-te-muted group-hover:text-white/85'
                  }`}
                >
                  START AN EMPTY 4-PRESET PACK
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="w-full sm:w-auto mt-[19px] sm:mt-0 sm:order-1">{deviceConnector}</div>
      </div>
    </div>
  );
};
