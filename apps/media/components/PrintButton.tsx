'use client';

export default function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="print-btn" onClick={() => window.print()}>
      {label}
    </button>
  );
}
