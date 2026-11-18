import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { INITIAL_PACK, OFFICIAL_TE_PACKS, OfficialPackPreset, createEmptyPack } from './constants/defaultPresets';
import { PackConfig, PlayMode, PresetConfig, ThemeMode } from './types/config';
import { audioEngine } from './dsp/AudioEngine';
import { serializeToConfigJson } from './utils/serializer';
import { parseConfigJson } from './utils/parser';
import { decodeHashPayload } from './utils/presetUrl';
import { Ep2350SerialClient, ep2350Serial } from './utils/webSerial';
import { createMultiTabGuard } from './utils/tabGuard';
import {
  SAMPLE_SLOTS,
  assignSampleFile,
  clearSampleSlot,
  customSampleAt,
  customSampleSlots,
  inspectWav,
  sanitizeSampleFileName,
  updateSampleSlot,
  wavDeviceIssues
} from './utils/samples';
import { createZip } from './utils/zip';
import {
  type KeyValueStore,
  type PackSelection,
  type UserPack,
  LEGACY_PACK_KEY,
  addUserPack,
  loadSelection,
  loadUserPacks,
  migrateLegacyPack,
  packFingerprint,
  planIncomingPack,
  removeUserPack,
  saveSelection,
  saveUserPacks,
  updateUserPack
} from './utils/userPacks';

import { TopBanner } from './components/TopBanner';
import { MicDevice } from './components/MicDevice';
import { AudioPlayerCompact } from './components/AudioPlayerCompact';
import { PresetLedger } from './components/PresetLedger';
import { McpPanel } from './components/McpPanel';
import { SamplesPanel, type LoadedSample } from './components/SamplesPanel';
import { DeviceConnector } from './components/DeviceConnector';
import { MultiTabBanner } from './components/MultiTabBanner';
import { PackConflictDialog } from './components/PackConflictDialog';
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

const browserStore: KeyValueStore = { getItem: safeGetLocalStorage, setItem: safeSetLocalStorage };

interface InitialPackState {
  pack: PackConfig;
  userPacks: UserPack[];
  selection: PackSelection | null;
}

/** Resolve what the editor shows on load: the last selected user/official pack, else the last editor snapshot. */
function resolveInitialPackState(): InitialPackState {
  const { packs: userPacks, migratedId } = migrateLegacyPack(
    browserStore,
    OFFICIAL_TE_PACKS.map((o) => o.pack)
  );
  if (migratedId) {
    const migrated = userPacks.find((p) => p.id === migratedId)!;
    return { pack: migrated.pack, userPacks, selection: { kind: 'user', id: migratedId } };
  }
  const sel = loadSelection(browserStore);
  if (sel?.kind === 'user') {
    const found = userPacks.find((p) => p.id === sel.id);
    if (found) return { pack: found.pack, userPacks, selection: sel };
  }
  if (sel?.kind === 'official') {
    const official = OFFICIAL_TE_PACKS.find((o) => o.id === sel.id);
    if (official) return { pack: official.pack, userPacks, selection: sel };
  }
  const saved = safeGetLocalStorage(LEGACY_PACK_KEY);
  const parsed = saved ? parseConfigJson(saved) : null;
  if (parsed?.pack) {
    const fp = packFingerprint(parsed.pack);
    const official = OFFICIAL_TE_PACKS.find((o) => packFingerprint(o.pack) === fp);
    return { pack: parsed.pack, userPacks, selection: official ? { kind: 'official', id: official.id } : null };
  }
  return { pack: INITIAL_PACK, userPacks, selection: { kind: 'official', id: OFFICIAL_TE_PACKS[0].id } };
}

/** Resolved once per page load: React StrictMode calls state initializers twice, and the migration writes storage. */
let initialPackStateCache: InitialPackState | null = null;
const getInitialPackState = (): InitialPackState => (initialPackStateCache ??= resolveInitialPackState());

export const App: React.FC = () => {
  const [initialPackState] = useState(getInitialPackState);
  const [pack, setPack] = useState<PackConfig>(initialPackState.pack);
  /** Latest pack, for edits that finish after an await (loading a WAV). */
  const packRef = useRef(pack);
  packRef.current = pack;
  /** "YOUR PACKS": packs the user created, imported or opened from a link, kept in localStorage. */
  const [userPacks, setUserPacks] = useState<UserPack[]>(initialPackState.userPacks);
  const [selection, setSelection] = useState<PackSelection | null>(initialPackState.selection);
  const userPacksRef = useRef(userPacks);
  userPacksRef.current = userPacks;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** A linked/imported pack whose name clashes with a stored one, waiting for REPLACE / SAVE AS COPY. */
  const [pendingIncoming, setPendingIncoming] = useState<{
    pack: PackConfig;
    slot: number;
    existingId: string;
    copyName: string;
  } | null>(null);

  /** Show a stored YOUR PACKS entry in the editor. */
  const openStoredPack = useCallback((packs: UserPack[], id: string, slot = 0) => {
    const found = packs.find((p) => p.id === id);
    if (!found) return;
    setSelection({ kind: 'user', id });
    setPack(found.pack);
    setActiveSlot(slot);
    setIsDevicePack(false);
    setRightPanelMode('fx');
  }, []);

  /**
   * A pack arriving from a link or an import lands in YOUR PACKS: identical → open the stored one,
   * same name but different → ask (REPLACE / SAVE AS COPY), otherwise add it.
   */
  const receivePack = useCallback(
    (incoming: PackConfig, slot = 0): boolean => {
      const plan = planIncomingPack(userPacksRef.current, incoming);
      if (plan.action === 'ask') {
        setPendingIncoming({ pack: incoming, slot, existingId: plan.existingId, copyName: plan.copyName });
        return false;
      }
      let packs = userPacksRef.current;
      let id: string;
      if (plan.action === 'open') {
        id = plan.id;
      } else {
        ({ packs, id } = addUserPack(packs, incoming));
        userPacksRef.current = packs;
        setUserPacks(packs);
      }
      openStoredPack(packs, id, slot);
      return true;
    },
    [openStoredPack]
  );

  const handleConflictReplace = () => {
    if (!pendingIncoming) return;
    const packs = updateUserPack(userPacksRef.current, pendingIncoming.existingId, pendingIncoming.pack);
    userPacksRef.current = packs;
    setUserPacks(packs);
    openStoredPack(packs, pendingIncoming.existingId, pendingIncoming.slot);
    setPendingIncoming(null);
  };

  const handleConflictSaveAsCopy = () => {
    if (!pendingIncoming) return;
    const { packs, id } = addUserPack(userPacksRef.current, {
      ...pendingIncoming.pack,
      name: pendingIncoming.copyName
    });
    userPacksRef.current = packs;
    setUserPacks(packs);
    openStoredPack(packs, id, pendingIncoming.slot);
    setPendingIncoming(null);
  };

  const handleConflictCancel = useCallback(() => setPendingIncoming(null), []);

  const [theme, setTheme] = useState<ThemeMode>(() => {
    const savedTheme = safeGetLocalStorage('ep2350_theme');
    return savedTheme === 'ting' ? 'ting' : 'fx';
  });

  const { toast, show: showToast, dismiss: dismissToast } = useToast();
  const [activeSlot, setActiveSlot] = useState<number>(0);
  const [activeSampleSlot, setActiveSampleSlot] = useState<number>(0);
  const [handlePos, setHandlePos] = useState<number>(1.0);
  const [rightPanelMode, setRightPanelMode] = useState<'fx' | 'samples' | 'mcp'>('fx');
  /** WAV files loaded in this browser session, by disk file name (not stored across reloads yet). */
  const [sampleLibrary, setSampleLibrary] = useState<Record<string, LoadedSample>>({});
  /** Decoded audio for the loaded WAVs, by file name. */
  const decodedSamplesRef = useRef(new Map<string, AudioBuffer>());
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [isDeviceConnecting, setIsDeviceConnecting] = useState<boolean>(false);
  const [isDevicePack, setIsDevicePack] = useState<boolean>(false);
  const [devicePack, setDevicePack] = useState<PackConfig | null>(null);
  /** config.json last read from / written to the mic; used to flag unsaved changes. */
  const [savedDeviceJson, setSavedDeviceJson] = useState<string | null>(null);
  const [tabGuardStatus, setTabGuardStatus] = useState<'checking' | 'active' | 'blocked'>('checking');
  const prevTabGuardStatusRef = useRef(tabGuardStatus);

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
    setPack(parsed.pack);
    setDevicePack(parsed.pack);
    setSavedDeviceJson(serializeToConfigJson(parsed.pack));
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
    setSelection({ kind: 'device' });
  }, []);

  useEffect(() => {
    const unsubscribe = ep2350Serial.onDisconnect(() => {
      setIsDeviceConnected(false);
      setIsDeviceConnecting(false);
      setIsDevicePack(false);
      setDevicePack(null);
      setSavedDeviceJson(null);
      setSelection((prev) => (prev?.kind === 'device' ? null : prev));
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
      // Another tab may have changed YOUR PACKS while this one was blocked.
      const fresh = loadUserPacks(browserStore);
      setUserPacks(fresh);
      const sel = selectionRef.current;
      if (sel?.kind === 'user') {
        const found = fresh.find((p) => p.id === sel.id);
        if (found) setPack(found.pack);
        else setSelection(null);
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
      // A link always lands in YOUR PACKS so it survives connecting the mic or switching packs.
      let linkedPack: PackConfig;
      if (decoded.type === 'pack') {
        linkedPack = decoded.pack;
      } else {
        const base = createEmptyPack();
        linkedPack = {
          ...base,
          name: (decoded.preset.name || 'SHARED PRESET').toUpperCase().slice(0, 24),
          presets: base.presets.map((p) => (p.pos === decoded.slot ? decoded.preset : p))
        };
      }
      receivePack(linkedPack, decoded.slot);
      // Drop the payload from the URL so a reload doesn't add the pack again.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };

    applyHashPayload();
    window.addEventListener('hashchange', applyHashPayload);
    return () => {
      window.removeEventListener('hashchange', applyHashPayload);
    };
  }, [receivePack]);

  // Sync theme to document root & localStorage
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    safeSetLocalStorage('ep2350_theme', theme);
  }, [theme]);

  // Save to localStorage only from the active leader tab so duplicate tabs cannot clobber edits
  useEffect(() => {
    if (!isTabLeader) return;
    safeSetLocalStorage(LEGACY_PACK_KEY, serializeToConfigJson(pack));
  }, [pack, isTabLeader]);

  useEffect(() => {
    if (!isTabLeader) return;
    saveUserPacks(browserStore, userPacks);
  }, [userPacks, isTabLeader]);

  useEffect(() => {
    if (!isTabLeader) return;
    saveSelection(browserStore, selection);
  }, [selection, isTabLeader]);

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

  // Trigger a sample slot through the active preset's SAMPLE block
  const triggerSampleSlot = useCallback(
    (pos: number, down: boolean) => {
      const slotCfg = pack.useBuiltInSamples
        ? pack.samples.find((s) => s.pos === pos) || pack.samples[pos]
        : customSampleAt(pack, pos);
      audioEngine.triggerSample(down, slotCfg?.playmode || 'oneshot', pack.useBuiltInSamples ? 0 : slotCfg?.duck ?? 0);
    },
    [pack]
  );

  const handleSampleTrigger = useCallback(
    (down: boolean) => triggerSampleSlot(activeSampleSlot, down),
    [triggerSampleSlot, activeSampleSlot]
  );

  /** The SAMPLES panel's PLAY button: select the slot (as the mic's sample button would), then play it. */
  const handlePlaySampleSlot = useCallback(
    (pos: number, down: boolean) => {
      if (down && pos !== activeSampleSlot) handleSelectSampleSlot(pos);
      triggerSampleSlot(pos, down);
    },
    [activeSampleSlot, handleSelectSampleSlot, triggerSampleSlot]
  );

  // Custom WAVs play from their slots in the preview; other slots play the bundled demo sounds
  useEffect(() => {
    for (let pos = 0; pos < SAMPLE_SLOTS; pos++) {
      const slot = customSampleAt(pack, pos);
      audioEngine.setCustomSample(pos, (slot && decodedSamplesRef.current.get(slot.file)) || null);
    }
  }, [pack, sampleLibrary]);

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
    commitPackEdit({
      ...pack,
      presets: updatedPresets
    });
  };

  /** Apply an edit to the editor pack; user packs save as you go, official packs only live in memory. */
  const commitPackEdit = (nextPack: PackConfig) => {
    packRef.current = nextPack;
    setPack(nextPack);
    if (isDevicePack) {
      setDevicePack(nextPack);
    }
    if (selection?.kind === 'user') {
      setUserPacks((prev) => updateUserPack(prev, selection.id, nextPack));
    }
  };

  const handleUpdatePackName = (name: string) => {
    commitPackEdit({ ...pack, name });
  };

  /**
   * Edits to an official pack are not kept, unless the user saves it to the mic or exports it:
   * then the edited pack is copied into YOUR PACKS and selected.
   */
  const keepEditedPackAsCopy = (): boolean => {
    let shouldCopy = selection === null;
    if (selection?.kind === 'official') {
      const official = OFFICIAL_TE_PACKS.find((o) => o.id === selection.id);
      shouldCopy = !official || packFingerprint(official.pack) !== packFingerprint(pack);
    }
    if (!shouldCopy) return false;
    const { packs, id } = addUserPack(userPacksRef.current, pack);
    userPacksRef.current = packs;
    setUserPacks(packs);
    setSelection({ kind: 'user', id });
    return true;
  };

  const selectUserPack = (id: string) => {
    const found = userPacks.find((p) => p.id === id);
    if (!found) return;
    setPack(found.pack);
    setSelection({ kind: 'user', id });
    setActiveSlot(0);
    setIsDevicePack(false);
  };

  const handleDeleteUserPack = (id: string) => {
    const found = userPacks.find((p) => p.id === id);
    if (!found) return;
    // The pack list asks "DELETE?" before calling this.
    setUserPacks((prev) => removeUserPack(prev, id));
    if (selection?.kind === 'user' && selection.id === id) {
      const fallback = OFFICIAL_TE_PACKS[0];
      setPack(fallback.pack);
      setSelection({ kind: 'official', id: fallback.id });
      setActiveSlot(0);
      setIsDevicePack(false);
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
    setPack(devicePack);
    setSelection({ kind: 'device' });
    setActiveSlot(0);
    setIsDevicePack(true);
    if (isDeviceConnected) {
      void ep2350Serial.loadPreset(0).catch(() => undefined);
    }
  };

  const handleLoadSampleFile = async (pos: number, file: File) => {
    let bytes: Uint8Array;
    let info;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      info = inspectWav(bytes);
    } catch (err) {
      showToast('error', 'Not a WAV file', `${file.name}: ${err instanceof Error ? err.message : String(err)} The mic only plays WAV files.`);
      return;
    }
    // Read the pack after the awaits: another WAV may have been loaded meanwhile
    const others = customSampleSlots(packRef.current)
      .filter((s) => s.pos !== pos)
      .map((s) => s.file);
    const name = sanitizeSampleFileName(file.name, others);
    setSampleLibrary((lib) => ({ ...lib, [name]: { bytes, info } }));
    commitPackEdit(assignSampleFile(packRef.current, pos, name));
    try {
      decodedSamplesRef.current.set(name, await audioEngine.decodeSampleFile(bytes));
      setSampleLibrary((lib) => ({ ...lib })); // re-run the engine sync now the audio is decoded
    } catch {
      decodedSamplesRef.current.delete(name);
    }
    const issues = wavDeviceIssues(info);
    if (issues.length > 0) {
      showToast('error', 'The mic cannot play this WAV', issues[0]);
    } else if (!decodedSamplesRef.current.has(name)) {
      showToast('error', 'No preview', `This browser cannot play ${name}, but it is in the pack.`);
    }
  };

  const handleClearSampleSlot = (pos: number) => {
    commitPackEdit(clearSampleSlot(pack, pos));
  };

  const handleUpdateSampleSlot = (pos: number, patch: { playmode?: PlayMode; duck?: number | undefined }) => {
    commitPackEdit(updateSampleSlot(pack, pos, patch));
  };

  const handleSaveToDevice = async (): Promise<boolean> => {
    if (!isDeviceConnected) return false;
    try {
      const jsonStr = serializeToConfigJson(pack);
      await ep2350Serial.saveConfigJson(jsonStr, activeSlot);
      const copied = selection?.kind === 'official' && keepEditedPackAsCopy();
      if (selection === null) setSelection({ kind: 'device' });
      if (customSampleSlots(pack).length > 0) {
        // Saving over USB writes config.json only; the WAVs travel by disk for now
        showToast(
          'success',
          'Saved to the mic',
          'Saving over USB writes config.json only. Copy the WAVs to the fx-mic disk (EXPORT includes them), or the mic plays its factory sounds in those slots.'
        );
      } else if (copied) showToast('success', 'Saved to the mic', 'A copy of this pack is now in YOUR PACKS.');
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
      setPack(parsed.pack);
      setSelection({ kind: 'official', id: presetPack.id });
      setActiveSlot(0);
      setIsDevicePack(false);
    }
  };

  const handleCreateNewPack = () => {
    const { packs, id } = addUserPack(userPacksRef.current, createEmptyPack());
    userPacksRef.current = packs;
    setUserPacks(packs);
    setSelection({ kind: 'user', id });
    setPack(packs.find((p) => p.id === id)!.pack);
    setActiveSlot(0);
    setIsDevicePack(false);
  };

  const handleImportJson = (rawJson: string) => {
    const parsed = parseConfigJson(rawJson);
    if (parsed.pack) {
      if (receivePack(parsed.pack)) {
        showToast('success', 'Imported', 'config.json loaded and added to YOUR PACKS.');
      }
    } else {
      showToast('error', 'Import failed', parsed.error ?? 'This file is not a valid EP-2350 config.json.');
    }
  };

  const handleExportJson = () => {
    if (keepEditedPackAsCopy()) {
      showToast('success', 'Exported', 'A copy of this pack is now in YOUR PACKS.');
    }
    const jsonStr = serializeToConfigJson(pack);
    const files = [...new Set(customSampleSlots(pack).map((s) => s.file))];
    const loadedFiles = files.filter((f) => sampleLibrary[f]);
    let blob: Blob;
    let fileName: string;
    if (loadedFiles.length > 0) {
      // config.json plus the WAVs it names: copy everything in the zip to the root of the fx-mic disk
      const zip = createZip([
        { name: 'config.json', data: new TextEncoder().encode(jsonStr) },
        ...loadedFiles.map((f) => ({ name: f, data: sampleLibrary[f].bytes }))
      ]);
      blob = new Blob([zip as BlobPart], { type: 'application/zip' });
      const slug = pack.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';
      fileName = `${slug}.zip`;
      const missing = files.filter((f) => !sampleLibrary[f]);
      showToast(
        'success',
        'Exported with samples',
        `Unzip and copy config.json and the WAVs to the root of the fx-mic disk.${
          missing.length ? ` Not included (not loaded): ${missing.join(', ')}.` : ''
        }`
      );
    } else {
      blob = new Blob([jsonStr], { type: 'application/json' });
      fileName = 'config.json';
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
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
          selection={selection}
          userPacks={userPacks.map((p) => ({ id: p.id, name: p.pack.name }))}
          onSelectUserPack={selectUserPack}
          onDeleteUserPack={handleDeleteUserPack}
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
                { id: 'samples', label: 'SAMPLES', widthClass: 'w-[76px]', isEdge: false, title: 'Load your own WAVs into the four sample slots' },
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
            ) : rightPanelMode === 'samples' ? (
              <SamplesPanel
                pack={pack}
                library={sampleLibrary}
                activeSampleSlot={activeSampleSlot}
                onSelectSlot={handleSelectSampleSlot}
                onLoadFile={(pos, file) => void handleLoadSampleFile(pos, file)}
                onClearSlot={handleClearSampleSlot}
                onUpdateSlot={handleUpdateSampleSlot}
                onPlaySlot={handlePlaySampleSlot}
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
      {pendingIncoming && !isMultiTabBlocked && (
        <PackConflictDialog
          packName={pendingIncoming.pack.name}
          copyName={pendingIncoming.copyName}
          onReplace={handleConflictReplace}
          onSaveAsCopy={handleConflictSaveAsCopy}
          onCancel={handleConflictCancel}
        />
      )}
    </div>
  );
};
