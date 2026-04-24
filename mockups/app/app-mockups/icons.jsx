// Minimal shared inline SVG icon set so variants stay consistent in glyph shape.
// Each icon takes { size?, stroke?, strokeWidth? }. Monochrome, currentColor.

const Icon = ({ path, size = 16, stroke = "currentColor", strokeWidth = 1.5, fill = "none", children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={strokeWidth}
       strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
    {path ? <path d={path} /> : children}
  </svg>
);

const Icons = {
  Clock:    (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>,
  Message:  (p) => <Icon {...p} path="M21 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.9A8 8 0 1 1 21 12z"/>,
  Image:    (p) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/></Icon>,
  Phone:    (p) => <Icon {...p} path="M22 16.9v2.9a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5 12.8 12.8 0 0 0 2.8.7A2 2 0 0 1 22 16.9z"/>,
  Voicemail:(p) => <Icon {...p}><circle cx="6.5" cy="12" r="4"/><circle cx="17.5" cy="12" r="4"/><path d="M6.5 16h11"/></Icon>,
  User:     (p) => <Icon {...p}><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></Icon>,
  FileText: (p) => <Icon {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></Icon>,
  Search:   (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></Icon>,
  Lock:     (p) => <Icon {...p}><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></Icon>,
  Shield:   (p) => <Icon {...p} path="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6z"/>,
  ArrowRight:(p)=> <Icon {...p}><path d="M5 12h14m-5-5 5 5-5 5"/></Icon>,
  Download: (p) => <Icon {...p}><path d="M21 15v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-3M7 10l5 5 5-5M12 15V3"/></Icon>,
  Plus:     (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>,
  Settings: (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></Icon>,
  Chevron:  (p) => <Icon {...p}><path d="m9 6 6 6-6 6"/></Icon>,
  Paperclip:(p) => <Icon {...p} path="m21 12-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5"/>,
  Filter:   (p) => <Icon {...p} path="M22 3H2l8 9.5V20l4 2v-9.5z"/>,
  Export:   (p) => <Icon {...p}><path d="M12 3v13M7 8l5-5 5 5"/><path d="M20 17v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2"/></Icon>,
};

window.OEIcons = Icons;
