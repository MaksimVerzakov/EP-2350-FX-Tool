import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, FileText } from 'lucide-react';
import type { ThemeMode } from '../types/config';
import { SKILL_NAME, renderSkillMarkdown } from '../skill/skillDoc';
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

export const SkillPanel: React.FC<SkillPanelProps> = ({ theme = 'fx' }) => {
  const isTing = theme === 'ting';
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const appUrl = useMemo(() => resolveAppBaseUrl(), []);
  const skillFolderRel = `./skill/${SKILL_NAME}`;
  const skillZipHref = `${skillFolderRel}.zip`;
  const skillMdHref = `${skillFolderRel}/SKILL.md`;
  const skillZipUrl = `${appUrl}/skill/${SKILL_NAME}.zip`;
  const skillMdUrl = `${appUrl}/skill/${SKILL_NAME}/SKILL.md`;

  const skillMarkdown = useMemo(
    () =>
      renderSkillMarkdown({
        appUrl,
        skillUrl: `${appUrl}/skill/${SKILL_NAME}`,
        version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
      }),
    [appUrl]
  );

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

  const borderInk = isTing ? 'border-[#00503a]' : 'border-[#141617]';
  const subtleBorder = isTing ? 'border-[#00503a]/25' : 'border-[#141617]/20';
  const cardBg = isTing ? 'bg-[#fdfbf7]' : 'bg-[#f8f9f8]';
  const bodyBg = isTing ? 'bg-[#f4f1ea]' : 'bg-[#ffffff]';
  const subBarBg = isTing ? 'bg-[#e4dac5]' : 'bg-[#eceeed]';
  const codeBg = isTing ? 'bg-[#e8e2d3] text-[#003828]' : 'bg-[#eceeed] text-[#141617]';
  const headingText = isTing ? 'text-[#00503a]' : 'text-[#141617]';
  const mutedText = isTing ? 'text-[#425c4e]' : 'text-[#5a6063]';

  const claudeCliCmd = `mkdir -p ~/.claude/skills && curl -fsSL "${skillZipUrl}" -o /tmp/${SKILL_NAME}.zip && unzip -oq /tmp/${SKILL_NAME}.zip -d ~/.claude/skills/`;
  const geminiCliCmd = `mkdir -p ~/.gemini/skills && curl -fsSL "${skillZipUrl}" -o /tmp/${SKILL_NAME}.zip && unzip -oq /tmp/${SKILL_NAME}.zip -d ~/.gemini/skills/`;
  const chatGptPrompt = `Follow the attached EP-2350 Sound Designer SKILL.md (${skillMdUrl}) to write a valid config.json preset for: [describe desired vocal effect]. If Node.js is available, run "node scripts/ep2350.mjs validate config.json" and return the share link; otherwise follow the hand-check list and output config.json.`;

  const renderCopyBtn = (id: string, text: string, label = 'COPY') => {
    const isDone = copiedId === id;
    return (
      <button
        type="button"
        onClick={() => void handleCopy(id, text)}
        className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-wider border ${borderInk} transition-colors cursor-pointer ${
          isDone
            ? 'bg-[#f15a22] text-white'
            : isTing
            ? 'bg-[#00503a] text-white hover:bg-[#00664a]'
            : 'bg-[#141617] text-white hover:bg-[#2a2e30]'
        }`}
        title={`Copy ${label.toLowerCase()} to clipboard`}
      >
        {isDone ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
        <span>{isDone ? 'COPIED' : label}</span>
      </button>
    );
  };

  return (
    <div className="te-bevel-frame w-full">
      <div
        className="te-ledger-card w-full flex flex-col select-none overflow-hidden h-[624px] relative z-10"
        data-testid="skill-md-panel"
      >
        {/* 1. TOP HEADER TAB (Matches PresetLedger header + 45° extruded right binder facet) */}
        <div
          className={`relative ${
            isTing
              ? 'bg-[#00503a] border-b border-[#00281c]'
              : 'bg-[#f15a22] border-b border-[#141617]'
          } text-white px-4 py-2 border-t border-white/25 flex flex-wrap items-center justify-between gap-2 shrink-0`}
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

          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider uppercase border ${
                isTing
                  ? 'bg-[#dbd0b9] text-[#00503a] border-[#00281c]'
                  : 'bg-[#141617] text-white border-black'
              }`}
            >
              <FileText className="w-3 h-3 text-[#f15a22]" />
              <span>SKILL.MD</span>
            </span>
            <span className="font-mono text-[10.5px] font-bold tracking-wider uppercase">
              AI SOUND DESIGNER
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <a
              href={skillZipHref}
              download={`${SKILL_NAME}.zip`}
              className={`inline-flex items-center gap-1 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider border ${
                isTing
                  ? 'bg-[#f7f5ef] text-[#00503a] border-[#00281c] hover:bg-white'
                  : 'bg-white text-[#141617] border-[#141617] hover:bg-[#eceeed]'
              } transition-colors`}
              title="Download ep2350-sound-designer.zip bundle"
            >
              <Download className="w-3 h-3 text-[#f15a22]" />
              <span>.ZIP</span>
            </a>

            <a
              href={skillMdHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider bg-black/25 hover:bg-black/45 text-white border border-white/30 transition-colors"
              title="Open raw SKILL.md in a new tab"
            >
              <ExternalLink className="w-3 h-3" />
              <span>OPEN</span>
            </a>

            <button
              type="button"
              onClick={() => void handleCopy('full-skill-md', skillMarkdown)}
              className={`inline-flex items-center gap-1 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${
                copiedId === 'full-skill-md'
                  ? 'bg-[#141617] text-[#f15a22] border-white'
                  : 'bg-black/35 hover:bg-black/55 text-white border-white/30'
              }`}
              title="Copy complete SKILL.md markdown to clipboard"
            >
              {copiedId === 'full-skill-md' ? (
                <Check className="w-3 h-3" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>{copiedId === 'full-skill-md' ? 'COPIED' : 'COPY MD'}</span>
            </button>
          </div>
        </div>

        {/* 2. HOW THE SKILL WORKS (3-step hardware workflow bar) */}
        <div className={`${subBarBg} border-b ${borderInk} px-4 py-2.5 shrink-0`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className={`font-mono text-[9.5px] font-bold uppercase tracking-wider ${headingText}`}>
              HOW THE SKILL WORKS
            </span>
            <span className={`font-mono text-[8.5px] uppercase tracking-wide ${mutedText}`}>
              SKILL.MD + VALIDATOR CLI + OFFICIAL PACKS · ZERO SERVER SETUP
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className={`${cardBg} border ${subtleBorder} px-2.5 py-1.5`}>
              <div className="font-mono text-[9px] font-bold uppercase text-[#f15a22]">
                01 // LOAD SKILL
              </div>
              <p className={`font-mono text-[8.5px] leading-snug mt-0.5 ${mutedText}`}>
                Give your AI <span className={`font-bold ${headingText}`}>SKILL.md</span> or the{' '}
                <span className={`font-bold ${headingText}`}>.zip</span> bundle (contains effect
                tables, official examples &amp; validator script).
              </p>
            </div>

            <div className={`${cardBg} border ${subtleBorder} px-2.5 py-1.5`}>
              <div className="font-mono text-[9px] font-bold uppercase text-[#f15a22]">
                02 // WRITE &amp; CHECK
              </div>
              <p className={`font-mono text-[8.5px] leading-snug mt-0.5 ${mutedText}`}>
                Describe a sound. The AI writes <span className={`font-bold ${headingText}`}>config.json</span> and verifies constraints via{' '}
                <span className={`font-bold ${headingText}`}>ep2350.mjs validate</span> (or its checklist).
              </p>
            </div>

            <div className={`${cardBg} border ${subtleBorder} px-2.5 py-1.5`}>
              <div className="font-mono text-[9px] font-bold uppercase text-[#f15a22]">
                03 // OPEN &amp; LOAD
              </div>
              <p className={`font-mono text-[8.5px] leading-snug mt-0.5 ${mutedText}`}>
                Click the generated <span className={`font-bold ${headingText}`}>#preset=</span> link
                (or use <span className={`font-bold ${headingText}`}>IMPORT</span>) to audition here &amp; flash over USB-C.
              </p>
            </div>
          </div>
        </div>

        {/* 3. SCROLLABLE SETUP BODY: CLAUDE · CHATGPT · GEMINI */}
        <div className={`flex-1 min-h-0 overflow-y-auto p-3.5 ${bodyBg} flex flex-col gap-2.5`}>
          {/* Hosted SKILL.md URL strip */}
          <div
            className={`${cardBg} border ${borderInk} px-2.5 py-1.5 flex items-center justify-between gap-2`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[8.5px] font-bold uppercase tracking-wider text-[#f15a22] shrink-0">
                SKILL URL
              </span>
              <code
                className={`font-mono text-[9px] px-1.5 py-0.5 truncate select-text ${codeBg}`}
                title={skillMdUrl}
              >
                {skillMdUrl}
              </code>
            </div>
            {renderCopyBtn('skill-url', skillMdUrl, 'COPY URL')}
          </div>

          {/* 01 · CLAUDE */}
          <div className={`${cardBg} border ${borderInk} p-2.5 flex flex-col gap-1.5`}>
            <div className={`flex items-center justify-between border-b ${subtleBorder} pb-1`}>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#f15a22]" />
                <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${headingText}`}>
                  01 // CLAUDE
                </span>
              </div>
              <span className={`font-mono text-[8px] uppercase tracking-wider ${mutedText}`}>
                CLAUDE.AI / DESKTOP · CLAUDE CODE
              </span>
            </div>

            <div className={`font-mono text-[9px] leading-relaxed ${mutedText} space-y-1`}>
              <p>
                <span className={`font-bold ${headingText}`}>CLAUDE APPS (WEB &amp; DESKTOP):</span>{' '}
                Click <span className={`font-bold ${headingText}`}>.ZIP</span> in the header, open{' '}
                <span className={`font-bold ${headingText}`}>Settings → Capabilities → Skills</span>,
                and upload <code className={`px-1 ${codeBg}`}>ep2350-sound-designer.zip</code> as a custom skill.
              </p>
              <p>
                <span className={`font-bold ${headingText}`}>CLAUDE CODE CLI:</span>{' '}
                Unzip into <code className={`px-1 ${codeBg}`}>~/.claude/skills/</code> (global) or{' '}
                <code className={`px-1 ${codeBg}`}>.claude/skills/</code> (repo) so{' '}
                <code className={`px-1 ${codeBg}`}>ep2350-sound-designer/SKILL.md</code> is present.
              </p>
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <code
                className={`flex-1 min-w-0 font-mono text-[8.5px] px-2 py-1 truncate select-text border ${subtleBorder} ${codeBg}`}
                title={claudeCliCmd}
              >
                {claudeCliCmd}
              </code>
              {renderCopyBtn('claude-cmd', claudeCliCmd, 'COPY CMD')}
            </div>
          </div>

          {/* 02 · CHATGPT */}
          <div className={`${cardBg} border ${borderInk} p-2.5 flex flex-col gap-1.5`}>
            <div className={`flex items-center justify-between border-b ${subtleBorder} pb-1`}>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#f15a22]" />
                <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${headingText}`}>
                  02 // CHATGPT
                </span>
              </div>
              <span className={`font-mono text-[8px] uppercase tracking-wider ${mutedText}`}>
                CHATGPT / PROJECTS / CUSTOM GPT · CODEX CLI
              </span>
            </div>

            <div className={`font-mono text-[9px] leading-relaxed ${mutedText} space-y-1`}>
              <p>
                <span className={`font-bold ${headingText}`}>CHATGPT / PROJECTS / CUSTOM GPT:</span>{' '}
                Upload <code className={`px-1 ${codeBg}`}>ep2350-sound-designer.zip</code> (or attach{' '}
                <code className={`px-1 ${codeBg}`}>SKILL.md</code>) to a chat, Project, or Custom GPT{' '}
                <span className={`font-bold ${headingText}`}>Knowledge</span> (enable{' '}
                <span className={`font-bold ${headingText}`}>Code Interpreter</span> so it can run{' '}
                <code className={`px-1 ${codeBg}`}>ep2350.mjs validate</code>).
              </p>
              <p>
                <span className={`font-bold ${headingText}`}>CODEX CLI:</span>{' '}
                Unzip into <code className={`px-1 ${codeBg}`}>~/.codex/skills/</code> or{' '}
                <code className={`px-1 ${codeBg}`}>.agents/skills/</code> in your workspace.
              </p>
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <code
                className={`flex-1 min-w-0 font-mono text-[8.5px] px-2 py-1 truncate select-text border ${subtleBorder} ${codeBg}`}
                title={chatGptPrompt}
              >
                {chatGptPrompt}
              </code>
              {renderCopyBtn('chatgpt-prompt', chatGptPrompt, 'COPY PROMPT')}
            </div>
          </div>

          {/* 03 · GEMINI */}
          <div className={`${cardBg} border ${borderInk} p-2.5 flex flex-col gap-1.5`}>
            <div className={`flex items-center justify-between border-b ${subtleBorder} pb-1`}>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#f15a22]" />
                <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${headingText}`}>
                  03 // GEMINI
                </span>
              </div>
              <span className={`font-mono text-[8px] uppercase tracking-wider ${mutedText}`}>
                GEMINI APPS / GEMS · GEMINI CLI / ANTIGRAVITY
              </span>
            </div>

            <div className={`font-mono text-[9px] leading-relaxed ${mutedText} space-y-1`}>
              <p>
                <span className={`font-bold ${headingText}`}>GEMINI WEB / CUSTOM GEM:</span>{' '}
                Open <span className={`font-bold ${headingText}`}>Gem Manager → New Gem</span> (or any chat),
                click <span className={`font-bold ${headingText}`}>+ Add files</span>, attach{' '}
                <code className={`px-1 ${codeBg}`}>SKILL.md</code> (from <span className={`font-bold ${headingText}`}>OPEN</span> or{' '}
                <span className={`font-bold ${headingText}`}>.ZIP</span>), and ask Gemini to output validated{' '}
                <code className={`px-1 ${codeBg}`}>config.json</code> presets.
              </p>
              <p>
                <span className={`font-bold ${headingText}`}>GEMINI CLI / ANTIGRAVITY:</span>{' '}
                Unzip into <code className={`px-1 ${codeBg}`}>~/.gemini/skills/</code> or{' '}
                <code className={`px-1 ${codeBg}`}>.agents/skills/</code> to enable automatically.
              </p>
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <code
                className={`flex-1 min-w-0 font-mono text-[8.5px] px-2 py-1 truncate select-text border ${subtleBorder} ${codeBg}`}
                title={geminiCliCmd}
              >
                {geminiCliCmd}
              </code>
              {renderCopyBtn('gemini-cmd', geminiCliCmd, 'COPY CMD')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
