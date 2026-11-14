import React, { useState, useEffect, useCallback } from 'react';
import { INITIAL_PACK, OfficialPackPreset, createEmptyPack } from './constants/defaultPresets';
import { PackConfig, PresetConfig, ThemeMode } from './types/config';
import { audioEngine } from './dsp/AudioEngine';
import { serializeToConfigJson } from './utils/serializer';
import { parseConfigJson } from './utils/parser';
import { decodeHashPayload } from './utils/presetUrl';
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

  const isEffectsOff = activeSlot < 0;
  const activePreset = pack.presets.find((p) => p.pos === activeSlot) || pack.presets[0];

  const syncFromConnectedDevice = useCallback(async () => {
    const rawJson = await ep2350Serial.readConfigJson();
    const parsed = parseConfigJson(rawJson);
    if (!parsed.pack) {
      throw new Error(parsed.error || 'Invalid config.json on connected device.');
    }
    setPack(parsed.pack);
    setDevicePack(parsed.pack);
    const hwSlots = await ep2350Serial.pollHardwareSlot().catch(() => null);
    if (hwSlots) {
      setActiveSlot(hwSlots.fxSlot);
      setActiveSampleSlot(hwSlots.samSlot);
      audioEngine.setActiveSampleSlot(hwSlots.samSlot);
    } else {
      setActiveSlot(0);
    }
    setIsDeviceConnected(true);
    setIsDevicePack(true);
  }, []);

  useEffect(() => {
    const unsubscribe = ep2350Serial.onDisconnect(() => {
      setIsDeviceConnected(false);
      setIsDeviceConnecting(false);
      setIsDevicePack(false);
      setDevicePack(null);
    });

    const unsubscribePresetSlot = ep2350Serial.onPresetSlotChange((slot) => {
      setActiveSlot(slot);
    });

    const unsubscribeSampleSlot = ep2350Serial.onSampleSlotChange((slot) => {
      setActiveSampleSlot(slot);
      audioEngine.setActiveSampleSlot(slot);
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
      unsubscribePresetSlot();
      unsubscribeSampleSlot();
      nav?.serial?.removeEventListener?.('connect', handleSerialConnect);
    };
  }, [syncFromConnectedDevice]);

  // Stateless Shareable Deep-Link Loader (#preset=<base64url> or #pack=<base64url>)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const applyHashPayload = () => {
      const decoded = decodeHashPayload(window.location.hash);
      if (!decoded) return;
      if (decoded.type === 'pack') {
        setPack(decoded.pack);
        setActiveSlot(decoded.slot);
        setIsDevicePack(false);
      } else if (decoded.type === 'preset') {
        setPack((prev) => ({
          ...prev,
          presets: prev.presets.map((p) => (p.pos === decoded.slot ? decoded.preset : p))
        }));
        setActiveSlot(decoded.slot);
      }
    };

    applyHashPayload();
    window.addEventListener('hashchange', applyHashPayload);
    return () => {
      window.removeEventListener('hashchange', applyHashPayload);
    };
  }, []);

  // Live MCP Sound Designer Sync Bridge (/ __mcp_sync SSE)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;
    let es: EventSource | null = null;
    try {
      es = new window.EventSource('/__mcp_sync');
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (typeof data?.configJson === 'string') {
            const parsed = parseConfigJson(data.configJson);
            if (parsed.pack) {
              setPack(parsed.pack);
              if (typeof data.slot === 'number') setActiveSlot(Math.max(0, Math.min(3, data.slot)));
            }
          } else if (data?.pack && typeof data.pack === 'object') {
            const rawStr = JSON.stringify(data.pack);
            const parsed = parseConfigJson(rawStr);
            if (parsed.pack) {
              setPack(parsed.pack);
              if (typeof data.slot === 'number') setActiveSlot(Math.max(0, Math.min(3, data.slot)));
            }
          } else if (data?.preset && typeof data.preset === 'object') {
            const targetSlot = Math.max(
              0,
              Math.min(3, typeof data.slot === 'number' ? data.slot : data.preset.pos ?? 0)
            );
            const incomingPreset: PresetConfig = {
              ...data.preset,
              id: data.preset.id || `mcp-preset-${targetSlot}-${Date.now()}`,
              pos: targetSlot,
              list: Array.isArray(data.preset.list)
                ? data.preset.list.map((fx: any, idx: number) => ({
                    id: fx.id || `mcp-fx-${targetSlot}-${idx}`,
                    ...fx
                  }))
                : []
            };
            setPack((prev) => ({
              ...prev,
              presets: prev.presets.map((p) => (p.pos === targetSlot ? incomingPreset : p))
            }));
            setActiveSlot(targetSlot);
          }
        } catch {
          // Ignore malformed SSE messages
        }
      };
    } catch {
      // Ignore SSE connection failure on static hosts
    }
    return () => {
      es?.close();
    };
  }, []);

  // Sync theme to document root & localStorage
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    safeSetLocalStorage('ep2350_theme', theme);
  }, [theme]);

  // Save to localStorage
  useEffect(() => {
    safeSetLocalStorage('ep2350_pack_config', serializeToConfigJson(pack));
  }, [pack]);

  // Synchronize active preset with DSP engine (dry bypass when FX are switched off)
  useEffect(() => {
    if (isEffectsOff) {
      audioEngine.updatePreset({ id: 'fx-off', name: 'FX OFF', pos: -1, list: [] });
    } else {
      audioEngine.updatePreset(activePreset);
    }
  }, [activePreset, isEffectsOff]);

  // Synchronize active sample slot with DSP engine and connected hardware
  const handleSelectSampleSlot = useCallback(
    (slot: number) => {
      setActiveSampleSlot(slot);
      audioEngine.setActiveSampleSlot(slot);
      if (isDeviceConnected && isDevicePack) {
        void ep2350Serial.selectSampleSlot(slot).catch(() => undefined);
      }
    },
    [isDeviceConnected, isDevicePack]
  );

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
          <div className="w-[275px] shrink-0 flex flex-col items-start h-[629px] justify-between">
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
              isEffectsOff={isEffectsOff}
              presetNames={pack.presets.map((p, i) => p.name || `PRESET ${i + 1}`)}
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
