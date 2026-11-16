import React, { useMemo, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import type { ThemeMode } from '../types/config';
import { SKILL_NAME } from '../skill/skillDoc';
import { DEFAULT_PUBLIC_APP_URL } from '../utils/presetUrl';

interface SkillPanelProps {
  theme?: ThemeMode;
}

function resolveAppBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    try {
      const resolved = new URL('./', window.location.href).href.replace(/\/+$/, '');
      if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
        return resolved;
      }
    } catch {
      // Fallback to default public app URL
    }
  }
  return DEFAULT_PUBLIC_APP_URL;
}

const STEPS = [
  ['DESCRIBE', 'Tell your AI the sound you want.'],
  ['GET A LINK', 'It writes the preset, checks it and gives you a link.'],
  ['LISTEN', 'Open the link to hear it and tweak it here.'],
  ['UPLOAD', 'Send it to your EP-2350 over USB-C.']
] as const;

export const SkillPanel: React.FC<SkillPanelProps> = ({ theme = 'fx' }) => {
  const isTing = theme === 'ting';
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const appUrl = useMemo(() => resolveAppBaseUrl(), []);
  // One-link entry points published next to the app: skill.md to paste into any chat, and the
  // .well-known/agent-skills/ discovery index that `npx skills add <app URL>` installs from.
  const shortSkillUrl = `${appUrl}/skill.md`;
  const installCmd = `npx skills add ${appUrl}`;
  const zipHref = `./skill/${SKILL_NAME}.zip`;

  const handleCopy = async (id: string, text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedId(id);
        window.setTimeout(() => {
          setCopiedId((prev) => (prev === id ? null : prev));
        }, 1800);
      }
    } catch {
      // Ignore clipboard permission errors in restricted contexts
    }
  };

  const headingText = isTing ? 'text-[#00503a]' : 'text-[#141617]';
  const mutedText = isTing ? 'text-[#5b695e]' : 'text-[#73787a]';
  const cardClass = `te-card-3d w-full border ${
    isTing ? 'border-[#00503a] bg-[#f7f5ef]' : 'border-[#141617] bg-white'
  } p-3 flex flex-col gap-2 relative rounded-none`;
  const cardHeaderBorder = isTing ? 'border-[#d8ceba]' : 'border-[#eceeed]';
  const codeClass = `flex-1 min-w-0 h-[26px] px-2 flex items-center font-mono text-[9.5px] truncate select-text border ${
    isTing ? 'bg-[#ece6d9] text-[#003828] border-[#00503a]/30' : 'bg-[#f8f9f8] text-[#141617] border-[#141617]/20'
  }`;
  const actionClass = `te-btn-3d te-btn-3d--pressable te-btn-3d--dark shrink-0 h-[26px] w-[96px] flex items-center justify-center gap-1.5 font-mono text-[8.5px] font-bold tracking-widest uppercase cursor-pointer text-white ${
    isTing ? 'bg-[#00503a] hover:bg-[#00664a]' : 'bg-[#141617] hover:bg-[#232628]'
  }`;

  const cardHeader = (num: string, title: string) => (
    <div className={`flex items-center gap-2 border-b ${cardHeaderBorder} pb-1.5`}>
      <span className="font-mono text-[10px] font-bold text-[#f15a22]">{num}.</span>
      <span className={`font-bold text-[12px] uppercase tracking-tight ${headingText}`}>{title}</span>
    </div>
  );

  const installRow = (
    id: string,
    label: string,
    value: string,
    action: React.ReactNode
  ) => (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2" data-testid={id}>
      <span className={`sm:w-[112px] shrink-0 font-mono text-[9px] font-bold uppercase tracking-wider ${headingText}`}>
        {label}
      </span>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <code className={codeClass} title={value}>
          {value}
        </code>
        {action}
      </div>
    </div>
  );

  const copyButton = (id: string, text: string) => {
    const isDone = copiedId === id;
    return (
      <button type="button" onClick={() => void handleCopy(id, text)} className={actionClass}>
        {isDone ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        <span>{isDone ? 'COPIED' : 'COPY'}</span>
      </button>
    );
  };

  return (
    <div className="te-bevel-frame w-full">
      <div
        className="te-ledger-card w-full flex flex-col select-none overflow-hidden h-[626px] relative z-10"
        data-testid="skill-md-panel"
      >
        {/* 1. TOP HEADER TAB: same structure and size as the PresetLedger header */}
        <div
          className={`relative ${
            isTing ? 'bg-[#00503a] border-b border-[#00281c]' : 'bg-[#f15a22] border-b border-[#141617]'
          } text-white px-4 py-2 border-t border-white/25 flex items-center justify-between gap-3 shrink-0`}
          data-testid="skill-md-header"
        >
          <div className="absolute -right-[12px] top-0 bottom-0 w-[12px] overflow-hidden pointer-events-none hidden sm:block">
            <svg className="w-full h-full" viewBox="0 0 12 40" preserveAspectRatio="none">
              <polygon
                points="0,0 12,12 12,40 0,40"
                fill={isTing ? '#003828' : '#d14612'}
                stroke={isTing ? '#00281c' : '#141617'}
                strokeWidth="1"
              />
            </svg>
          </div>

          {/* Name plate, matching the preset selector's plate */}
          <div className="flex items-start shrink-0 pb-[3px]">
            <div
              className={`h-[22px] translate-y-[3px] px-2.5 flex items-center font-mono font-bold text-[10.5px] tracking-wider uppercase border whitespace-nowrap ${
                isTing
                  ? 'bg-[#dbd0b9] text-[#00503a] border-[#00503a]'
                  : 'bg-[#dbdddb] text-[#141617] border-[#141617]'
              }`}
            >
              AI SOUND DESIGNER
            </div>
          </div>

          {/* Matches the preset comment field */}
          <div className="bg-black/25 text-white/95 px-2.5 py-1 font-mono text-[10px] tracking-wide border border-white/25 flex-1 min-w-[140px] truncate">
            A skill that teaches any AI to design EP-2350 presets
          </div>
        </div>

        {/* 2. BODY: same canvas as the FX chain */}
        <div className={`flex-1 min-h-0 overflow-y-auto p-3 ${isTing ? 'bg-[#f4f1ea]' : 'bg-[#eceeed]'} flex flex-col gap-3`}>
          <section className={cardClass} data-testid="skill-how-it-works">
            {cardHeader('01', 'HOW IT WORKS')}
            <ol className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="flex items-start gap-2">
                  <span
                    className={`te-btn-3d shrink-0 w-[22px] h-[22px] flex items-center justify-center font-mono text-[9px] font-bold ${
                      isTing ? 'bg-[#ece6d9] text-[#00503a]' : 'bg-[#e4e5e4] text-[#141617]'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="flex flex-col">
                    <span className={`font-mono text-[9.5px] font-bold uppercase tracking-wider ${headingText}`}>
                      {title}
                    </span>
                    <span className={`font-mono text-[9.5px] leading-snug ${mutedText}`}>{text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className={cardClass} data-testid="skill-how-to-install">
            {cardHeader('02', 'HOW TO INSTALL')}
            <p className={`font-mono text-[9.5px] leading-snug ${mutedText}`}>
              Pick one. Works with Claude, ChatGPT, Gemini, Codex, Cursor and other AI tools.
            </p>
            <div className="flex flex-col gap-2.5 pt-0.5">
              {installRow('skill-short-url', 'PASTE IN CHAT', shortSkillUrl, copyButton('short-url', shortSkillUrl))}
              {installRow('skill-install-cmd', 'INSTALL IN AGENT', installCmd, copyButton('install-cmd', installCmd))}
              {installRow(
                'skill-zip',
                'UPLOAD ZIP',
                `${SKILL_NAME}.zip`,
                <a href={zipHref} download={`${SKILL_NAME}.zip`} className={actionClass}>
                  <Download className="w-3 h-3" />
                  <span>DOWNLOAD</span>
                </a>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
