import React from 'react';
import { ThemeMode } from '../types/config';

interface MultiTabBannerProps {
  theme: ThemeMode;
}

/**
 * Centered Teenage Engineering modular alert displayed over the dimmed workbench
 * whenever another same-origin tab holds the active session/serial lock.
 */
export const MultiTabBanner: React.FC<MultiTabBannerProps> = () => {
  const bevelBodyColor = 'bg-te-bevel';

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="multi-tab-banner-title"
      data-testid="multi-tab-warning"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-te-edge/15 backdrop-blur-[1px]"
    >
      <div className="relative w-full max-w-[420px] pr-[5px] pb-[5px]">
        {/* 45° Axonometric Right & Bottom Bevels matching TopBanner & DeviceConnector */}
        <div
          aria-hidden="true"
          className="absolute top-0 right-0 bottom-[5px] w-[5px] origin-top-left skew-y-[45deg] flex flex-col border-t border-r border-b border-te-edge"
        >
          <div className="h-[24px] bg-te-accent-deep border-b border-te-edge" />
          <div className={`flex-1 ${bevelBodyColor}`} />
        </div>
        <div
          aria-hidden="true"
          className={`absolute left-0 right-[5px] bottom-0 h-[5px] origin-top-left skew-x-[45deg] border-l border-b border-r border-te-edge ${bevelBodyColor}`}
        />

        {/* Front Modular Card */}
        <div
          className={`relative z-10 border border-te-edge ${
            'bg-te-surface text-te-ink'
          }`}
        >
          {/* Header Bar */}
          <div className="h-[24px] bg-te-accent border-b border-te-edge flex items-center justify-center relative px-6">
            <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute left-[7px] top-[6px] pointer-events-none" />
            <span className="font-te-medium text-te-sm tracking-wider uppercase text-white leading-none">
              MULTIPLE TABS DETECTED
            </span>
            <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute right-[7px] top-[6px] pointer-events-none" />
          </div>

          {/* Body */}
          <div
            className={`px-8 py-6 relative flex items-center justify-center text-center ${
              'bg-te-field'
            }`}
          >
            <span
              className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] left-[7px] pointer-events-none ${
                'border-te-ink/35'
              }`}
            />
            <span
              className={`w-[11px] h-[11px] rounded-full border absolute top-[7px] right-[7px] pointer-events-none ${
                'border-te-ink/35'
              }`}
            />
            <span
              className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] left-[7px] pointer-events-none ${
                'border-te-ink/35'
              }`}
            />
            <span
              className={`w-[11px] h-[11px] rounded-full border absolute bottom-[7px] right-[7px] pointer-events-none ${
                'border-te-ink/35'
              }`}
            />

            <h2
              id="multi-tab-banner-title"
              className="font-te-regular text-te-lg tracking-wider uppercase leading-snug"
            >
              EP-2350 FX TOOL IS OPEN IN ANOTHER TAB OR BROWSER
            </h2>
          </div>
        </div>
      </div>
    </div>
  );
};
