import React, { useState, useEffect, useCallback } from 'react';
import { INITIAL_PACK, OfficialPackPreset, createEmptyPack } from './constants/defaultPresets';
import { PackConfig, PresetConfig, ThemeMode } from './types/config';
import { audioEngine } from './dsp/AudioEngine';
import { serializeToConfigJson } from './utils/serializer';
import { parseConfigJson } from './utils/parser';

import { TopBanner } from './components/TopBanner';
import { MicDevice } from './components/MicDevice';
import { AudioPlayerCompact } from './components/AudioPlayerCompact';
import { PresetLedger } from './components/PresetLedger';

const safeGetLocalStorage = (key: string): string | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};

const safeSetLocalStorage = (key: string, value: string): void => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Ignore QuotaExceededError or restricted storage errors in private browsing
  }
};

export const App: React.FC = () => {
  const [pack, setPack] = useState<PackConfig>(() => {
    const saved = safeGetLocalStorage('ep2350_pack_config');
    if (saved) {
      const parsed = parseConfigJson(saved);
      if (parsed.pack) return parsed.pack;
    }
    return INITIAL_PACK;
  });

  const [theme, setTheme] = useState<ThemeMode>(() => {
    const savedTheme = safeGetLocalStorage('ep2350_theme');
    return savedTheme === 'ting' ? 'ting' : 'fx';
  });

  const [activeSlot, setActiveSlot] = useState<number>(0);
  const [handlePos, setHandlePos] = useState<number>(1.0);

  const activePreset = pack.presets.find((p) => p.pos === activeSlot) || pack.presets[0];

  // Sync theme to document root & localStorage
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    safeSetLocalStorage('ep2350_theme', theme);
  }, [theme]);

  // Save to localStorage
  useEffect(() => {
    safeSetLocalStorage('ep2350_pack_config', serializeToConfigJson(pack));
  }, [pack]);

  // Synchronize active preset with DSP engine
  useEffect(() => {
    audioEngine.updatePreset(activePreset);
  }, [activePreset]);

  // Squeeze handle modulation
  const handleHandleChange = useCallback((val: number) => {
    setHandlePos(val);
    audioEngine.updateModulation({ handlePos: val });
  }, []);

  // Shake trigger
  const handleShakeTrigger = useCallback(() => {
    audioEngine.triggerShake(1.0);
  }, []);

  const handleUpdateActivePreset = (updated: PresetConfig) => {
    const updatedPresets = pack.presets.map((p) =>
      p.pos === updated.pos ? updated : p
    );
    setPack({
      ...pack,
      presets: updatedPresets
    });
  };

  const handleSelectDefaultPack = (presetPack: OfficialPackPreset) => {
    const parsed = parseConfigJson(presetPack.rawJson);
    if (parsed.pack) {
      setPack(parsed.pack);
      setActiveSlot(0);
    }
  };

  const handleCreateNewPack = () => {
    setPack(createEmptyPack());
    setActiveSlot(0);
  };

  const handleImportJson = (rawJson: string) => {
    const parsed = parseConfigJson(rawJson);
    if (parsed.pack) {
      setPack(parsed.pack);
      setActiveSlot(0);
      alert('config.json successfully loaded into EP-2350 tool!');
    } else {
      alert(`Import error: ${parsed.error}`);
    }
  };

  const handleExportJson = () => {
    const jsonStr = serializeToConfigJson(pack);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'config.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-4 md:px-8 md:py-6 select-none font-sans">
      <div className="max-w-[1067px] w-full flex flex-col gap-6 mx-auto">
        
        {/* 1. TOP BANNER (Modular Badge & Action Buttons) */}
        <TopBanner
          packName={pack.name}
          onUpdatePackName={(name) => setPack({ ...pack, name })}
          onSelectDefaultPack={handleSelectDefaultPack}
          onCreateNewPack={handleCreateNewPack}
          onImportJson={handleImportJson}
          onExportJson={handleExportJson}
          theme={theme}
          onChangeTheme={setTheme}
        />

        {/* 2. MAIN TWO-COLUMN WORKBENCH DESK */}
        <div className="flex flex-col lg:flex-row items-center lg:items-start justify-between gap-8 w-full">
          
          {/* LEFT COLUMN: Hardware Mic Device + Compact Audition Player */}
          <div className="w-[275px] shrink-0 flex flex-col items-start h-[624px] justify-between">
            <MicDevice
              activeSlot={activeSlot}
              onSelectSlot={setActiveSlot}
              handlePos={handlePos}
              onHandleChange={handleHandleChange}
              onShakeTrigger={handleShakeTrigger}
              theme={theme}
            />

            <AudioPlayerCompact theme={theme} className="-mt-[12px]" />
          </div>

          {/* RIGHT COLUMN: Preset Details Ledger Sheet */}
          <div className="flex-1 min-w-0 max-w-[760px] w-full flex flex-col items-center">
            <PresetLedger
              preset={activePreset}
              totalPresets={pack.presets.length}
              onUpdatePreset={handleUpdateActivePreset}
              onSelectPreset={setActiveSlot}
              theme={theme}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
