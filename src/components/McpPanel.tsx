import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ThemeMode } from '../types/config';
import { DEFAULT_MCP_URL } from '../utils/presetUrl';
import { themeColor } from '../theme/tokens';

interface McpPanelProps {
  theme?: ThemeMode;
}

/**
 * The MCP endpoint for this deployment: the same origin when the app is served by the Cloudflare
 * Worker (or `vite dev`), which answer /mcp next to the app; the public Worker otherwise
 * (GitHub Pages is static and has no /mcp).
 */
function resolveMcpUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    const { protocol, hostname, origin } = window.location;
    if ((protocol === 'http:' || protocol === 'https:') && !hostname.endsWith('github.io')) {
      return `${origin}/mcp`;
    }
  }
  return DEFAULT_MCP_URL;
}

const STEPS = [
  ['DESCRIBE', 'Ask your AI for the effects you want.'],
  ['LISTEN & TWEAK', 'Open the link it gives you, test the pack and adjust it if needed.'],
  ['SAVE TO DEVICE', 'Upload it to your EP-2350 mic over USB-C.']
] as const;

const APPS = [
  ['CLAUDE', 'Settings › Connectors › Add custom connector'],
  ['CHATGPT', 'Settings › Apps & Connectors › Developer mode › Create'],
  ['AGENTS', 'Claude Code, Cursor, Gemini CLI and others: add it as a remote MCP server']
] as const;

export const McpPanel: React.FC<McpPanelProps> = ({ theme = 'fx' }) => {
  const isTing = theme === 'ting';
  const [copied, setCopied] = useState(false);
  const mcpUrl = useMemo(() => resolveMcpUrl(), []);

  const handleCopy = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(mcpUrl);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      // Ignore clipboard permission errors in restricted contexts
    }
  };

  const headingText = 'text-te-ink';
  const mutedText = 'text-te-muted';
  const cardClass = `te-card-3d w-full border ${
    'border-te-ink bg-te-surface'
  } p-3 flex flex-col gap-2 relative rounded-none`;
  const cardHeaderBorder = 'border-te-rule';
  const codeClass = `flex-1 min-w-0 h-[26px] px-2 flex items-center font-mono text-te-xs truncate select-text border ${
    'bg-te-field text-te-ink border-te-ink/25'
  }`;
  const actionClass = `te-btn-3d te-btn-3d--pressable te-btn-3d--dark shrink-0 h-[26px] w-[96px] flex items-center justify-center gap-1.5 font-mono text-te-xs font-bold tracking-widest uppercase cursor-pointer text-white ${
    'bg-te-ink hover:bg-te-ink-hover'
  }`;

  const cardHeader = (num: string, title: string) => (
    <div className={`flex items-center gap-2 border-b ${cardHeaderBorder} pb-1.5`}>
      <span className="font-mono text-te-sm font-bold text-te-accent">{num}.</span>
      <span className={`font-te-bold text-te-md uppercase tracking-tight ${headingText}`}>{title}</span>
    </div>
  );

  return (
    <div className="te-bevel-frame w-full">
      <div
        className="te-ledger-card w-full flex flex-col select-none overflow-hidden h-auto sm:h-[626px] relative z-10"
        data-testid="mcp-panel"
      >
        {/* 1. TOP HEADER TAB: same structure and size as the PresetLedger header */}
        <div
          className={`relative ${
            'bg-te-header border-b'
          } text-white px-4 py-2 border-t border-white/25 flex items-center justify-between gap-3 shrink-0`}
          data-testid="mcp-header"
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

          {/* Title; 25px content height keeps the header the same size as the FX board's */}
          <h2 className="h-[25px] flex items-center font-mono font-bold text-te-sm tracking-wider uppercase">
            ADD EP MIC TOOL TO YOUR AI
          </h2>
        </div>

        {/* 2. BODY: same canvas as the FX chain */}
        <div className={`flex-1 min-h-0 sm:overflow-y-auto p-3 ${'bg-te-canvas'} flex flex-col gap-3`}>
          <section className={cardClass} data-testid="mcp-how-it-works">
            {cardHeader('01', 'HOW IT WORKS')}
            <ol className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="flex items-start gap-2">
                  <span
                    className={`te-btn-3d shrink-0 w-[22px] h-[22px] flex items-center justify-center font-mono text-te-xs font-bold ${
                      'bg-te-control text-te-ink'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="flex flex-col">
                    <span className={`font-mono text-te-xs font-bold uppercase tracking-wider ${headingText}`}>
                      {title}
                    </span>
                    <span className={`font-mono text-te-xs leading-snug ${mutedText}`}>{text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className={cardClass} data-testid="mcp-how-to-connect">
            {cardHeader('02', 'HOW TO CONNECT')}
            <p className={`font-mono text-te-xs leading-snug ${mutedText}`}>
              Add this link to your AI as a connector (remote MCP server).
            </p>
            <div className="flex items-center gap-2" data-testid="mcp-url">
              <code className={codeClass} title={mcpUrl}>
                {mcpUrl}
              </code>
              <button type="button" onClick={() => void handleCopy()} className={actionClass}>
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'COPIED' : 'COPY'}</span>
              </button>
            </div>
            <ul className="flex flex-col gap-1.5 pt-1" data-testid="mcp-apps">
              {APPS.map(([app, where]) => (
                <li key={app} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-2">
                  <span className={`sm:w-[112px] shrink-0 font-mono text-te-xs font-bold uppercase tracking-wider ${headingText}`}>
                    {app}
                  </span>
                  <span className={`font-mono text-te-xs leading-snug ${mutedText}`}>{where}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};
