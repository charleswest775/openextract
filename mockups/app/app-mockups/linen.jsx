// ======================================================================
// LINEN — Quiet minimal light
// True neutral warm white, graphite text, single muted blue accent.
// Inter + Newsreader (subtle serif accents only in numerals/titles).
// Novel UX:
//  · backup picker shows data-story row per backup with sparkline
//  · messages view has a CALENDAR HEATMAP gutter on the right
//    showing conversation activity per month, click to jump.
// ======================================================================

const L = {
  bg:      "#fafaf8",
  surface: "#ffffff",
  sunk:    "#f4f3ef",
  ink:     "#1a1a1a",
  ink2:    "#585858",
  ink3:    "#9a9a98",
  rule:    "#ececea",
  ruleStr: "#dededa",
  accent:  "#4a6b8c",   // muted navy-blue
  accentW: "#e8edf3",
  bubbleMe: "#1a1a1a",
  bubbleThem: "#f1f0ec",
};
const LF = {
  serif: "'Newsreader', 'Instrument Serif', serif",
  sans:  "'Inter', system-ui, sans-serif",
  mono:  "'JetBrains Mono', monospace",
};

const Linen_Chrome = ({ children }) => (
  <div style={{
    background: L.bg, color: L.ink, height: "100%",
    fontFamily: LF.sans, display: "flex", flexDirection: "column",
  }}>
    <div style={{
      height: 44, display: "flex", alignItems: "center", padding: "0 16px",
      background: L.bg, borderBottom: `1px solid ${L.rule}`, flexShrink: 0,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{ marginLeft: 16, fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em" }}>
        OpenExtract
      </div>
      <span style={{ width: 3, height: 3, borderRadius: 99, background: L.ink3, margin: "0 10px" }}/>
      <span style={{ fontSize: 12, color: L.ink2 }}>Mom's phone · iPhone 13 Pro</span>
      <div style={{ flex: 1 }}/>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11.5, color: L.ink3, fontFamily: LF.mono }}>
          Local · Offline
        </span>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: "#2f855a" }}/>
      </div>
    </div>
    {children}
  </div>
);

const Linen_Sidebar = ({ active }) => {
  const Icons = window.OEIcons;
  const items = [
    { id: "timeline",  label: "Timeline",  I: Icons.Clock,     c: 4281 + 48213 + 12847 },
    { id: "messages",  label: "Messages",  I: Icons.Message,   c: 48213 },
    { id: "photos",    label: "Photos",    I: Icons.Image,     c: 12847 },
    { id: "voicemail", label: "Voicemail", I: Icons.Voicemail, c: 24 },
    { id: "calls",     label: "Calls",     I: Icons.Phone,     c: 4281 },
    { id: "contacts",  label: "Contacts",  I: Icons.User,      c: 612 },
    { id: "notes",     label: "Notes",     I: Icons.FileText,  c: 189 },
  ];
  return (
    <nav style={{
      width: 216, flexShrink: 0, padding: "18px 10px",
      borderRight: `1px solid ${L.rule}`, background: L.bg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        fontSize: 11, color: L.ink3, letterSpacing: "0.06em",
        textTransform: "uppercase", padding: "6px 10px 10px", fontWeight: 500,
      }}>Data</div>
      {items.map(it => {
        const on = it.id === active;
        const I = it.I;
        return (
          <div key={it.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "7px 10px", borderRadius: 6, cursor: "pointer",
            color: on ? L.ink : L.ink2,
            background: on ? L.accentW : "transparent",
            borderLeft: on ? `2px solid ${L.accent}` : "2px solid transparent",
            marginLeft: on ? 0 : 2,
          }}>
            <I size={15} strokeWidth={1.5} stroke={on ? L.accent : L.ink2}/>
            <span style={{ fontSize: 13, fontWeight: on ? 500 : 400, flex: 1, letterSpacing: "-0.005em" }}>{it.label}</span>
            <span style={{
              fontSize: 10.5, fontFamily: LF.mono, color: L.ink3,
            }}>{it.c.toLocaleString()}</span>
          </div>
        );
      })}
      <div style={{ flex: 1 }}/>
      <div style={{
        padding: "12px 10px 4px", fontSize: 11, color: L.ink3, lineHeight: 1.45,
        borderTop: `1px solid ${L.rule}`, marginTop: 12,
      }}>
        No account, no upload. Open source on GitHub.
      </div>
    </nav>
  );
};

// --- BACKUP with mini sparkline per row ---
const Linen_Backup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;

  const Sparkline = ({ values, color = L.accent }) => {
    const w = 180, h = 36;
    const max = Math.max(...values);
    const step = w / (values.length - 1);
    const path = values.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(" ");
    const area = path + ` L ${w} ${h} L 0 ${h} Z`;
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
        <path d={area} fill={color} opacity={0.12}/>
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  };

  return (
    <div style={{ flex: 1, overflow: "auto", background: L.bg }}>
      <div style={{ padding: "48px 56px 24px" }}>
        <div style={{ fontSize: 11, color: L.ink3, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Step 1 of 1 · Choose a backup
        </div>
        <h1 style={{
          margin: "10px 0 6px",
          fontFamily: LF.serif, fontWeight: 400, fontSize: 44, letterSpacing: "-0.02em", lineHeight: 1.05,
        }}>
          Three backups on this Mac.
        </h1>
        <p style={{ maxWidth: 560, fontSize: 14, lineHeight: 1.6, color: L.ink2, margin: "6px 0 0" }}>
          Listed newest first. Sparklines show monthly activity so you can see which period each backup covers before opening it.
        </p>
      </div>

      <div style={{ padding: "0 56px 56px" }}>
        <div style={{
          background: L.surface, border: `1px solid ${L.rule}`, borderRadius: 10,
          overflow: "hidden",
        }}>
          {/* header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1.6fr 1fr 200px 1fr 120px",
            gap: 18, padding: "12px 22px",
            borderBottom: `1px solid ${L.rule}`, background: L.sunk,
            fontSize: 11, color: L.ink3, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 500,
          }}>
            <div>Device</div>
            <div>Period</div>
            <div>Activity</div>
            <div>Contents</div>
            <div style={{ textAlign: "right" }}></div>
          </div>

          {backups.map((b, i) => (
            <div key={b.id} style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 1fr 200px 1fr 120px",
              gap: 18, padding: "20px 22px", alignItems: "center",
              borderBottom: i === backups.length - 1 ? "none" : `1px solid ${L.rule}`,
            }}>
              {/* device */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 28, height: 40, borderRadius: 5,
                    border: `1px solid ${L.ruleStr}`, background: L.sunk,
                    position: "relative", flexShrink: 0,
                  }}>
                    <div style={{
                      position: "absolute", inset: 3, borderRadius: 3,
                      background: "linear-gradient(180deg, rgba(74,107,140,.3), rgba(74,107,140,.05))",
                    }}/>
                  </div>
                  <div>
                    <div style={{ fontSize: 14.5, fontWeight: 500, letterSpacing: "-0.005em" }}>{b.device}</div>
                    <div style={{ fontSize: 12.5, color: L.ink2, marginTop: 1 }}>{b.owner}</div>
                  </div>
                </div>
              </div>

              {/* period */}
              <div>
                <div style={{ fontSize: 13.5, color: L.ink }}>{b.years[0]}–{b.years[b.years.length - 1]}</div>
                <div style={{ fontSize: 11.5, color: L.ink3, marginTop: 2, fontFamily: LF.mono }}>
                  Last backed up {b.lastBackup}
                </div>
              </div>

              {/* sparkline */}
              <div>
                <Sparkline values={b.activity}/>
                <div style={{ fontSize: 10.5, color: L.ink3, marginTop: 2, fontFamily: LF.mono, letterSpacing: "0.04em" }}>
                  {b.activity.length} months · peak {Math.max(...b.activity)}/mo
                </div>
              </div>

              {/* contents */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12, color: L.ink2 }}>
                <div><span style={{ fontFamily: LF.mono, color: L.ink }}>{b.messages.toLocaleString()}</span> messages</div>
                <div><span style={{ fontFamily: LF.mono, color: L.ink }}>{b.photos.toLocaleString()}</span> photos</div>
                <div><span style={{ fontFamily: LF.mono, color: L.ink }}>{b.voicemails}</span> voicemails · <span style={{ fontFamily: LF.mono, color: L.ink }}>{b.calls.toLocaleString()}</span> calls</div>
              </div>

              {/* action */}
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {b.encrypted && (
                  <div title="Encrypted" style={{
                    width: 32, height: 32, borderRadius: 6,
                    border: `1px solid ${L.rule}`, display: "flex", alignItems: "center", justifyContent: "center",
                    color: L.ink2,
                  }}>
                    <Icons.Lock size={13} strokeWidth={1.7}/>
                  </div>
                )}
                <button style={{
                  background: i === 0 ? L.ink : L.surface,
                  color: i === 0 ? L.bg : L.ink,
                  border: `1px solid ${i === 0 ? L.ink : L.rule}`,
                  padding: "8px 14px", borderRadius: 6,
                  fontSize: 12.5, fontWeight: 500, letterSpacing: "-0.005em",
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}>
                  Open
                  <Icons.ArrowRight size={12} strokeWidth={2}/>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{
          marginTop: 16, display: "flex", alignItems: "center", gap: 12,
          fontSize: 12.5, color: L.ink2,
        }}>
          <button style={{
            background: "transparent", border: `1px solid ${L.rule}`,
            padding: "7px 12px", borderRadius: 6, fontSize: 12, color: L.ink,
            display: "inline-flex", gap: 6, alignItems: "center",
          }}>
            <Icons.Plus size={12} strokeWidth={1.8}/>
            Open a folder…
          </button>
          <span>or drag a backup folder onto this window.</span>
        </div>
      </div>
    </div>
  );
};

// --- MESSAGES with calendar heatmap gutter ---
const Linen_Messages = () => {
  const { conversations, activeThread } = window.OE_DATA;
  const Icons = window.OEIcons;
  const years = [2019, 2020, 2021, 2022, 2023];
  const months = ["J","F","M","A","M","J","J","A","S","O","N","D"];

  // Deterministic "activity" per year/month — warmer in some years
  const activity = (y, m) => {
    const base = (y === 2023 ? 0.55 : y === 2022 ? 0.45 : y === 2021 ? 0.35 : y === 2020 ? 0.3 : 0.2);
    const wave = 0.3 + Math.abs(Math.sin((y * 12 + m) * 0.9)) * 0.5;
    const special = (y === 2023 && m === 7) ? 1 : (y === 2020 && m === 11) ? 0.95 : 0;
    return Math.min(1, base + wave * 0.5 + special);
  };
  const heatColor = (v) => {
    if (v < 0.12) return L.sunk;
    const lightness = 96 - v * 50;
    const chroma = 0.03 + v * 0.07;
    return `oklch(${lightness}% ${chroma.toFixed(3)} 240)`;
  };

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", background: L.bg }}>
      {/* Conversation list */}
      <aside style={{
        width: 290, flexShrink: 0, borderRight: `1px solid ${L.rule}`,
        display: "flex", flexDirection: "column", background: L.bg,
      }}>
        <div style={{ padding: "16px 18px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Messages</h2>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            background: L.surface, border: `1px solid ${L.rule}`, borderRadius: 6,
            padding: "7px 10px",
          }}>
            <Icons.Search size={13} strokeWidth={1.6} stroke={L.ink3}/>
            <span style={{ fontSize: 12.5, color: L.ink3 }}>Search in 214 threads</span>
            <span style={{ marginLeft: "auto", fontFamily: LF.mono, fontSize: 10, color: L.ink3,
                           background: L.sunk, padding: "1px 5px", borderRadius: 4 }}>⌘F</span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {["All", "Unread", "Photos", "Pinned"].map((t, i) => (
              <button key={t} style={{
                fontSize: 11.5, padding: "4px 9px", borderRadius: 99,
                background: i === 0 ? L.ink : "transparent",
                color: i === 0 ? L.bg : L.ink2,
                border: `1px solid ${i === 0 ? L.ink : L.rule}`,
              }}>{t}</button>
            ))}
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "4px 6px 12px" }}>
          {conversations.map(c => {
            const on = c.id === activeThread.contactId;
            return (
              <div key={c.id} style={{
                display: "flex", gap: 10, padding: "9px 10px",
                borderRadius: 6, cursor: "pointer",
                background: on ? L.accentW : "transparent",
                borderLeft: on ? `2px solid ${L.accent}` : "2px solid transparent",
                marginLeft: on ? 0 : 2,
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
                  background: `oklch(88% 0.04 ${c.avatarHue})`,
                  border: `1px solid ${L.rule}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12.5, color: L.ink, fontWeight: 500,
                }}>{c.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, color: L.ink, fontWeight: on ? 600 : 500, letterSpacing: "-0.005em" }}>{c.name}</span>
                    <span style={{ fontSize: 10.5, color: L.ink3, fontFamily: LF.mono }}>{c.time}</span>
                  </div>
                  <div style={{
                    fontSize: 12, color: L.ink2, marginTop: 1,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>{c.preview}</div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Thread body */}
      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: L.bg }}>
        <div style={{
          padding: "14px 24px", borderBottom: `1px solid ${L.rule}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%",
            background: "oklch(88% 0.04 14)", border: `1px solid ${L.rule}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 500,
          }}>E</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>Emma</div>
            <div style={{ fontSize: 11.5, color: L.ink3, marginTop: 1, fontFamily: LF.mono }}>
              847 messages · 2016–2023 · daughter
            </div>
          </div>
          <button style={{
            background: "transparent", border: `1px solid ${L.rule}`,
            padding: "6px 11px", borderRadius: 6, fontSize: 12, color: L.ink,
            display: "inline-flex", gap: 6, alignItems: "center",
          }}>
            <Icons.Filter size={12} strokeWidth={1.6}/> Filter
          </button>
          <button style={{
            background: L.accent, color: "#fff", border: 0,
            padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500,
            display: "inline-flex", gap: 6, alignItems: "center",
          }}>
            <Icons.Export size={12} strokeWidth={1.8}/> Export
          </button>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Messages */}
          <div style={{ flex: 1, overflow: "auto", padding: "22px 32px 22px" }}>
            <div style={{
              textAlign: "center", fontSize: 11.5, color: L.ink3, fontFamily: LF.mono,
              letterSpacing: "0.08em", marginBottom: 16,
            }}>
              Monday · Aug 14, 2023 · 2:02 PM
            </div>
            {activeThread.messages.map(m => {
              const mine = m.from === "me";
              return (
                <div key={m.id} style={{
                  display: "flex", justifyContent: mine ? "flex-end" : "flex-start",
                  marginBottom: 6,
                }}>
                  <div style={{
                    maxWidth: "62%",
                    background: mine ? L.bubbleMe : L.bubbleThem,
                    color: mine ? L.bg : L.ink,
                    padding: m.kind === "photo" ? 5 : "9px 13px",
                    borderRadius: 14,
                    border: mine ? "none" : `1px solid ${L.rule}`,
                    fontSize: 14, lineHeight: 1.42, letterSpacing: "-0.005em",
                  }}>
                    {m.kind === "photo" ? (
                      <div>
                        <div style={{
                          width: 240, height: 170, borderRadius: 10, overflow: "hidden",
                          background: `
                            linear-gradient(135deg, rgba(74,107,140,.18), rgba(90,140,110,.14)),
                            repeating-linear-gradient(45deg, #e4e2dc 0 10px, #d8d6cf 10px 20px)
                          `,
                          position: "relative",
                        }}>
                          <div style={{
                            position: "absolute", left: 10, bottom: 8, right: 10,
                            fontFamily: LF.mono, fontSize: 10, color: "#2a2a2a",
                            letterSpacing: "0.04em",
                          }}>{m.caption}</div>
                        </div>
                      </div>
                    ) : m.text}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Calendar heatmap gutter — novel bit */}
          <aside style={{
            width: 160, flexShrink: 0, borderLeft: `1px solid ${L.rule}`,
            padding: "22px 16px", display: "flex", flexDirection: "column",
            background: L.bg,
          }}>
            <div style={{ fontSize: 11, color: L.ink3, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 500 }}>
              Activity
            </div>
            <div style={{ fontSize: 11, color: L.ink3, marginTop: 4, fontFamily: LF.mono }}>click a cell</div>

            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 3 }}>
              {/* header row: months */}
              <div style={{ display: "grid", gridTemplateColumns: "30px repeat(12, 1fr)", gap: 2, alignItems: "center" }}>
                <div/>
                {months.map((m, i) => (
                  <div key={i} style={{ fontSize: 8.5, color: L.ink3, textAlign: "center", fontFamily: LF.mono }}>{m}</div>
                ))}
              </div>
              {years.map(y => (
                <div key={y} style={{ display: "grid", gridTemplateColumns: "30px repeat(12, 1fr)", gap: 2, alignItems: "center" }}>
                  <div style={{
                    fontSize: 10, color: y === 2023 ? L.accent : L.ink3, fontFamily: LF.mono, fontWeight: y === 2023 ? 500 : 400,
                  }}>{y}</div>
                  {months.map((_, m) => {
                    const v = activity(y, m);
                    const current = (y === 2023 && m === 7);
                    return (
                      <div key={m} title={`${months[m]} ${y}`} style={{
                        height: 14, borderRadius: 3,
                        background: heatColor(v),
                        border: current ? `1.5px solid ${L.accent}` : `1px solid ${L.rule}`,
                      }}/>
                    );
                  })}
                </div>
              ))}
            </div>

            <div style={{
              marginTop: 18, display: "flex", alignItems: "center", gap: 6,
              fontSize: 10, color: L.ink3, fontFamily: LF.mono,
            }}>
              less
              {[0.05, 0.25, 0.5, 0.75, 1].map(v => (
                <div key={v} style={{ width: 10, height: 10, borderRadius: 2, background: heatColor(v), border: `1px solid ${L.rule}` }}/>
              ))}
              more
            </div>

            <div style={{ flex: 1 }}/>

            <div style={{
              fontSize: 11, color: L.ink2, lineHeight: 1.5,
              paddingTop: 14, borderTop: `1px solid ${L.rule}`, marginTop: 14,
            }}>
              Highlighted: <span style={{ color: L.accent, fontWeight: 500 }}>Aug 2023</span>.
              847 messages total with Emma between 2016 and 2023.
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
};

window.LinenRoot = ({ screen }) => {
  if (screen === "backup") {
    return (
      <Linen_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Linen_Sidebar active="" />
          <Linen_Backup />
        </div>
      </Linen_Chrome>
    );
  }
  if (screen === "messages") {
    return (
      <Linen_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Linen_Sidebar active="messages" />
          <Linen_Messages />
        </div>
      </Linen_Chrome>
    );
  }
  const tokens = {
    bg: L.bg, surface: L.surface, sunk: L.sunk,
    ink: L.ink, ink2: L.ink2, ink3: L.ink3,
    rule: L.rule, ruleStr: L.ruleStr,
    accent: L.accent, accentW: L.accentW,
    sans: LF.sans, serif: LF.serif, mono: LF.mono,
    titleSerif: false, titleWeight: 600, titleLetter: "-0.02em", radius: 8,
    bubbleMe: L.bubbleMe, bubbleThem: L.bubbleThem,
    chipActive: L.ink, chipActiveFg: L.bg, chipFg: L.ink2,
  };
  return window.SharedScreens.render({
    screen, tokens,
    Sidebar: () => <Linen_Sidebar active={screen}/>,
    Chrome: Linen_Chrome,
    backupComponent: Linen_Backup, messagesComponent: Linen_Messages,
  });
};
