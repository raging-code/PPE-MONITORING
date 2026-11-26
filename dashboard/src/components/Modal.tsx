import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A confirmation that needs an answer. It is drawn in document.body, so a click inside it never reaches the card behind it, and Escape cancels.
// Below the red NO LIVE DATA screen (z-50). A click on the dim area does nothing, so a stray click cannot cancel or confirm.
export default function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input,select,button')?.focus(); }, []);
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className="max-h-[90vh] w-full max-w-xl space-y-3 overflow-auto rounded-card bg-white p-5 text-ink shadow-xl"
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        {children}
      </div>
    </div>, document.body);
}
