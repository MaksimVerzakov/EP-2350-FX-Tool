import React, { useState, useEffect } from 'react';
import { audioEngine, type InputMode } from '../dsp/AudioEngine';
import { Play, Square } from 'lucide-react';
import { ThemeMode } from '../types/config';

interface AudioPlayerCompactProps {
  theme?: ThemeMode;
  className?: string;
}

export const AudioPlayerCompact: React.FC<AudioPlayerCompactProps> = ({ className = '' }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>(() => audioEngine.getInputMode());

  // Sync state if audio stopped or input mode changed externally
  useEffect(() => {
    const interval = setInterval(() => {
      const running = audioEngine.getIsRunning();
      if (running !== isPlaying) {
        setIsPlaying(running);
      }
      const currentMode = audioEngine.getInputMode();
      if (currentMode !== inputMode) {
        setInputMode(currentMode);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [isPlaying, inputMode]);

  const togglePlayback = () => {
    const running = audioEngine.togglePlay();
    setIsPlaying(running);
    setInputMode(audioEngine.getInputMode());
  };

  const handleSelectMode = async (mode: InputMode) => {
    setInputMode(mode);
    await audioEngine.setInputMode(mode);
    setInputMode(audioEngine.getInputMode());
    setIsPlaying(audioEngine.getIsRunning());
  };

  return (
    <div
      className={`w-[275px] relative -left-[3px] -top-[3px] z-10 flex flex-col items-end gap-[24px] pr-[24px] select-none ${className}`}
    >
      {/* Floating PROJECT / SYSTEM style joined 3D switch */}
      <div
        className="flex items-start"
        role="group"
        aria-label="Audition input source"
      >
        <button
          type="button"
          onClick={() => handleSelectMode('sample')}
          aria-pressed={inputMode === 'sample'}
          title="Use built-in vocal speech loop"
          className={`te-btn-3d h-[26px] w-[51px] px-[5px] flex items-center gap-[3px] font-mono text-te-xs font-bold tracking-normal uppercase cursor-pointer ${
            'bg-te-control text-te-ink'
          } ${
            inputMode === 'sample'
              ? 'te-btn-3d--pressed z-0'
              : 'z-10 hover:brightness-105'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full border shrink-0 ${
              inputMode === 'sample'
                ? 'bg-te-accent border-te-edge'
                : 'bg-transparent border-te-muted'
            }`}
          />
          <span>SAMPLE</span>
        </button>
        <button
          type="button"
          onClick={() => handleSelectMode('mic')}
          aria-pressed={inputMode === 'mic'}
          title="Use live microphone input"
          className={`te-btn-3d h-[26px] w-[50px] px-[5px] flex items-center justify-center gap-[3px] font-mono text-te-xs font-bold tracking-normal uppercase cursor-pointer ${
            'bg-te-control text-te-ink'
          } ${
            inputMode === 'mic'
              ? 'te-btn-3d--pressed z-0'
              : 'z-10 hover:brightness-105'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full border shrink-0 ${
              inputMode === 'mic'
                ? 'bg-te-accent border-te-edge'
                : 'bg-transparent border-te-muted'
            }`}
          />
          <span>MIC</span>
        </button>
      </div>

      {/* Floating separate EP Sample Tool 3D PLAY button */}
      <button
        type="button"
        onClick={togglePlayback}
        aria-pressed={isPlaying}
        title={
          isPlaying
            ? 'Stop audition playback'
            : inputMode === 'mic'
            ? 'Audition preset with live microphone input'
            : 'Audition preset with speech sample'
        }
        className={`te-btn-3d te-btn-3d--pressable h-[26px] w-[76px] flex items-center justify-center gap-1.5 font-mono text-te-xs font-bold tracking-widest uppercase cursor-pointer ${
          isPlaying
            ? 'te-btn-3d--orange te-btn-3d--pressed bg-te-accent text-white'
            : `te-btn-3d--dark ${
                'bg-te-ink hover:bg-te-ink-hover'
              } text-white`
        }`}
      >
        {isPlaying ? (
          <>
            <Square className="w-2.5 h-2.5 fill-current text-white" />
            <span>STOP</span>
          </>
        ) : (
          <>
            <Play className="w-2.5 h-2.5 fill-current text-white" />
            <span>PLAY</span>
          </>
        )}
      </button>
    </div>
  );
};

