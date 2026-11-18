import React, { useRef, useState } from 'react';
import { Play, Upload, RotateCcw } from 'lucide-react';
import type { PackConfig, PlayMode, ThemeMode } from '../types/config';
import { themeColor } from '../theme/tokens';
import { Knob } from './Knob';
import { Tooltip } from './Tooltip';
import type { StoredSample } from '../utils/sampleStore';
import {
  SAMPLE_SLOTS,
  customSampleAt,
  diskUsage,
  formatBytes
} from '../utils/samples';

/** A WAV loaded in this browser: the file for the disk, and its original when it was fitted. */
export type LoadedSample = StoredSample;

interface SamplesPanelProps {
  pack: PackConfig;
  /** WAV files loaded in this browser, by file name. */
  library: Record<string, LoadedSample>;
  activeSampleSlot: number;
  onSelectSlot: (pos: number) => void;
  onLoadFile: (pos: number, file: File) => void;
  onClearSlot: (pos: number) => void;
  onUpdateSlot: (pos: number, patch: { playmode?: PlayMode; duck?: number | undefined }) => void;
  /** Press (down) and release the sample button for slot `pos`. */
  onPlaySlot: (pos: number, down: boolean) => void;
  theme?: ThemeMode;
}

const PLAYMODES: Array<{ id: PlayMode; label: string; title: string }> = [
  { id: 'oneshot', label: 'ONESHOT', title: 'plays the whole sample once' },
  { id: 'hold', label: 'HOLD', title: 'plays while the button is held' },
  { id: 'startstop', label: 'START/STOP', title: 'loops from one press to the next' }
];

/** LEDs per row on the DISK meter; each lights for 1/12 of the disk. */
export const DISK_LEDS = 12;

/** How many of the 12 LEDs light for `used` of `budget` bytes (any use lights the first one). */
export const litLeds = (used: number, budget: number) =>
  used <= 0 ? 0 : Math.min(DISK_LEDS, Math.ceil((used / budget) * DISK_LEDS));

export const SamplesPanel: React.FC<SamplesPanelProps> = ({
  pack,
  library,
  activeSampleSlot,
  onSelectSlot,
  onLoadFile,
  onClearSlot,
  onUpdateSlot,
  onPlaySlot,
  theme = 'fx'
}) => {
  const isTing = theme === 'ting';
  const fileInputs = useRef<Array<HTMLInputElement | null>>([]);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const sizes = Object.fromEntries(Object.entries(library).map(([name, s]) => [name, s.bytes.byteLength]));
  const usage = diskUsage(pack, sizes);
  const lit = litLeds(usage.totalBytes, usage.budgetBytes);

  const btnClass =
    'te-btn-3d te-btn-3d--pressable h-[22px] px-2 flex items-center justify-center gap-1 font-mono text-te-xs font-bold tracking-wider uppercase cursor-pointer bg-te-control text-te-ink hover:brightness-105';
  // Same look as the mic's PLAY button (AudioPlayerCompact)
  const playBtnClass =
    'te-btn-3d te-btn-3d--pressable te-btn-3d--dark h-[22px] px-2 flex items-center justify-center gap-1.5 font-mono text-te-xs font-bold tracking-widest uppercase cursor-pointer bg-te-ink hover:bg-te-ink-hover text-white';
  const arrowClass =
    'te-btn-3d te-btn-3d--pressable w-[22px] h-[22px] flex items-center justify-center cursor-pointer z-10 hover:brightness-105 bg-te-control text-te-ink disabled:opacity-35 disabled:pointer-events-none';
  const fieldLabel = 'text-te-xs font-te-bold tracking-wider text-te-muted uppercase leading-none';

  const renderSlot = (pos: number) => {
    const slot = customSampleAt(pack, pos);
    const loaded = slot ? library[slot.file] : undefined;
    const state = !slot ? 'factory' : loaded ? 'custom' : 'missing';
    const isFactory = state === 'factory';
    // What the preview plays a factory slot with; the mic's factory sounds take no settings
    const playmode: PlayMode = slot
      ? slot.playmode
      : pack.useBuiltInSamples
      ? pack.samples.find((s) => s.pos === pos)?.playmode ?? 'oneshot'
      : 'oneshot';
    const modeIdx = Math.max(0, PLAYMODES.findIndex((m) => m.id === playmode));
    const stepMode = (dir: 1 | -1) =>
      onUpdateSlot(pos, { playmode: PLAYMODES[(modeIdx + dir + PLAYMODES.length) % PLAYMODES.length].id });
    const factoryHint = 'Factory sounds take no settings: load a WAV to set them.';
    // WAVs the mic cannot take are converted on load, so the only note left is a file not loaded here
    const note =
      state === 'missing'
        ? 'Not loaded in this browser: the mic plays it if the file is on its disk, otherwise the factory sound.'
        : undefined;

    return (
      <section
        key={pos}
        className={`te-card-3d w-full border border-te-ink bg-te-surface p-3 flex flex-col gap-2 relative rounded-none ${
          dragOver === pos ? 'outline outline-2 outline-te-accent' : ''
        }`}
        data-testid={`sample-slot-${pos}`}
        data-state={state}
        data-selected={pos === activeSampleSlot ? 'true' : undefined}
        onClick={() => onSelectSlot(pos)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(pos);
        }}
        onDragLeave={() => setDragOver((d) => (d === pos ? null : d))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(null);
          const file = e.dataTransfer.files?.[0];
          if (file) onLoadFile(pos, file);
        }}
      >
        {/* Header: number, sound name and size; FACTORY appears on the left of LOAD WAV / PLAY, which never move */}
        <div className="flex items-center justify-between border-b border-te-rule pb-1.5 gap-2">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-mono text-te-sm font-bold text-te-accent">{`0${pos + 1}`}.</span>
            <span
              className={`font-te-bold text-te-md tracking-tight truncate ${isFactory ? 'uppercase text-te-muted' : 'text-te-ink'}`}
              data-testid="sample-name"
            >
              {isFactory ? 'Factory sound' : slot!.file}
            </span>
            {loaded && (
              <span
                className="font-mono text-te-xs font-bold text-te-muted shrink-0"
                data-testid="sample-size"
                data-fitted={loaded.notes?.length ? 'true' : undefined}
                title={loaded.notes?.length ? `Made smaller to fit the disk: ${loaded.notes.join(', ')}` : undefined}
              >
                {formatBytes(loaded.bytes.byteLength)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!isFactory && (
              <button
                type="button"
                className={btnClass}
                title="Give this slot back its factory sound"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearSlot(pos);
                }}
              >
                <RotateCcw className="w-3 h-3" />
                FACTORY
              </button>
            )}
            <button
              type="button"
              className={btnClass}
              title="Load a WAV into this slot (or drop one on the card)"
              onClick={(e) => {
                e.stopPropagation();
                fileInputs.current[pos]?.click();
              }}
            >
              <Upload className="w-3 h-3" />
              LOAD WAV
            </button>
            <button
              type="button"
              className={playBtnClass}
              title="Play this slot through the current preset"
              aria-label={`Play slot ${pos + 1}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                onPlaySlot(pos, true);
              }}
              onPointerUp={() => onPlaySlot(pos, false)}
              onPointerLeave={(e) => {
                if (e.buttons) onPlaySlot(pos, false);
              }}
            >
              <Play className="w-2.5 h-2.5 fill-current text-white" />
              PLAY
            </button>
            <input
              ref={(el) => {
                fileInputs.current[pos] = el;
              }}
              type="file"
              accept=".wav,audio/wav,audio/x-wav,audio/wave"
              className="hidden"
              data-testid={`sample-file-${pos}`}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onLoadFile(pos, file);
              }}
            />
          </div>
        </div>

        {/* Controls: duck knob, then the playmode switch; disabled for factory sounds */}
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2 pt-1.5" onClick={(e) => e.stopPropagation()}>
          <Knob
            label="DUCK MIC"
            value={typeof slot?.duck === 'number' ? slot.duck : 0}
            min={0}
            max={1}
            step={0.05}
            displayScale={(v) => (v <= 0 ? 'OFF' : `${Math.round(v * 100)}%`)}
            onChange={(v) => onUpdateSlot(pos, { duck: v })}
            onReset={() => onUpdateSlot(pos, { duck: undefined })}
            accentColor={themeColor('accent', isTing)}
            size={36}
            inactive={!isFactory && typeof slot?.duck !== 'number'}
            disabled={isFactory}
            hint={
              isFactory
                ? factoryHint
                : 'Turns the mic down while this sample plays. Needs firmware 1.0.9 or newer.'
            }
          />
          <div
            className={`flex flex-col items-center gap-[7px] pt-0.5 ${isFactory ? 'opacity-35' : ''}`}
            title={isFactory ? factoryHint : `Playmode: ${PLAYMODES[modeIdx].title}`}
          >
            <span className={fieldLabel}>PLAYMODE</span>
            <div className="flex items-start pb-[3px]" role="group" aria-label={`Slot ${pos + 1} playmode`}>
              <button
                type="button"
                className={arrowClass}
                disabled={isFactory}
                aria-label="Previous playmode"
                onClick={() => stepMode(-1)}
              >
                <svg viewBox="0 0 8 8" className="w-2 h-2 fill-current" aria-hidden="true">
                  <polygon points="6,1 2,4 6,7" />
                </svg>
              </button>
              <div
                className="h-[22px] w-[104px] translate-y-[3px] px-2 flex items-center justify-center font-mono font-bold text-te-xs tracking-wider uppercase border-y z-0 whitespace-nowrap bg-te-bevel text-te-ink border-te-ink"
                data-testid="sample-playmode"
              >
                {PLAYMODES[modeIdx].label}
              </div>
              <button
                type="button"
                className={arrowClass}
                disabled={isFactory}
                aria-label="Next playmode"
                onClick={() => stepMode(1)}
              >
                <svg viewBox="0 0 8 8" className="w-2 h-2 fill-current" aria-hidden="true">
                  <polygon points="2,1 6,4 2,7" />
                </svg>
              </button>
            </div>
          </div>
          {note && (
            <p
              className="flex-1 min-w-[180px] self-center font-mono text-te-xs leading-snug text-te-muted"
              data-testid="sample-missing"
            >
              {note}
            </p>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="te-bevel-frame w-full">
      <div
        className="te-ledger-card w-full flex flex-col select-none overflow-hidden h-auto sm:h-[626px] relative z-10"
        data-testid="samples-panel"
      >
        {/* 1. Header tab, as on the FX board */}
        <div
          className="relative bg-te-header border-b text-white px-4 py-2 border-t border-white/25 flex items-center justify-between gap-3 shrink-0"
          data-testid="samples-header"
        >
          <div className="absolute -right-[12px] top-0 bottom-0 w-[12px] overflow-hidden pointer-events-none hidden sm:block">
            <svg className="w-full h-full" viewBox="0 0 12 40" preserveAspectRatio="none">
              <polygon
                points="0,0 12,12 12,40 0,40"
                fill={themeColor('header-deep', isTing)}
                stroke={themeColor('ink-deep', isTing)}
                strokeWidth="1"
              />
            </svg>
          </div>
          <h2 className="h-[25px] flex items-center font-mono font-bold text-te-sm tracking-wider uppercase">SAMPLES</h2>
        </div>

        {/* 2. DISK strip: same grey strip and height as the FX board's bus selector */}
        <div
          className="bg-te-strip border-b border-te-ink grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3 px-4 py-2 shrink-0"
          data-testid="sample-disk"
          title={
            usage.fits
              ? "The mic's disk holds 1,000 KB (250 blocks of 4 KB) for config.json and all four WAVs; every file takes whole blocks."
              : `${formatBytes(usage.totalBytes - usage.budgetBytes)} over: shorten a sample, make it mono or lower its sample rate.`
          }
        >
          {/* Equal side columns keep the LED screen centred whatever the label widths */}
          <span className="justify-self-end font-mono text-te-xs font-bold tracking-wider uppercase text-te-ink">DISK</span>
          <div className="h-[39px] flex items-center justify-center">
            <div
              className="bg-te-ink border border-te-ink-deep px-[6px] py-[5px] flex flex-col gap-[3px]"
              role="meter"
              aria-label="Disk space used"
              aria-valuemin={0}
              aria-valuemax={usage.budgetBytes}
              aria-valuenow={usage.totalBytes}
              data-lit={lit}
              data-over={usage.fits ? undefined : 'true'}
            >
              {[0, 1].map((row) => (
                <div key={row} className="flex gap-[3px]">
                  {Array.from({ length: DISK_LEDS }, (_, i) => (
                    <span
                      key={i}
                      className={`w-[8px] h-[6px] ${
                        i < lit
                          ? `${usage.fits ? 'bg-te-accent' : 'bg-te-accent animate-pulse'} shadow-[0_0_3px_rgb(var(--te-accent)/0.8)]`
                          : 'bg-white/10'
                      }`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="justify-self-start">
          <Tooltip label={`config.json ${formatBytes(usage.configBytes)} + WAVs ${formatBytes(usage.sampleBytes)}`}>
            <span
              className={`font-mono text-te-xs font-bold tracking-wider whitespace-nowrap ${
                usage.fits ? 'text-te-ink' : 'text-te-accent-deep'
              }`}
              data-testid="sample-disk-total"
            >
              {formatBytes(usage.totalBytes)} / 1 MB
            </span>
          </Tooltip>
          </div>
        </div>

        {/* 3. Slots, full width like effect cards */}
        <div className="flex-1 min-h-0 sm:overflow-y-auto p-3 bg-te-canvas flex flex-col gap-3">
          {Array.from({ length: SAMPLE_SLOTS }, (_, pos) => renderSlot(pos))}
        </div>
      </div>
    </div>
  );
};
