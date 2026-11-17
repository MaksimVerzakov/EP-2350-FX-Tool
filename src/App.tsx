import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { INITIAL_PACK, OfficialPackPreset, createEmptyPack } from './constants/defaultPresets';
import { PackConfig, PresetConfig, ThemeMode } from './types/config';
import { audioEngine } from './dsp/AudioEngine';
import { serializeToConfigJson } from './utils/serializer';
import { parseConfigJson } from './utils/parser';
import { decodeHashPayload, type DecodedHashPayload } from './utils/presetUrl';
import { Ep2350SerialClient, ep2350Serial } from './utils/webSerial';
import { createMultiTabGuard } from './utils/tabGuard';

import { TopBanner } from './components/TopBanner';
import { MicDevice } from './components/MicDevice';
import { AudioPlayerCompact } from './components/AudioPlayerCompact';
import { PresetLedger } from './components/PresetLedger';
import { McpPanel } from './components/McpPanel';
import { DeviceConnector } from './components/DeviceConnector';
import { MultiTabBanner } from './components/MultiTabBanner';
import { Toast, useToast } from './components/Toast';

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

  const { toast, show: showToast, dismiss: dismissToast } = useToast();
  const [activeSlot, setActiveSlot] = useState<number>(0);
  const [activeSampleSlot, setActiveSampleSlot] = useState<number>(0);
  const [handlePos, setHandlePos] = useState<number>(1.0);
  const [rightPanelMode, setRightPanelMode] = useState<'fx' | 'mcp'>('fx');
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [isDeviceConnecting, setIsDeviceConnecting] = useState<boolean>(false);
  const [isDevicePack, setIsDevicePack] = useState<boolean>(false);
  const [devicePack, setDevicePack] = useState<PackConfig | null>(null);
  /** config.json last read from / written to the mic; used to flag unsaved changes. */
  const [savedDeviceJson, setSavedDeviceJson] = useState<string | null>(null);
  const [tabGuardStatus, setTabGuardStatus] = useState<'checking' | 'active' | 'blocked'>('checking');
  const prevTabGuardStatusRef = useRef(tabGuardStatus);
  /** Pack opened from a share link (#pack=...), kept so it stays selectable after the mic connects. */
  const [sharedPack, setSharedPack] = useState<PackConfig | null>(null);
  /**
   * Share-link payload the editor is still showing. While set, connecting the mic must not
   * replace the editor contents with the mic's config.json. Cleared once the user picks another pack.
   */
  const pendingShareRef = useRef<DecodedHashPayload | null>(null);

  const isMultiTabBlocked = tabGuardStatus === 'blocked';
  const isTabLeader = tabGuardStatus === 'active';
  const isEffectsOff = activeSlot < 0;
  const activePreset = pack.presets.find((p) => p.pos === activeSlot) || pack.presets[0];

  const syncFromConnectedDevice = useCallback(async () => {
    const rawJson = await ep2350Serial.readConfigJson();
    const parsed = parseConfigJson(rawJson);
    if (!parsed.pack) {
      throw new Error(parsed.error || 'Invalid config.json on connected device.');
    }
    setDevicePack(parsed.pack);
    setSavedDeviceJson(serializeToConfigJson(parsed.pack));

    const pendingShare = pendingShareRef.current;
    if (pendingShare) {
      // A share link is open: keep it in the editor (unsaved vs. the mic) instead of
      // overwriting it with the mic's pack. The mic's pack stays selectable in the pack list.
      if (pendingShare.type === 'preset') {
        // A shared single preset lands in its slot on top of the mic's pack.
        setPack({
          ...parsed.pack,
          presets: parsed.pack.presets.map((p) =>
            p.pos === pendingShare.slot ? pendingShare.preset : p
          )
        });
        setActiveSlot(pendingShare.slot);
      }
      setIsDeviceConnected(true);
      setIsDevicePack(false);
      return;
    }

    setPack(parsed.pack);
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
      setSavedDeviceJson(null);
    });

    const unsubscribePresetSlot = ep2350Serial.onPresetSlotChange((slot) => {
      setActiveSlot(slot);
    });

    const unsubscribeSampleSlot = ep2350Serial.onSampleSlotChange((slot) => {
      setActiveSampleSlot(slot);
      audioEngine.setActiveSampleSlot(slot);
    });

    return () => {
      unsubscribe();
      unsubscribePresetSlot();
      unsubscribeSampleSlot();
    };
  }, []);

  // Multi-tab exclusivity guard (matches EP Sample Tool: block duplicate tabs & skip serial contention)
  useEffect(() => {
    const guard = createMultiTabGuard({
      onBlockedChange: (blocked) => {
        setTabGuardStatus(blocked ? 'blocked' : 'active');
      },
    });
    return () => {
      guard.cleanup();
    };
  }, []);

  // Sync or pause hardware/localStorage side effects when tab leadership changes
  useEffect(() => {
    const prevStatus = prevTabGuardStatusRef.current;
    prevTabGuardStatusRef.current = tabGuardStatus;

    if (tabGuardStatus === 'blocked') {
      audioEngine.stop();
      audioEngine.stopSample();
      if (ep2350Serial.isConnected) {
        void ep2350Serial.disconnect().catch(() => undefined);
      }
      return;
    }

    if (prevStatus === 'blocked' && tabGuardStatus === 'active') {
      const hasHash = typeof window !== 'undefined' && decodeHashPayload(window.location.hash) !== null;
      if (!hasHash) {
        const saved = safeGetLocalStorage('ep2350_pack_config');
        if (saved) {
          const parsed = parseConfigJson(saved);
          if (parsed.pack) setPack(parsed.pack);
        }
      }
    }
  }, [tabGuardStatus]);

  // Only attempt Web Serial auto-connect from the active leader tab
  useEffect(() => {
    if (!isTabLeader) return;

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
      nav?.serial?.removeEventListener?.('connect', handleSerialConnect);
    };
  }, [isTabLeader, syncFromConnectedDevice]);

  // Stateless Shareable Deep-Link Loader (#preset=<base64url> or #pack=<base64url>)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const applyHashPayload = () => {
      const decoded = decodeHashPayload(window.location.hash);
      if (!decoded) return;
      pendingShareRef.current = decoded;
      if (decoded.type === 'pack') {
        setSharedPack(decoded.pack);
        setPack(decoded.pack);
        setActiveSlot(decoded.slot);
        setIsDevicePack(false);
        setRightPanelMode('fx');
      } else if (decoded.type === 'preset') {
        setPack((prev) => ({
          ...prev,
          presets: prev.presets.map((p) => (p.pos === decoded.slot ? decoded.preset : p))
        }));
        setActiveSlot(decoded.slot);
        setRightPanelMode('fx');
      }
    };

    applyHashPayload();
    window.addEventListener('hashchange', applyHashPayload);
    return () => {
      window.removeEventListener('hashchange', applyHashPayload);
    };
  }, []);

  // Sync theme to document root & localStorage
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    safeSetLocalStorage('ep2350_theme', theme);
  }, [theme]);

  // Save to localStorage only from the active leader tab so duplicate tabs cannot clobber edits
  useEffect(() => {
    if (!isTabLeader) return;
    safeSetLocalStorage('ep2350_pack_config', serializeToConfigJson(pack));
  }, [pack, isTabLeader]);

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
    if (isDeviceConnecting || isMultiTabBlocked) return;
    setIsDeviceConnecting(true);
    try {
      await ep2350Serial.connect();
      await syncFromConnectedDevice();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('no port selected') && !msg.toLowerCase().includes('cancel')) {
        showToast('error', 'Connection failed', msg);
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
    pendingShareRef.current = null;
    setPack(devicePack);
    setActiveSlot(0);
    setIsDevicePack(true);
    if (isDeviceConnected) {
      void ep2350Serial.loadPreset(0).catch(() => undefined);
    }
  };

  const handleSaveToDevice = async (): Promise<boolean> => {
    if (!isDeviceConnected) return false;
    try {
      const jsonStr = serializeToConfigJson(pack);
      await ep2350Serial.saveConfigJson(jsonStr, activeSlot);
      pendingShareRef.current = null;
      setDevicePack(pack);
      setIsDevicePack(true);
      setSavedDeviceJson(jsonStr);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', 'Save to mic failed', msg);
      return false;
    }
  };

  const currentPackJson = useMemo(() => serializeToConfigJson(pack), [pack]);
  const hasUnsavedDeviceChanges =
    isDeviceConnected && savedDeviceJson !== null && currentPackJson !== savedDeviceJson;

  const handleSelectDefaultPack = (presetPack: OfficialPackPreset) => {
    const parsed = parseConfigJson(presetPack.rawJson);
    if (parsed.pack) {
      pendingShareRef.current = null;
      setPack(parsed.pack);
      setActiveSlot(0);
      setIsDevicePack(false);
    }
  };

  const handleSelectSharedPack = () => {
    if (!sharedPack) return;
    pendingShareRef.current = { type: 'pack', pack: sharedPack, slot: 0 };
    setPack(sharedPack);
    setActiveSlot(0);
    setIsDevicePack(false);
  };

  const handleCreateNewPack = () => {
    pendingShareRef.current = null;
    setPack(createEmptyPack());
    setActiveSlot(0);
    setIsDevicePack(false);
  };

  const handleImportJson = (rawJson: string) => {
    const parsed = parseConfigJson(rawJson);
    if (parsed.pack) {
      pendingShareRef.current = null;
      setPack(parsed.pack);
      setActiveSlot(0);
      setIsDevicePack(false);
      showToast('success', 'Imported', 'config.json loaded. Its presets are now in the editor.');
    } else {
      showToast('error', 'Import failed', parsed.error ?? 'This file is not a valid EP-2350 config.json.');
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
    <div className="min-h-screen overflow-hidden isolate flex flex-col items-center px-4 py-4 md:px-8 md:py-[25px] select-none font-sans">
      {/* Layout origin for the background grid: 42 cells of 25px wide (+1px closing line, +5px bevel) */}
      <div className="te-grid-origin max-w-[1056px] w-full mx-auto">
      <div
        aria-disabled={isMultiTabBlocked}
        className={`w-full flex flex-col gap-[25px] transition-opacity duration-200 ${
          isMultiTabBlocked ? 'opacity-20 pointer-events-none select-none' : ''
        }`}
      >
        
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
          isDevicePack={isDevicePack}
          devicePackName={devicePack?.name}
          onSelectDevicePack={handleSelectDevicePack}
          sharedPackName={sharedPack?.name}
          onSelectSharedPack={handleSelectSharedPack}
          deviceConnector={
            <DeviceConnector
              theme={theme}
              isSupported={Ep2350SerialClient.isSupported()}
              isConnected={isDeviceConnected}
              isConnecting={isDeviceConnecting}
              hasUnsavedChanges={hasUnsavedDeviceChanges}
              onConnect={handleConnectDevice}
              onSave={handleSaveToDevice}
              onEject={handleDisconnectDevice}
            />
          }
        />

        {/* 2. MAIN TWO-COLUMN WORKBENCH DESK */}
        <div className="flex flex-col lg:flex-row items-center lg:items-start justify-between gap-8 lg:gap-[25px] w-full">
          
          {/* LEFT COLUMN: Hardware Mic Device + Floating Playback Controls */}
          <div className="w-[275px] shrink-0 flex flex-col items-start">
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

            <AudioPlayerCompact theme={theme} className="-mt-[250px]" />
          </div>

          {/* RIGHT COLUMN: FX CHAIN | MCP switch docked on the card + Ledger Sheet / MCP Panel.
              The switch sits under the card (z-0 vs the card's z-10) and overlaps it by 1px, so the pressed tab
              shares the card's top border and nothing draws over the header. */}
          <div className="flex-1 min-w-0 max-w-[756px] w-full flex flex-col items-center relative">
            <div
              className="flex items-start self-end mr-[13px] mb-[7px] lg:mb-0 lg:mr-0 lg:absolute lg:-top-[33px] lg:right-[13px] z-0"
              role="group"
              aria-label="Right panel view"
            >
              {([
                { id: 'fx', label: 'FX CHAIN', widthClass: 'w-[76px]', isEdge: false, title: 'Show preset FX chain editor' },
                { id: 'mcp', label: 'MCP', widthClass: 'w-[75px]', isEdge: true, title: 'Connect the EP-2350 tool to your AI' }
              ] as const).map((tab) => {
                const isActive = rightPanelMode === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setRightPanelMode(tab.id)}
                    aria-pressed={isActive}
                    title={tab.title}
                    className={`te-dock-btn ${tab.isEdge ? 'te-dock-btn--edge' : ''} h-[26px] ${tab.widthClass} px-[5px] flex items-center justify-center gap-[4px] font-mono text-te-xs font-bold tracking-normal uppercase cursor-pointer ${
                      'bg-te-control text-te-ink'
                    } ${
                      isActive
                        ? 'te-dock-btn--pressed z-0'
                        : 'z-10 hover:brightness-105'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full border shrink-0 ${
                        isActive
                          ? 'bg-te-accent border-te-edge'
                          : 'bg-transparent border-te-muted'
                      }`}
                    />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
            {rightPanelMode === 'fx' ? (
              <PresetLedger
                preset={activePreset}
                totalPresets={pack.presets.length}
                isEffectsOff={isEffectsOff}
                presetNames={pack.presets.map((p, i) => p.name || `PRESET ${i + 1}`)}
                onUpdatePreset={handleUpdateActivePreset}
                onSelectPreset={handleSelectSlot}
                theme={theme}
              />
            ) : (
              <McpPanel theme={theme} />
            )}
          </div>
        </div>
      </div>
      </div>

      <Toast toast={toast} onDismiss={dismissToast} />
      {isMultiTabBlocked && <MultiTabBanner theme={theme} />}
    </div>
  );
};
