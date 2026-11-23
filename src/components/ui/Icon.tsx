/** Minimal inline stroke icon set (no third-party icon dependency). */
const PATHS: Record<string, string> = {
  overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  today: "M9 11l2 2 4-4M5 4h14v16H5zM9 2v4M15 2v4",
  schedule: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h3M8 17h3",
  equipment: "M4 7h16v10H4zM8 17v3M16 17v3M8 11h3M14 11h2",
  trends: "M4 20V4M4 20h16M7 16l4-5 3 3 5-7",
  charges: "M6 4h9a3 3 0 0 1 0 6H9M6 4v16M6 10h9M4 7h10",
  patients: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  handover: "M7 7h11l-3-3M17 17H6l3 3",
  nebulization: "M8 21h8M9 21V11h6v10M12 11V7M9 4c1 1 5 1 6 0",
  ventilation: "M3 12h3l2-4 3 8 2-6 2 2h6",
  tubing: "M4 12a8 8 0 0 1 14-5M20 12a8 8 0 0 1-14 5M18 3v4h-4M6 21v-4h4",
  pft: "M4 19V5M4 19h16M8 15l3-4 3 2 5-6",
  abg: "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z",
  sputum: "M9 3h6M10 3v5l-5 9a3 3 0 0 0 3 4h8a3 3 0 0 0 3-4l-5-9V3",
  shifts: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  staff: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M18 20a6 6 0 0 0-3-5.2",
  reports: "M5 20V10M12 20V4M19 20v-7",
  import: "M12 3v12M7 10l5 5 5-5M4 21h16",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  audit: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 9h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 2z",
  devices: "M4 5h16v10H4zM2 19h20M15 19v-4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  sync: "M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3M4 4v4h4M20 20v-4h-4",
  print: "M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = "" }: { name: IconName | string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
