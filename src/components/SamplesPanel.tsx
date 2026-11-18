import React, { useRef, useState } from 'react';
import { Play, Upload, RotateCcw } from 'lucide-react';
import type { PackConfig, PlayMode, ThemeMode } from '../types/config';
import { themeColor } from '../theme/tokens';
import { Knob } from './Knob';
import {
  type WavInfo,
  SAMPLE_SLOTS,
  customSampleAt,
  describeWav,
  diskUsage,
  formatBytes,
  wavDeviceIssues
} from '../utils/samples';

export interface LoadedSample {
  bytes: Uint8Array;
  info: WavInfo;
}

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
  { id: 'oneshot', label: 'ONESHOT', title: 'Plays the whole sample once' },
  { id: 'hold', label: 'HOLD', title: 'Plays while the button is held' },
  { id: 'startstop', label: 'START/STOP', title: 'Loops from one press to the next' }
];

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
  const usedPct = Math.min(100, (usage.totalBytes / usage.budgetBytes) * 100);
  const configPct = Math.min(100, (usage.configBytes / usage.budgetBytes) * 100);

  const cardClass = 'te-card-3d w-full border border-te-ink bg-te-surface p-3 flex flex-col gap-2 relative rounded-none';
  const mutedText = 'font-mono text-te-xs leading-snug text-te-muted';
  const btnClass =
    'te-btn-3d te-btn-3d--pressable h-[24px] px-2 flex items-center justify-center gap-1 font-mono text-te-xs font-bold tracking-wider uppercase cursor-pointer bg-te-control text-te-ink hover:brightness-105';

  const cardHeader = (num: string, title: string, right?: React.ReactNode) => (
    <div className="flex items-center gap-2 border-b border-te-rule pb-1.5 min-w-0">
      <span className="font-mono text-te-sm font-bold text-te-accent">{num}.</span>
      <span className="font-te-bold text-te-md uppercase tracking-tight text-te-ink shrink-0">{title}</span>
      <span className="flex-1" />
      {right}
    </div>
  );

  const renderSlot = (pos: number) => {
    const slot = customSampleAt(pack, pos);
    const loaded = slot ? library[slot.file] : undefined;
    const issues = loaded ? wavDeviceIssues(loaded.info) : [];
    const isActive = pos === activeSampleSlot;
    const state = !slot ? 'factory' : loaded ? 'custom' : 'missing';

    return (
      <section
        key={pos}
        className={`${cardClass} ${dragOver === pos ? 'outline outline-2 outline-te-accent' : ''}`}
        data-testid={`sample-slot-${pos}`}
        data-state={state}
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
        {cardHeader(
          `0${pos + 1}`,
          `SLOT ${pos + 1}`,
          <span
            className={`min-w-0 truncate font-mono text-te-xs font-bold px-1.5 py-[1px] border ${
              state === 'factory' ? 'border-te-muted text-te-muted' : 'border-te-ink text-te-ink'
            } ${isActive ? 'bg-te-accent text-white border-te-ink' : ''}`}
            title={isActive ? 'Selected on the mic' : undefined}
          >
            {state === 'factory' ? 'FACTORY' : slot!.file}
          </span>
        )}

        {state === 'factory' && (
          <p className={mutedText}>Factory sound. The preview plays a demo sound. Load or drop a WAV to replace it.</p>
        )}
        {state === 'missing' && (
          <p className={mutedText} data-testid="sample-missing">
            {slot!.file} is not loaded in this browser. The mic plays it if the file is already on its disk, otherwise
            the factory sound.
          </p>
        )}
        {loaded && (
          <div className="flex flex-col gap-0.5">
            <p className="font-mono text-te-xs text-te-ink" data-testid="sample-info">
              {describeWav(loaded.info)} · {formatBytes(loaded.bytes.byteLength)}
            </p>
            {issues.map((issue) => (
              <p key={issue} className="font-mono text-te-xs leading-snug text-te-accent-deep" role="alert">
                {issue}
              </p>
            ))}
          </div>
        )}

        {slot && (
          <div className="flex items-end justify-between gap-2 flex-wrap">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-te-xs font-bold tracking-wider text-te-muted">PLAYMODE</span>
              <div className="flex" role="group" aria-label={`Slot ${pos + 1} playmode`}>
                {PLAYMODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={m.title}
                    aria-pressed={slot.playmode === m.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateSlot(pos, { playmode: m.id });
                    }}
                    className={`h-[22px] px-1.5 -ml-px first:ml-0 border border-te-ink font-mono text-te-xs font-bold cursor-pointer ${
                      slot.playmode === m.id ? 'bg-te-ink text-white' : 'bg-te-field text-te-ink hover:bg-te-control'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <Knob
                label="DUCK MIC"
                value={typeof slot.duck === 'number' ? slot.duck : 0}
                min={0}
                max={1}
                step={0.05}
                displayScale={(v) => (v <= 0 ? 'OFF' : `${Math.round(v * 100)}%`)}
                onChange={(v) => onUpdateSlot(pos, { duck: v })}
                onReset={() => onUpdateSlot(pos, { duck: undefined })}
                accentColor={themeColor('accent', isTing)}
                size={30}
                inactive={typeof slot.duck !== 'number'}
                hint="Turns the mic down while this sample plays. Needs firmware 1.0.9 or newer."
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 flex-wrap mt-auto pt-1">
          <button
            type="button"
            className={btnClass}
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
            <Play className="w-3 h-3" />
            PLAY
          </button>
          <button
            type="button"
            className={btnClass}
            onClick={(e) => {
              e.stopPropagation();
              fileInputs.current[pos]?.click();
            }}
          >
            <Upload className="w-3 h-3" />
            {state === 'custom' ? 'REPLACE' : 'LOAD WAV'}
          </button>
          {slot && (
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
      </section>
    );
  };

  return (
    <div className="te-bevel-frame w-full">
      <div
        className="te-ledger-card w-full flex flex-col select-none overflow-hidden h-auto sm:h-[626px] relative z-10"
        data-testid="samples-panel"
      >
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
          <h2 className="h-[25px] flex items-center font-mono font-bold text-te-sm tracking-wider uppercase">
            SAMPLES
          </h2>
        </div>

        <div className="flex-1 min-h-0 sm:overflow-y-auto p-3 bg-te-canvas flex flex-col gap-3">
          <section className={cardClass} data-testid="sample-disk">
            {cardHeader(
              '00',
              'DISK',
              <span
                className={`font-mono text-te-xs font-bold ${usage.fits ? 'text-te-ink' : 'text-te-accent-deep'}`}
                data-testid="sample-disk-total"
              >
                {formatBytes(usage.totalBytes)} / {formatBytes(usage.budgetBytes)}
              </span>
            )}
            <div
              className="relative h-[10px] border border-te-ink bg-te-field overflow-hidden"
              role="meter"
              aria-label="Disk space used"
              aria-valuemin={0}
              aria-valuemax={usage.budgetBytes}
              aria-valuenow={usage.totalBytes}
            >
              <div
                className={`absolute inset-y-0 left-0 ${usage.fits ? 'bg-te-accent' : 'bg-te-accent-deep'}`}
                style={{ width: `${usedPct}%` }}
              />
              <div className="absolute inset-y-0 left-0 bg-te-ink" style={{ width: `${configPct}%` }} />
            </div>
            <p className={mutedText}>
              The mic's disk holds about 1 MB for config.json and all four WAVs.{' '}
              {usage.fits
                ? 'Mono and a lower sample rate make a WAV smaller.'
                : `That is ${formatBytes(usage.totalBytes - usage.budgetBytes)} too much: shorten a sample, make it mono or lower its sample rate.`}
            </p>
          </section>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: SAMPLE_SLOTS }, (_, pos) => renderSlot(pos))}
          </div>
        </div>
      </div>
    </div>
  );
};
