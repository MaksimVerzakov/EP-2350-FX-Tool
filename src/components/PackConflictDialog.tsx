import React, { useEffect, useRef } from 'react';

interface PackConflictDialogProps {
  /** Name shared by the incoming pack and the existing YOUR PACKS entry. */
  packName: string;
  /** Name the copy will get if the user picks SAVE AS COPY. */
  copyName: string;
  onReplace: () => void;
  onSaveAsCopy: () => void;
  onCancel: () => void;
}

/**
 * Asked when a pack from a link has the same name as one in YOUR PACKS but different contents
 * (e.g. an AI assistant re-sent a fixed version): replace the stored pack or keep both.
 */
export const PackConflictDialog: React.FC<PackConflictDialogProps> = ({
  packName,
  copyName,
  onReplace,
  onSaveAsCopy,
  onCancel
}) => {
  const replaceRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    replaceRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pack-conflict-title"
      aria-describedby="pack-conflict-body"
      data-testid="pack-conflict-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-te-edge/15 backdrop-blur-[1px]"
    >
      <div className="relative w-full max-w-[420px] pr-[5px] pb-[5px]">
        <div
          aria-hidden="true"
          className="absolute top-0 right-0 bottom-[5px] w-[5px] origin-top-left skew-y-[45deg] flex flex-col border-t border-r border-b border-te-edge"
        >
          <div className="h-[24px] bg-te-accent-deep border-b border-te-edge" />
          <div className="flex-1 bg-te-bevel" />
        </div>
        <div
          aria-hidden="true"
          className="absolute left-0 right-[5px] bottom-0 h-[5px] origin-top-left skew-x-[45deg] border-l border-b border-r border-te-edge bg-te-bevel"
        />

        <div className="relative z-10 border border-te-edge bg-te-surface text-te-ink">
          <div className="h-[24px] bg-te-accent border-b border-te-edge flex items-center justify-center relative px-6">
            <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute left-[7px] top-[6px] pointer-events-none" />
            <span
              id="pack-conflict-title"
              className="font-te-medium text-te-sm tracking-wider uppercase text-white leading-none"
            >
              PACK ALREADY IN YOUR PACKS
            </span>
            <span className="w-[11px] h-[11px] rounded-full border border-te-edge/55 absolute right-[7px] top-[6px] pointer-events-none" />
          </div>

          <div className="px-6 py-5 bg-te-field flex flex-col gap-4">
            <p id="pack-conflict-body" className="font-mono text-te-sm uppercase leading-relaxed">
              YOU ALREADY HAVE A PACK NAMED <strong>{packName}</strong>. THE ONE FROM THIS LINK IS DIFFERENT.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                ref={replaceRef}
                type="button"
                onClick={onReplace}
                className="flex-1 h-[30px] px-3 bg-te-accent hover:bg-te-accent-hover text-white border border-te-edge font-mono text-te-sm font-bold uppercase tracking-wider cursor-pointer"
              >
                REPLACE
              </button>
              <button
                type="button"
                onClick={onSaveAsCopy}
                className="flex-1 h-[30px] px-3 bg-te-ink hover:bg-te-ink-hover text-white border border-te-edge font-mono text-te-sm font-bold uppercase tracking-wider cursor-pointer"
                title={`Keep both. The new one is saved as ${copyName}`}
              >
                SAVE AS COPY
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-te-xs uppercase text-te-muted truncate">
                COPY WILL BE NAMED {copyName}
              </span>
              <button
                type="button"
                onClick={onCancel}
                className="font-mono text-te-xs font-bold uppercase tracking-wider text-te-muted hover:text-te-accent cursor-pointer shrink-0"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
