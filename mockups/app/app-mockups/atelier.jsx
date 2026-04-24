// ======================================================================
// ATELIER — Greige architectural. Strong grid, mono+serif duo.
// Novel UX: Contacts as a blueprint node-map with call-frequency edges.
// ======================================================================

const AT = {
  bg:       "#f5f2ec",
  surface:  "#fbf9f3",
  sunk:     "#ebe7dc",
  ink:      "#201d18",
  ink2:     "#54504a",
  ink3:     "#8a867c",
  rule:     "#ddd8cc",
  ruleStr:  "#c9c3b4",
  accent:   "#2b4a6a",  // drafting blue
  accentW:  "#dfe7f0",
  sans:     "'Inter', system-ui, sans-serif",
  serif:    "'Fraunces', serif",
  mono:     "'JetBrains Mono', monospace",
  titleSerif: true,
  titleWeight: 500,
  titleLetter: "-0.02em",
  radius:   2,
  bubbleMe:  "#201d18",
  bubbleThem:"#ebe7dc",
  chipActive: "#201d18",
  chipActiveFg: "#f5f2ec",
  chipFg: "#54504a",
};

const AtelierChrome = ({ children }) => (
  <div style={{
    background: AT.bg, color: AT.ink, height: "100%",
    fontFamily: AT.sans, display: "flex", flexDirection: "column",
    // subtle grid paper
    backgroundImage: `
      linear-gradient(${AT.rule} 1px, transparent 1px),
      linear-gradient(90deg, ${AT.rule} 1px, transparent 1px)
    `,
    backgroundSize: "40px 40px",
    backgroundPosition: "-1px -1px",
  }}>
    <div style={{
      height: 42, display: "flex", alignItems: "center", padding: "0 16px",
      background: AT.bg, borderBottom: `1px solid ${AT.ruleStr}`, flexShrink: 0,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{ marginLeft: 16, fontFamily: AT.mono, fontSize: 12, fontWeight: 500,
                     letterSpacing: "0.06em", textTransform: "uppercase" }}>
        OpenExtract
      </div>
      <span style={{ width: 12, height: 1, background: AT.ruleStr, margin: "0 12px" }}/>
      <span style={{ fontSize: 11, color: AT.ink2, fontFamily: AT.mono, letterSpacing: "0.04em" }}>
        Dwg. 001 — Mom/iPhone 13 Pro/2023‑08‑14
      </span>
      <div style={{ flex: 1 }}/>
      <span style={{ fontSize: 10, color: AT.ink3, fontFamily: AT.mono, letterSpacing: "0.14em",
                      textTransform: "uppercase" }}>Scale 1:1 · Local</span>
    </div>
    {children}
  </div>
);

const AtelierSidebar = ({ active }) => {
  const Icons = window.OEIcons;
  const items = [
    { id: "timeline",  label: "Timeline",  I: Icons.Clock,     n: "01" },
    { id: "messages",  label: "Messages",  I: Icons.Message,   n: "02" },
    { id: "photos",    label: "Photos",    I: Icons.Image,     n: "03" },
    { id: "voicemail", label: "Voicemail", I: Icons.Voicemail, n: "04" },
    { id: "calls",     label: "Calls",     I: Icons.Phone,     n: "05" },
    { id: "contacts",  label: "Contacts",  I: Icons.User,      n: "06" },
    { id: "notes",     label: "Notes",     I: Icons.FileText,  n: "07" },
  ];
  return (
    <nav style={{
      width: 220, flexShrink: 0, padding: "16px 10px",
      borderRight: `1px solid ${AT.ruleStr}`, background: AT.bg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ fontFamily: AT.mono, fontSize: 10, color: AT.ink3, letterSpacing: "0.14em",
                    textTransform: "uppercase", padding: "4px 12px 12px", fontWeight: 600 }}>
        Index
      </div>
      {items.map(it => {
        const on = it.id === active;
        const I = it.I;
        return (
          <div key={it.id} style={{
            display: "grid", gridTemplateColumns: "24px 18px 1fr",
            alignItems: "center", gap: 8, padding: "8px 12px",
            cursor: "pointer",
            background: on ? AT.accentW : "transparent",
            borderLeft: on ? `2px solid ${AT.accent}` : "2px solid transparent",
            marginLeft: on ? 0 : 2,
            color: on ? AT.ink : AT.ink2,
          }}>
            <span style={{ fontFamily: AT.mono, fontSize: 10, color: AT.ink3, letterSpacing: "0.06em" }}>{it.n}</span>
            <I size={14} strokeWidth={1.4} stroke={on ? AT.accent : AT.ink2}/>
            <span style={{ fontSize: 13, fontWeight: on ? 600 : 400,
                           fontFamily: AT.serif, letterSpacing: "-0.005em" }}>{it.label}</span>
          </div>
        );
      })}
      <div style={{ flex: 1 }}/>
      <div style={{
        fontFamily: AT.mono, fontSize: 10, color: AT.ink3,
        padding: "10px 12px 4px", borderTop: `1px solid ${AT.ruleStr}`, marginTop: 10,
        lineHeight: 1.6, letterSpacing: "0.04em",
      }}>
        DWG 001 — M.WHITFIELD<br/>
        REV. 2023.08.14<br/>
        SHT. — of 7
      </div>
    </nav>
  );
};

const AtelierBackup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;
  return (
    <div style={{ flex: 1, overflow: "auto", background: AT.bg }}>
      <div style={{ padding: "48px 56px 14px" }}>
        <div style={{ fontFamily: AT.mono, fontSize: 10, color: AT.accent, letterSpacing: "0.16em",
                       textTransform: "uppercase", fontWeight: 600 }}>
          ⎯ sheet 00 · source selection
        </div>
        <h1 style={{ margin: "12px 0 4px", fontFamily: AT.serif, fontWeight: 500,
                      fontSize: 44, letterSpacing: "-0.025em", lineHeight: 1.05 }}>
          Three backups on this Mac.
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 13.5, color: AT.ink2, lineHeight: 1.6, maxWidth: 560 }}>
          Read-only. Drawing revisions are non-destructive.
        </p>
      </div>

      <div style={{ padding: "0 56px 56px" }}>
        {backups.map((b, i) => (
          <div key={b.id} style={{
            background: AT.surface,
            border: `1px solid ${AT.ruleStr}`, marginTop: 16,
            position: "relative",
          }}>
            {/* tick header */}
            <div style={{
              display: "flex", alignItems: "center",
              padding: "6px 14px", borderBottom: `1px solid ${AT.ruleStr}`,
              background: AT.sunk, fontFamily: AT.mono, fontSize: 10,
              color: AT.ink3, letterSpacing: "0.14em", textTransform: "uppercase",
            }}>
              <span>Backup № 0{i+1}</span>
              <span style={{ margin: "0 10px", color: AT.ruleStr }}>│</span>
              <span>{b.ios}</span>
              <span style={{ flex: 1 }}/>
              <span>{b.lastBackup}</span>
            </div>
            <div style={{
              display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 150px",
              padding: "20px 20px", gap: 18, alignItems: "center",
            }}>
              <div>
                <div style={{ fontFamily: AT.serif, fontSize: 26, fontWeight: 500, letterSpacing: "-0.02em" }}>{b.device}</div>
                <div style={{ fontSize: 12.5, color: AT.ink2, marginTop: 2 }}>{b.owner}</div>
              </div>
              <div style={{ fontFamily: AT.mono, fontSize: 12, color: AT.ink2, lineHeight: 1.6 }}>
                <div>PERIOD · {b.years[0]}–{b.years[b.years.length-1]}</div>
                <div>SIZE ·&nbsp;&nbsp; {b.size}</div>
                <div>ENC &nbsp;·&nbsp;&nbsp; {b.encrypted ? "YES" : "NO"}</div>
              </div>
              <div style={{ fontFamily: AT.mono, fontSize: 12, color: AT.ink2, lineHeight: 1.6 }}>
                <div>MSG · {b.messages.toLocaleString()}</div>
                <div>PHO · {b.photos.toLocaleString()}</div>
                <div>CAL · {b.calls.toLocaleString()} / VM · {b.voicemails}</div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button style={{
                  background: i === 0 ? AT.accent : "transparent",
                  color: i === 0 ? "#fff" : AT.ink,
                  border: `1px solid ${i === 0 ? AT.accent : AT.ruleStr}`,
                  padding: "9px 16px", borderRadius: 2,
                  fontSize: 12, fontFamily: AT.mono, letterSpacing: "0.08em",
                  textTransform: "uppercase", fontWeight: 600,
                  display: "inline-flex", gap: 6, alignItems: "center",
                }}>
                  Open <Icons.ArrowRight size={11} strokeWidth={2}/>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const AtelierMessages = () => {
  const { conversations, activeThread } = window.OE_DATA;
  const Icons = window.OEIcons;

  return (
    <div style={{ flex: 1, display: "flex", background: AT.bg, minWidth: 0 }}>
      <aside style={{
        width: 276, flexShrink: 0, borderRight: `1px solid ${AT.ruleStr}`,
        display: "flex", flexDirection: "column", background: AT.bg,
      }}>
        <div style={{ padding: "14px 16px 10px" }}>
          <div style={{ fontFamily: AT.mono, fontSize: 10, color: AT.ink3, letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Sheet 02 · Threads
          </div>
          <h2 style={{ margin: "4px 0 0", fontFamily: AT.serif, fontWeight: 500,
                        fontSize: 22, letterSpacing: "-0.015em" }}>Messages</h2>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "4px 6px 12px" }}>
          {conversations.map(c => {
            const on = c.id === activeThread.contactId;
            return (
              <div key={c.id} style={{
                display: "grid", gridTemplateColumns: "30px 1fr auto",
                padding: "9px 10px", gap: 8, alignItems: "center",
                cursor: "pointer",
                background: on ? AT.accentW : "transparent",
                borderLeft: on ? `2px solid ${AT.accent}` : "2px solid transparent",
                marginLeft: on ? 0 : 2, marginBottom: 1,
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 2,
                  background: `oklch(86% 0.05 ${c.avatarHue})`,
                  border: `1px solid ${AT.ruleStr}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, color: AT.ink, fontWeight: 600, fontFamily: AT.serif,
                }}>{c.name[0]}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: AT.ink, fontWeight: on ? 600 : 500, fontFamily: AT.serif, letterSpacing: "-0.005em" }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: AT.ink2, fontFamily: AT.sans,
                                 whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.preview}</div>
                </div>
                <div style={{ fontFamily: AT.mono, fontSize: 9.5, color: AT.ink3 }}>{c.time}</div>
              </div>
            );
          })}
        </div>
      </aside>

      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          padding: "14px 24px", borderBottom: `1px solid ${AT.ruleStr}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 2,
            background: "oklch(86% 0.05 14)", border: `1px solid ${AT.ruleStr}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: AT.serif, fontSize: 15, fontWeight: 600,
          }}>E</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: AT.serif, fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}>Emma Whitfield</div>
            <div style={{ fontSize: 10.5, color: AT.ink3, fontFamily: AT.mono, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              847 msgs · thread 02‑141
            </div>
          </div>
          <button style={{
            background: AT.accent, color: "#fff", border: 0,
            padding: "7px 14px", borderRadius: 2, fontSize: 11,
            fontFamily: AT.mono, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600,
            display: "inline-flex", gap: 5, alignItems: "center",
          }}>
            <Icons.Export size={11} strokeWidth={1.8}/> Plot
          </button>
        </div>

        {/* scrubber: blueprint hairline ruler */}
        <div style={{ padding: "14px 28px 10px", borderBottom: `1px solid ${AT.ruleStr}`, background: AT.bg }}>
          <div style={{ position: "relative", height: 28 }}>
            {/* baseline */}
            <div style={{ position: "absolute", left: 0, right: 0, top: 18, height: 1, background: AT.ink3 }}/>
            {/* major ticks (years) */}
            {[2016,2017,2018,2019,2020,2021,2022,2023].map((y, i, arr) => {
              const x = (i / (arr.length - 1)) * 100;
              const active = y === 2023;
              return (
                <Fragment key={y}>
                  <div style={{
                    position: "absolute", left: `${x}%`, top: 10,
                    width: 1, height: 10, background: AT.ink3,
                  }}/>
                  <div style={{
                    position: "absolute", left: `${x}%`, top: 0,
                    transform: "translateX(-50%)",
                    fontFamily: AT.mono, fontSize: 10, color: active ? AT.accent : AT.ink2,
                    fontWeight: active ? 600 : 400,
                  }}>{y}</div>
                </Fragment>
              );
            })}
            {/* minor ticks */}
            {Array.from({ length: 85 }).map((_, i) => {
              const x = (i / 84) * 100;
              return (
                <div key={i} style={{
                  position: "absolute", left: `${x}%`, top: 14,
                  width: 0.5, height: 5, background: AT.ink3, opacity: 0.5,
                }}/>
              );
            })}
            {/* caret */}
            <div style={{
              position: "absolute", left: "95%", top: 15, transform: "translateX(-50%)",
              width: 0, height: 0,
              borderLeft: "5px solid transparent", borderRight: "5px solid transparent",
              borderTop: `7px solid ${AT.accent}`,
            }}/>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "22px 32px" }}>
          <div style={{
            textAlign: "center", fontFamily: AT.mono, fontSize: 10.5, color: AT.ink3,
            letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 16,
          }}>↧ 2023.08.14 — 14:02 ↧</div>
          {activeThread.messages.map(m => {
            const mine = m.from === "me";
            return (
              <div key={m.id} style={{
                display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 5,
              }}>
                <div style={{
                  maxWidth: "62%",
                  background: mine ? AT.bubbleMe : AT.bubbleThem,
                  color: mine ? AT.bg : AT.ink,
                  padding: m.kind === "photo" ? 4 : "9px 13px",
                  borderRadius: 3,
                  border: mine ? "none" : `1px solid ${AT.ruleStr}`,
                  fontSize: 13.5, lineHeight: 1.5, fontFamily: AT.serif, letterSpacing: "-0.005em",
                }}>
                  {m.kind === "photo" ? (
                    <div style={{
                      width: 220, height: 160, borderRadius: 2, overflow: "hidden",
                      background: "linear-gradient(135deg, oklch(70% 0.08 45), oklch(45% 0.1 30))",
                      position: "relative",
                    }}>
                      <div style={{ position: "absolute", left: 8, bottom: 6,
                                     fontFamily: AT.mono, fontSize: 10, color: "#fff" }}>{m.caption}</div>
                    </div>
                  ) : m.text}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};

// --- Novel CONTACTS: blueprint node-map ---
const AtelierContactsNovel = ({ contacts, tokens: T }) => {
  // pick top 8 by frequency + the rest as dim peripheral nodes
  const top = contacts.slice().sort((a, b) => b.freq - a.freq).slice(0, 8);
  const cx = 520, cy = 320;
  const radius = 240;

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "22px 30px 30px" }}>
      <div style={{
        background: T.surface, border: `1px solid ${T.ruleStr}`, position: "relative",
      }}>
        {/* title bar */}
        <div style={{
          padding: "8px 14px", borderBottom: `1px solid ${T.ruleStr}`,
          display: "flex", alignItems: "center",
          fontFamily: T.mono, fontSize: 10, color: T.ink3, letterSpacing: "0.14em",
          textTransform: "uppercase", background: T.sunk,
        }}>
          <span>DWG 06 — Contacts · connection graph</span>
          <span style={{ flex: 1 }}/>
          <span>edges: call frequency · node size: messages</span>
        </div>
        <svg viewBox="0 0 1040 680" width="100%" height="560" style={{ display: "block" }}>
          <defs>
            <pattern id="grid-at" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke={T.rule} strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width="1040" height="680" fill="url(#grid-at)"/>

          {/* edges from top contacts to center (MOM) */}
          {top.map((c, i) => {
            const angle = (i / top.length) * Math.PI * 2;
            const r = radius * (0.55 + (1 - c.freq / top[0].freq) * 0.45);
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            const thickness = Math.max(0.7, c.freq / 140);
            return (
              <line key={`e-${i}`} x1={cx} y1={cy} x2={x} y2={y}
                    stroke={T.accent} strokeWidth={thickness} opacity={0.7}
                    strokeDasharray={c.freq < 100 ? "3 4" : undefined}/>
            );
          })}

          {/* center (Mom) */}
          <circle cx={cx} cy={cy} r={26} fill={T.accent}/>
          <circle cx={cx} cy={cy} r={36} fill="none" stroke={T.accent} strokeDasharray="2 4" opacity={0.4}/>
          <text x={cx} y={cy + 4} fontSize="11" fontFamily={T.mono} fontWeight={700}
                fill="#fff" textAnchor="middle" letterSpacing="0.12em">MOM</text>

          {/* top nodes */}
          {top.map((c, i) => {
            const angle = (i / top.length) * Math.PI * 2;
            const r = radius * (0.55 + (1 - c.freq / top[0].freq) * 0.45);
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            const size = 12 + Math.min(c.freq / 50, 18);
            const textOffsetX = Math.cos(angle) * (size + 16);
            const textOffsetY = Math.sin(angle) * (size + 18);
            const anchor = Math.cos(angle) > 0.2 ? "start" : Math.cos(angle) < -0.2 ? "end" : "middle";
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={size} fill={`oklch(88% 0.05 ${c.hue})`}
                        stroke={T.accent} strokeWidth={1.5}/>
                <text x={x} y={y + 4} fontSize="11" fontFamily={T.serif} fill={T.ink}
                      textAnchor="middle" fontWeight={600}>{c.name[0]}</text>
                <text x={x + textOffsetX} y={y + textOffsetY - 4} fontSize="11.5"
                      fontFamily={T.serif} fill={T.ink} textAnchor={anchor}
                      fontWeight={600}>{c.name}</text>
                <text x={x + textOffsetX} y={y + textOffsetY + 8} fontSize="10"
                      fontFamily={T.mono} fill={T.ink3} textAnchor={anchor}>
                  {c.role} · {c.freq} msgs
                </text>
              </g>
            );
          })}

          {/* peripheral dim nodes */}
          {Array.from({ length: 40 }).map((_, i) => {
            const angle = (i / 40) * Math.PI * 2 + 0.17;
            const r = 290 + (i % 5) * 14;
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            return <circle key={i} cx={x} cy={y} r={2} fill={T.ink3} opacity={0.4}/>;
          })}
        </svg>

        {/* footer strip */}
        <div style={{
          padding: "8px 14px", borderTop: `1px solid ${T.ruleStr}`,
          display: "flex", alignItems: "center",
          fontFamily: T.mono, fontSize: 10, color: T.ink3, letterSpacing: "0.1em",
          textTransform: "uppercase", background: T.sunk,
        }}>
          <span>612 contacts · 8 inner circle · 40 peripheral shown</span>
          <span style={{ flex: 1 }}/>
          <span>CLICK A NODE FOR DETAIL</span>
        </div>
      </div>
    </div>
  );
};

window.AtelierRoot = ({ screen }) => {
  const overrides = {
    backup:   <AtelierBackup/>,
    messages: <AtelierMessages/>,
  };
  const custom = overrides[screen];
  if (custom) {
    return (
      <AtelierChrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {screen !== "backup" && <AtelierSidebar active={screen}/>}
          {custom}
        </div>
      </AtelierChrome>
    );
  }
  return window.SharedScreens.render({
    screen, tokens: AT, Sidebar: AtelierSidebar, Chrome: AtelierChrome,
    backupComponent: AtelierBackup, messagesComponent: AtelierMessages,
    novelContacts: (args) => <AtelierContactsNovel {...args}/>,
  });
};
