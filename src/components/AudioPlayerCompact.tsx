import React, { useState, useEffect } from 'react';
import { audioEngine, type InputMode } from '../dsp/AudioEngine';
import { Play, Square, Mic } from 'lucide-react';
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
      className={`w-[275px] h-[86px] te-hardware-chassis ${
        isTing ? 'bg-[#dbd0b9]' : 'bg-[#dbdddb]'
      } p-2.5 flex flex-col justify-between select-none relative z-10 ${className}`}
    >
      {/* Top status & screw header */}
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5">
          {/* LED indicator */}
          <div
            className={`w-2 h-2 rounded-full border ${
              isTing ? 'border-[#00503a]' : 'border-black'
            } ${
              isPlaying
                ? 'bg-[#ff3b30] shadow-[0_0_5px_#ff3b30]'
                : isTing
                ? 'bg-[#003828]'
                : 'bg-[#2b3034]'
            }`}
          />
          <span
            className={`font-mono text-[9px] font-bold ${
              isTing ? 'text-[#00503a]' : 'text-[#141617]'
            } tracking-wider uppercase`}
          >
            AUDITION MODULE
          </span>
        </div>
        <div
          className={`flex items-center border ${
            isTing ? 'border-[#00503a] bg-[#ece6d9]' : 'border-[#141617] bg-[#eceeed]'
          } rounded-none overflow-hidden`}
          role="group"
          aria-label="Audition input source"
        >
          <button
            type="button"
            onClick={() => handleSelectMode('sample')}
            className={`px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-tight uppercase cursor-pointer transition-colors ${
              inputMode === 'sample'
                ? isTing
                  ? 'bg-[#00503a] text-white'
                  : 'bg-[#141617] text-white'
                : isTing
                ? 'text-[#5b695e] hover:text-[#00503a]'
                : 'text-[#73787a] hover:text-[#141617]'
            }`}
            title="Use built-in vocal speech loop"
          >
            SPEECH
          </button>
          <button
            type="button"
            onClick={() => handleSelectMode('mic')}
            className={`px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-tight uppercase cursor-pointer transition-colors flex items-center gap-0.5 border-l ${
              isTing ? 'border-[#00503a]' : 'border-[#141617]'
            } ${
              inputMode === 'mic'
                ? 'bg-[#f15a22] text-white'
                : isTing
                ? 'text-[#5b695e] hover:text-[#00503a]'
                : 'text-[#73787a] hover:text-[#141617]'
            }`}
            title="Use live microphone input"
          >
            <Mic className="w-2.5 h-2.5" />
            <span>LIVE MIC</span>
          </button>
        </div>
      </div>

      {/* Recessed Mechanical Socket Cavity */}
      <div
        className={`${
          isTing ? 'bg-[#003828] border-[#00503a]' : 'bg-[#141617] border-[#000000]'
        } p-1 border`}
      >
        <button
          onClick={togglePlayback}
          className={`w-full h-9 text-[10.5px] font-mono font-bold tracking-wider transition-all duration-75 cursor-pointer flex items-center justify-center gap-2 border ${
            isTing ? 'border-[#00281c]' : 'border-[#000000]'
          } ${
            isPlaying
              ? 'bg-[#f15a22] text-white'
              : `${
                  isTing
                    ? 'bg-[#00503a] hover:bg-[#00664a]'
                    : 'bg-[#232424] hover:bg-[#353839]'
                } text-white`
          }`}
          title={
            isPlaying
              ? 'Stop audition playback'
              : inputMode === 'mic'
              ? 'Audition preset with live microphone input'
              : 'Audition preset with speech sample'
          }
        >
          {isPlaying ? (
            <>
              <Square className="w-3.5 h-3.5 fill-current text-white" />
              <span className="tracking-widest">
                {inputMode === 'mic' ? 'STOP LIVE MIC' : 'STOP AUDITION'}
              </span>
            </>
          ) : (
            <>
              {inputMode === 'mic' ? (
                <Mic className="w-3.5 h-3.5 text-white" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current text-white" />
              )}
              <span className="tracking-widest">
                {inputMode === 'mic' ? 'AUDITION (LIVE MIC)' : 'AUDITION (SPEECH)'}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

