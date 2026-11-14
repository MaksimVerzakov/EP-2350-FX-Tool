import React, { useState, useEffect, useCallback } from 'react';
import { INITIAL_PACK, OfficialPackPreset, createEmptyPack } from './constants/defaultPresets';
import { PackConfig, PresetConfig, ThemeMode } from './types/config';
import { audioEngine } from './dsp/AudioEngine';
import { serializeToConfigJson } from './utils/serializer';
import { parseConfigJson } from './utils/parser';
import { ep2350Serial } from './utils/webSerial';

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
  const [activeSampleSlot, setActiveSampleSlot] = useState<number>(0);
  const [handlePos, setHandlePos] = useState<number>(1.0);
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [isDeviceConnecting, setIsDeviceConnecting] = useState<boolean>(false);
  const [isDevicePack, setIsDevicePack] = useState<boolean>(false);
  const [devicePack, setDevicePack] = useState<PackConfig | null>(null);

  const activePreset = pack.presets.find((p) => p.pos === activeSlot) || pack.presets[0];

  const syncFromConnectedDevice = useCallback(async () => {
    const rawJson = await ep2350Serial.readConfigJson();
    const parsed = parseConfigJson(rawJson);
    if (!parsed.pack) {
      throw new Error(parsed.error || 'Invalid config.json on connected device.');
    }
    setPack(parsed.pack);
    setDevicePack(parsed.pack);
    setActiveSlot(0);
    setIsDeviceConnected(true);
    setIsDevicePack(true);
    void ep2350Serial.loadPreset(0).catch(() => undefined);
  }, []);

  useEffect(() => {
    const unsubscribe = ep2350Serial.onDisconnect(() => {
      setIsDeviceConnected(false);
      setIsDeviceConnecting(false);
      setIsDevicePack(false);
      setDevicePack(null);
    });

    const tryAuto = () => {
      void ep2350Serial
        .tryAutoConnect()
        .then((connected) => {
          if (connected) {
            return syncFromConnectedDevice();
          }
          return undefined;
        })
        .catch(() => undefined);
    };

    tryAuto();

    const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { serial?: EventTarget }) : undefined;
    const handleSerialConnect = () => tryAuto();
    nav?.serial?.addEventListener?.('connect', handleSerialConnect);

    return () => {
      unsubscribe();
      nav?.serial?.removeEventListener?.('connect', handleSerialConnect);
    };
  }, [syncFromConnectedDevice]);

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

  // Synchronize active sample slot with DSP engine
  const handleSelectSampleSlot = useCallback((slot: number) => {
    setActiveSampleSlot(slot);
    audioEngine.setActiveSampleSlot(slot);
  }, []);

  // Trigger selected sample through active preset's SAMPLE block
  const handleSampleTrigger = useCallback(
    (down: boolean) => {
      const slotCfg = pack.samples.find((s) => s.pos === activeSampleSlot) || pack.samples[activeSampleSlot];
      audioEngine.triggerSample(down, slotCfg?.playmode || 'oneshot');
    },
    [pack.samples, activeSampleSlot]
  );

  // Squeeze handle modulation
  const handleHandleChange = useCallback((val: number) => {
    setHandlePos(val);
    audioEngine.updateModulation({ handlePos: val });
  }, []);

  // Shake trigger
  const handleShakeTrigger = useCallback(() => {
    audioEngine.triggerShake(1.0);
  }, []);

  const handleSelectSlot = useCallback(
    (slot: number) => {
      setActiveSlot(slot);
      if (isDeviceConnected && isDevicePack) {
        void ep2350Serial.loadPreset(slot).catch(() => undefined);
      }
    },
    [isDeviceConnected, isDevicePack]
  );

  const handleUpdateActivePreset = (updated: PresetConfig) => {
    if (isDeviceConnected && isDevicePack && updated.list.length === activePreset.list.length) {
      for (let row = 0; row < updated.list.length; row++) {
        const prevFx = activePreset.list[row];
        const nextFx = updated.list[row];
        if (prevFx && nextFx && prevFx.effect === nextFx.effect) {
          const prevRec = prevFx as unknown as Record<string, unknown>;
          for (const [key, val] of Object.entries(nextFx)) {
            if (
              key !== 'id' &&
              key !== 'effect' &&
              key !== 'EFFECT' &&
              key !== 'BUS' &&
              typeof val === 'number' &&
              prevRec[key] !== val
            ) {
              ep2350Serial.setParam(updated.pos, row, key, val, nextFx.effect);
            }
          }
        }
      }
    }

    const updatedPresets = pack.presets.map((p) =>
      p.pos === updated.pos ? updated : p
    );
    const nextPack = {
      ...pack,
      presets: updatedPresets
    };
    setPack(nextPack);
    if (isDevicePack) {
      setDevicePack(nextPack);
    }
  };

  const handleUpdatePackName = (name: string) => {
    const nextPack = { ...pack, name };
    setPack(nextPack);
    if (isDevicePack) {
      setDevicePack(nextPack);
    }
  };

  const handleConnectDevice = async () => {
    if (isDeviceConnecting) return;
    setIsDeviceConnecting(true);
    try {
      await ep2350Serial.connect();
      await syncFromConnectedDevice();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('no port selected') && !msg.toLowerCase().includes('cancel')) {
        alert(`Device connection error: ${msg}`);
      }
      await ep2350Serial.disconnect().catch(() => undefined);
    } finally {
      setIsDeviceConnecting(false);
    }
  };

  const handleDisconnectDevice = async () => {
    await ep2350Serial.disconnect().catch(() => undefined);
  };

  const handleSelectDevicePack = () => {
    if (!devicePack) return;
    setPack(devicePack);
    setActiveSlot(0);
    setIsDevicePack(true);
    if (isDeviceConnected) {
      void ep2350Serial.loadPreset(0).catch(() => undefined);
    }
  };

  const handleSaveToDevice = async () => {
    if (!isDeviceConnected) return;
    try {
      const jsonStr = serializeToConfigJson(pack);
      await ep2350Serial.saveConfigJson(jsonStr, activeSlot);
      setDevicePack(pack);
      setIsDevicePack(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to save to device: ${msg}`);
    }
  };

  const handleSelectDefaultPack = (presetPack: OfficialPackPreset) => {
    const parsed = parseConfigJson(presetPack.rawJson);
    if (parsed.pack) {
      setPack(parsed.pack);
      setActiveSlot(0);
      setIsDevicePack(false);
    }
  };

  const handleCreateNewPack = () => {
    setPack(createEmptyPack());
    setActiveSlot(0);
    setIsDevicePack(false);
  };

  const handleImportJson = (rawJson: string) => {
    const parsed = parseConfigJson(rawJson);
    if (parsed.pack) {
      setPack(parsed.pack);
      setActiveSlot(0);
      setIsDevicePack(false);
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
          onUpdatePackName={handleUpdatePackName}
          onSelectDefaultPack={handleSelectDefaultPack}
          onCreateNewPack={handleCreateNewPack}
          onImportJson={handleImportJson}
          onExportJson={handleExportJson}
          theme={theme}
          onChangeTheme={setTheme}
          isDeviceConnected={isDeviceConnected}
          isDeviceConnecting={isDeviceConnecting}
          isDevicePack={isDevicePack}
          devicePackName={devicePack?.name}
          onConnectDevice={handleConnectDevice}
          onDisconnectDevice={handleDisconnectDevice}
          onSelectDevicePack={handleSelectDevicePack}
          onSaveToDevice={handleSaveToDevice}
        />

        {/* 2. MAIN TWO-COLUMN WORKBENCH DESK */}
        <div className="flex flex-col lg:flex-row items-center lg:items-start justify-between gap-8 w-full">
          
          {/* LEFT COLUMN: Hardware Mic Device + Compact Audition Player */}
          <div className="w-[275px] shrink-0 flex flex-col items-start h-[624px] justify-between">
            <MicDevice
              activeSlot={activeSlot}
              onSelectSlot={handleSelectSlot}
              activeSampleSlot={activeSampleSlot}
              onSelectSampleSlot={handleSelectSampleSlot}
              onSampleTrigger={handleSampleTrigger}
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
              onSelectPreset={handleSelectSlot}
              theme={theme}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
