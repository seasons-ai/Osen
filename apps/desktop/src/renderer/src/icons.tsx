// Icon map verbatim from design/mockup/shell.js (the ICONS object); update here when the mockup changes.
const ICONS = {
  'i-plus': '<path d="M12 5v14M5 12h14"/>',
  'i-history': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  'i-settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  'i-check': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'i-x': '<path d="M6 6l12 12M18 6L6 18"/>',
  'i-alert': '<path d="M12 3L2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/>',
  'i-question': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.5"/>',
  'i-reply': '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  'i-stop': '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  'i-play': '<path d="M7 4.5v15l12-7.5-12-7.5z"/>',
  'i-copy': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  'i-download': '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  'i-chevron-right': '<path d="M9 5l7 7-7 7"/>',
  'i-chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  'i-chevron-down': '<path d="M5 9l7 7 7-7"/>',
  'i-user-off': '<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 11-5.7M17 15l5 5M22 15l-5 5"/>',
  'i-terminal': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  'i-cloud': '<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 10a4 4 0 0 1-.5 8H7z"/>',
  'i-key': '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  'i-edit': '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13 7l4 4"/>',
  'i-spark': '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z"/>',
  'i-clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'i-users': '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6"/>',
  'i-refresh': '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
  'i-arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'i-arrow-down': '<path d="M12 5v14M5 12l7 7 7-7"/>',
  'i-trash': '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  'i-doc': '<path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  'i-search': '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>',
  'i-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  'i-coins': '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7M15 10.5c3 .2 6 1.2 6 2.5v4c0 1.7-2.7 3-6 3-1.8 0-3.4-.4-4.5-1"/>',
  'i-pin': '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z"/><path d="M12 14v7"/>',
  'i-loop': '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>'
} as const;

export type IconName = keyof typeof ICONS;

export function IconSprite() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      {(Object.keys(ICONS) as IconName[]).map((id) => (
        <symbol key={id} id={id} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: ICONS[id] }} />
      ))}
    </svg>
  );
}

export function Icon({ name, size }: { name: IconName; size?: "sm" | "lg" | "xl" }) {
  return (
    <svg className={size ? `icon icon--${size}` : "icon"}>
      <use href={`#${name}`} />
    </svg>
  );
}
