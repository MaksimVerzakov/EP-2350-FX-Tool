import React, { useRef, useState, useEffect } from 'react';
import { Download, Upload, ChevronDown, Check } from 'lucide-react';
import { OFFICIAL_TE_PACKS, OfficialPackPreset } from '../constants/defaultPresets';
import { ThemeMode } from '../types/config';

interface TopBannerProps {
  packName: string;
  onUpdatePackName: (name: string) => void;
  onSelectDefaultPack: (presetPack: OfficialPackPreset) => void;
  onImportJson: (json: string) => void;
  onExportJson: () => void;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
}

export const TopBanner: React.FC<TopBannerProps> = ({
  packName,
  onUpdatePackName,
  onSelectDefaultPack,
  onImportJson,
  onExportJson,
  theme,
  onChangeTheme
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const isTing = theme === 'ting';

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
    <div
      className={`w-full flex flex-col md:flex-row items-center md:items-start justify-between gap-4 py-2 border-b pb-3 select-none transition-colors ${
        isTing ? 'border-[#00503a]/30' : 'border-[#dfe2e0]'
      }`}
    >
      {/* 1. Iconic TE Modular Badge with Integrated [TING] [FX] Theme Switcher */}
      <div className="flex flex-col items-start">
        <div className="relative pr-[5px] pb-[5px]">
          {/* 45° Axonometric Extruded 3D Bevels (Bottom & Right) */}
          <svg
            className="absolute inset-0 w-[241px] h-[71px] pointer-events-none"
            viewBox="0 0 241 71"
            fill="none"
          >
            {/* Bottom bevel under [EP] */}
            <polygon
              points="0.5,65.5 116,65.5 121,70.5 5.5,70.5"
              fill="#f15a22"
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Bottom bevel under [TOOL] */}
            <polygon
              points="116,65.5 235.5,65.5 240.5,70.5 121,70.5"
              fill={isTing ? '#dbd0b9' : '#d8dad9'}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside [FX] */}
            <polygon
              points="235.5,0.5 240.5,5.5 240.5,29 235.5,24"
              fill="#000000"
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside [TOOL] */}
            <polygon
              points="235.5,24 240.5,29 240.5,70.5 235.5,65.5"
              fill={isTing ? '#dbd0b9' : '#d8dad9'}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
          </svg>

          {/* Front Modular Blocks (236px x 66px) */}
          <div className="relative z-10 flex w-[236px] h-[66px] border border-[#141617]">
            {/* Left [EP] Block (2 rows tall) */}
            <div className="w-[116px] h-full flex items-center justify-center relative border-r border-[#141617] bg-[#f15a22]">
              {/* 4 Corner Modular Circles */}
              <span className="w-[11px] h-[11px] rounded-full border border-[#141617]/55 absolute top-[7px] left-[7px]" />
              <span className="w-[11px] h-[11px] rounded-full border border-[#141617]/55 absolute top-[7px] right-[7px]" />
              <span className="w-[11px] h-[11px] rounded-full border border-[#141617]/55 absolute bottom-[7px] left-[7px]" />
              <span className="w-[11px] h-[11px] rounded-full border border-[#141617]/55 absolute bottom-[7px] right-[7px]" />

              <span className="font-te-regular text-[44px] leading-none tracking-tight text-[#e5e6e6] [-webkit-text-stroke:0.8px_#141617] translate-y-[1px]">
                EP
              </span>
            </div>

            {/* Right 2-Row Stack: Top = [TING][FX], Bottom = [TOOL] */}
            <div className="w-[120px] h-full flex flex-col">
              {/* Row 1: [TING] and [FX] Theme Picker Blocks */}
              <div
                className="h-[24px] grid grid-cols-2 border-b border-[#141617]"
                role="group"
                aria-label="Theme selector"
              >
                {/* [TING] Block (Green) */}
                <button
                  type="button"
                  onClick={() => onChangeTheme('ting')}
                  className="bg-[#00503a] hover:bg-[#006348] border-r border-[#141617] relative flex items-center justify-center cursor-pointer transition-colors group focus:outline-none"
                  title="Switch to TING theme (Original EP–2350)"
                  aria-pressed={isTing}
                >
                  <span
                    className={`w-[11px] h-[11px] rounded-full border absolute left-[7px] top-[7px] transition-all shrink-0 ${
                      isTing
                        ? 'bg-[#f15a22] border-[#141617]'
                        : 'border-white/40 group-hover:border-white/70'
                    }`}
                  />
                  <span
                    className={`font-te-regular text-[10px] tracking-wider uppercase leading-none pl-3.5 transition-colors ${
                      isTing ? 'text-white font-bold' : 'text-white/75 group-hover:text-white'
                    }`}
                  >
                    TING
                  </span>
                </button>

                {/* [FX] Block (Black) */}
                <button
                  type="button"
                  onClick={() => onChangeTheme('fx')}
                  className="bg-[#141617] hover:bg-[#272a2c] relative flex items-center justify-center cursor-pointer transition-colors group focus:outline-none"
                  title="Switch to FX theme (EP–2350 FX)"
                  aria-pressed={!isTing}
                >
                  <span
                    className={`font-te-regular text-[10px] tracking-wider uppercase leading-none pr-3.5 transition-colors ${
                      !isTing ? 'text-white font-bold' : 'text-white/75 group-hover:text-white'
                    }`}
                  >
                    FX
                  </span>
                  <span
                    className={`w-[11px] h-[11px] rounded-full border absolute right-[7px] top-[7px] transition-all shrink-0 ${
                      !isTing
                        ? 'bg-[#f15a22] border-[#141617]'
                        : 'border-white/40 group-hover:border-white/70'
                    }`}
                  />
                </button>
              </div>

              {/* Row 2: [TOOL] Block */}
              <div
                className={`flex-1 flex items-center justify-center relative transition-colors ${
                  isTing ? 'bg-[#e8e9e4]' : 'bg-[#e5e6e6]'
                }`}
              >
                {/* 4 Corner Modular Circles */}
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] left-[7px] ${
                    isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                  }`}
                />
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] right-[7px] ${
                    isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                  }`}
                />
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] left-[7px] ${
                    isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                  }`}
                />
                <span
                  className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] right-[7px] ${
                    isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                  }`}
                />

                <span
                  className={`font-te-regular text-[13px] tracking-wider uppercase leading-none ${
                    isTing ? 'text-[#00503a]' : 'text-[#141617]'
                  }`}
                >
                  TOOL
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Version Number Below [EP] Block */}
        <span
          className={`w-[116px] text-center mt-1 text-[10px] font-mono leading-none uppercase tracking-wider ${
            isTing ? 'text-[#00503a]' : 'text-[#141617]'
          }`}
        >
          V {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0'}
        </span>
      </div>

      {/* 2. Right Modular Block (Same 236x66 size & 3D format as Left Block: Row 1 = [EXPORT][IMPORT], Row 2 = Pack Dropdown) */}
      <div ref={dropdownRef} className="flex flex-col items-start relative">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="relative pr-[5px] pb-[5px]">
          {/* 45° Axonometric Extruded 3D Bevels (Bottom & Right) matching Left Block */}
          <svg
            className="absolute inset-0 w-[241px] h-[71px] pointer-events-none"
            viewBox="0 0 241 71"
            fill="none"
          >
            {/* Bottom bevel under Pack Dropdown Row */}
            <polygon
              points="0.5,65.5 235.5,65.5 240.5,70.5 5.5,70.5"
              fill={isTing ? '#dbd0b9' : '#d8dad9'}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside [IMPORT] */}
            <polygon
              points="235.5,0.5 240.5,5.5 240.5,29 235.5,24"
              fill={isTing ? '#003828' : '#000000'}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            {/* Right bevel beside Pack Dropdown Row */}
            <polygon
              points="235.5,24 240.5,29 240.5,70.5 235.5,65.5"
              fill={isTing ? '#dbd0b9' : '#d8dad9'}
              stroke="#141617"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
          </svg>

          {/* Front Modular Blocks (236px x 66px — identical dimensions to Left Block) */}
          <div className="relative z-10 flex flex-col w-[236px] h-[66px] border border-[#141617]">
            {/* Row 1: Two Buttons on Top — [EXPORT] and [IMPORT] */}
            <div
              className="h-[24px] grid grid-cols-2 border-b border-[#141617]"
              role="group"
              aria-label="Export and Import actions"
            >
              {/* [EXPORT] Button */}
              <button
                type="button"
                onClick={onExportJson}
                className="bg-[#f15a22] hover:bg-[#ff6b35] border-r border-[#141617] relative flex items-center justify-center gap-1 cursor-pointer transition-colors group focus:outline-none"
                title="Export valid config.json to TINGDISK"
              >
                <span className="w-[11px] h-[11px] rounded-full border border-[#141617]/55 absolute left-[7px] top-[7px] shrink-0" />
                <Download className="w-2.5 h-2.5 text-white shrink-0 ml-2.5" />
                <span className="font-te-regular text-[10px] tracking-wider uppercase leading-none text-white font-bold">
                  EXPORT
                </span>
              </button>

              {/* [IMPORT] Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`${
                  isTing ? 'bg-[#00503a] hover:bg-[#006348]' : 'bg-[#141617] hover:bg-[#272a2c]'
                } relative flex items-center justify-center gap-1 cursor-pointer transition-colors group focus:outline-none`}
                title="Import config.json from TINGDISK"
              >
                <Upload className="w-2.5 h-2.5 text-white shrink-0 mr-0.5" />
                <span className="font-te-regular text-[10px] tracking-wider uppercase leading-none text-white font-bold pr-2.5">
                  IMPORT
                </span>
                <span className="w-[11px] h-[11px] rounded-full border border-white/40 group-hover:border-white/70 absolute right-[7px] top-[7px] shrink-0" />
              </button>
            </div>

            {/* Row 2: One Dropdown Below — Pack Selector / Name */}
            <div
              className={`flex-1 flex items-center justify-between px-[22px] relative transition-colors ${
                isTing ? 'bg-[#e8e9e4]' : 'bg-[#e5e6e6]'
              }`}
            >
              {/* 4 Corner Modular Circles matching [TOOL] Block */}
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] left-[7px] pointer-events-none ${
                  isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                }`}
              />
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] right-[7px] pointer-events-none ${
                  isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                }`}
              />
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] left-[7px] pointer-events-none ${
                  isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                }`}
              />
              <span
                className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] right-[7px] pointer-events-none ${
                  isTing ? 'border-[#00503a]/40' : 'border-[#141617]/40'
                }`}
              />

              {/* Pack Name Input + Dropdown Trigger */}
              <div
                className={`w-full h-[24px] flex items-stretch border ${
                  isTing ? 'bg-[#00503a] border-[#003828]' : 'bg-[#141617] border-[#141617]'
                }`}
              >
                <input
                  type="text"
                  value={packName}
                  onChange={(e) => onUpdatePackName(e.target.value.toUpperCase())}
                  className="text-white px-2 font-mono text-[10px] font-bold tracking-wider uppercase border-0 focus:outline-none focus:ring-1 flex-1 min-w-0 bg-transparent focus:ring-[#f15a22]"
                  placeholder="PACK NAME"
                  maxLength={24}
                />
                <button
                  type="button"
                  onClick={() => setDropdownOpen((prev) => !prev)}
                  className={`px-1.5 text-white border-l border-white/20 flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                    isTing
                      ? 'bg-[#003d2c] hover:bg-[#f15a22]'
                      : 'bg-[#232628] hover:bg-[#f15a22]'
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
            className={`absolute right-0 top-[74px] w-72 border p-2 z-50 flex flex-col gap-1 ${
              isTing
                ? 'bg-[#f7f5ef] border-[#00503a] shadow-[4px_4px_0px_#003828]'
                : 'bg-white border-[#141617] shadow-[4px_4px_0px_#141617]'
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-1 mb-0.5 px-1 ${
                isTing ? 'border-[#00503a]/20' : 'border-[#e2e4e2]'
              }`}
            >
              <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[#f15a22]">
                OFFICIAL TE PRESET PACKS
              </span>
              <span
                className={`font-mono text-[8px] ${
                  isTing ? 'text-[#4b6b5d]' : 'text-[#73787a]'
                }`}
              >
                LOAD DEFAULTS
              </span>
            </div>

            {OFFICIAL_TE_PACKS.map((item) => {
              const isSelected = packName.trim().toUpperCase() === item.name.toUpperCase();
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
                      ? isTing
                        ? 'bg-[#00503a] text-white'
                        : 'bg-[#141617] text-white'
                      : isTing
                      ? 'hover:bg-[#f15a22] hover:text-white text-[#00503a]'
                      : 'hover:bg-[#f15a22] hover:text-white text-[#141617]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10.5px] font-bold uppercase tracking-wide">
                      {item.name}
                    </span>
                    {isSelected && (
                      <Check className="w-3 h-3 group-hover:text-white shrink-0 text-[#f15a22]" />
                    )}
                  </div>
                  <span
                    className={`font-mono text-[8px] uppercase truncate ${
                      isSelected
                        ? 'text-white/70'
                        : isTing
                        ? 'text-[#4b6b5d] group-hover:text-white/85'
                        : 'text-[#73787a] group-hover:text-white/85'
                    }`}
                  >
                    {item.subtitle}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
