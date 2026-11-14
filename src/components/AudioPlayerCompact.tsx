import React, { useState, useEffect } from 'react';
import { audioEngine, type InputMode } from '../dsp/AudioEngine';
import { Play, Square } from 'lucide-react';
import { ThemeMode } from '../types/config';

interface AudioPlayerCompactProps {
  theme?: ThemeMode;
  className?: string;
}

export const AudioPlayerCompact: React.FC<AudioPlayerCompactProps> = ({ theme = 'fx', className = '' }) => {
  const isTing = theme === 'ting';
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
      className={`w-[275px] relative z-10 flex flex-col items-end gap-2.5 pt-1 pr-[24px] select-none ${className}`}
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
          className={`te-btn-3d h-[22px] w-[68px] px-1.5 flex items-center gap-1 font-mono text-[8.5px] font-bold tracking-wider uppercase cursor-pointer ${
            isTing
              ? 'bg-[#ece6d9] text-[#00503a]'
              : 'bg-[#e4e5e4] text-[#141617]'
          } ${
            inputMode === 'sample'
              ? 'te-btn-3d--pressed z-0'
              : 'z-10 hover:brightness-105'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full border shrink-0 ${
              inputMode === 'sample'
                ? 'bg-[#f15a22] border-[#141617]'
                : isTing
                ? 'bg-transparent border-[#5b695e]'
                : 'bg-transparent border-[#73787a]'
            }`}
          />
          <span>SAMPLE</span>
        </button>
        <button
          type="button"
          onClick={() => handleSelectMode('mic')}
          aria-pressed={inputMode === 'mic'}
          title="Use live microphone input"
          className={`te-btn-3d h-[22px] w-[50px] px-1.5 flex items-center gap-1 font-mono text-[8.5px] font-bold tracking-wider uppercase cursor-pointer ${
            isTing
              ? 'bg-[#ece6d9] text-[#00503a]'
              : 'bg-[#e4e5e4] text-[#141617]'
          } ${
            inputMode === 'mic'
              ? 'te-btn-3d--pressed z-0'
              : 'z-10 hover:brightness-105'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full border shrink-0 ${
              inputMode === 'mic'
                ? 'bg-[#f15a22] border-[#141617]'
                : isTing
                ? 'bg-transparent border-[#5b695e]'
                : 'bg-transparent border-[#73787a]'
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
        className={`te-btn-3d te-btn-3d--pressable h-[22px] w-[68px] mr-[3px] flex items-center justify-center gap-1.5 font-mono text-[8.5px] font-bold tracking-widest uppercase cursor-pointer ${
          isPlaying
            ? 'te-btn-3d--orange te-btn-3d--pressed bg-[#f15a22] text-white'
            : `te-btn-3d--dark ${
                isTing
                  ? 'bg-[#00503a] hover:bg-[#00664a]'
                  : 'bg-[#141617] hover:bg-[#232628]'
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

