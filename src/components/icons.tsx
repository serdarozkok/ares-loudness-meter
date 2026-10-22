import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

export function IconWave(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" {...p}>
      <path d="M3 11v-2M6.5 14V6M10 16V4M13.5 13V7M17 11V9" />
    </svg>
  );
}

export function IconPin({ pinned, ...p }: P & { pinned?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12.5 3.5l4 4-1.8 1.8-1.6-.4-3.2 3.2.5 2.4-1.4 1.4-2.8-2.8-3.2 3.2m7.5-12.8l-1.8 1.8.4 1.6-3.2 3.2-2.4-.5-1.4 1.4 2.8 2.8" />
    </svg>
  );
}

export function IconClose(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...p}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </svg>
  );
}

export function IconGrip(p: P) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...p}>
      <circle cx="5.5" cy="4" r="1.1" />
      <circle cx="10.5" cy="4" r="1.1" />
      <circle cx="5.5" cy="8" r="1.1" />
      <circle cx="10.5" cy="8" r="1.1" />
      <circle cx="5.5" cy="12" r="1.1" />
      <circle cx="10.5" cy="12" r="1.1" />
    </svg>
  );
}

export function IconReset(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 9.5A6 6 0 1 1 5.6 14M4 5.5v4h4" />
    </svg>
  );
}

export function IconCopy(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="7" y="7" width="9" height="9" rx="1.8" />
      <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
    </svg>
  );
}

export function IconExport(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="3.5" y="4" width="13" height="12" rx="2" />
      <circle cx="7.5" cy="8" r="1.2" />
      <path d="M4.5 14l3.5-3.2 2.5 2.2 2.8-2.8 2.7 3.8" />
    </svg>
  );
}

export function IconQr(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="3.5" y="3.5" width="5" height="5" rx="0.8" />
      <rect x="11.5" y="3.5" width="5" height="5" rx="0.8" />
      <rect x="3.5" y="11.5" width="5" height="5" rx="0.8" />
      <path d="M11.5 11.5h2v2h-2zM14.5 14.5h2v2h-2zM14.5 11.5h2M11.5 15.5h2" />
    </svg>
  );
}

export function IconFolder(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h3.2l1.6 1.8H15A1.5 1.5 0 0 1 16.5 7.8v6.7A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5V6z" />
    </svg>
  );
}

export function IconSettings(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="10" cy="10" r="2.4" />
      <path d="M10 3.2v1.6M10 15.2v1.6M3.2 10h1.6M15.2 10h1.6M5.2 5.2l1.1 1.1M13.7 13.7l1.1 1.1M14.8 5.2l-1.1 1.1M6.3 13.7l-1.1 1.1" />
    </svg>
  );
}

export function IconPower(p: P) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...p}>
      <path d="M10 3.5v6M6.2 5.8a6 6 0 1 0 7.6 0" />
    </svg>
  );
}

export function IconChevronUp(p: P) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4.5 10L8 6.5 11.5 10" />
    </svg>
  );
}

export function IconChevronDown(p: P) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4.5 6L8 9.5 11.5 6" />
    </svg>
  );
}
