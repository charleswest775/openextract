// ======================================================================
// LEDGER — Cool off-white, graphite, single teal accent.
// Tabular density. Hairline rules. Small caps for labels.
// Novel UX: Timeline as a horizontal ribbon (not a list) — a literal
// scrollable river of events with year ticks above.
// Messages scrubber: thin year axis with dotted month ticks.
// ======================================================================

const LG = {
  // tokens for shared-screens
  bg:       "#f6f7f5",
  surface:  "#ffffff",
  sunk:     "#eef0ed",
  ink:      "#161a1a",
  ink2:     "#4a5252",
  ink3:     "#8a9292",
  rule:     "#e3e6e1",
  ruleStr:  "#d1d6d0",
  accent:   "#2d7d7a",
  accentW:  "#e3efee",
  sans:     "'Inter', system-ui, sans-serif",
  serif:    "'Newsreader', serif",
  mono:     "'JetBrains Mono', monospace",
  titleSerif: false,
  titleWeight: 600,
  titleLetter: "-0.02em",
  radius:   4,
  bubbleMe:  "#161a1a",
  bubbleThem:"#eef0ed",
  chipActive: "#161a1a",
  chipActiveFg: "#f6f7f5",
  chipFg: "#4a5252",
};

const LedgerChrome = ({ children }) => (
  <div style={{
    background: LG.bg, color: LG.ink, height: "100%",
    fontFamily: LG.sans, display: "flex", flexDirection: "column",
  }}>
    <div style={{
      height: 42, display: "flex", alignItems: "center", padding: "0 14px",
      background: LG.bg, borderBottom: `1px solid ${LG.rule}`, flexShrink: 0,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{ marginLeft: 16, fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.01em" }}>OpenExtract</div>
      <span style={{ width: 1, height: 14, background: LG.rule, margin: "0 14px" }}/>
      <span style={{ fontSize: 11.5, color: LG.ink2, fontFamily: LG.mono }}>
        mom_iphone13pro_2023-08-14.backup
      </span>
      <div style={{ flex: 1 }}/>
      <span style={{ fontSize: 10.5, color: LG.ink3, fontFamily: LG.mono, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        Local · Read-only
      </span>
    </div>
    {children}
  </div>
);

const LedgerSidebar = ({ active }) => {
  const Icons = window.OEIcons;
  const items = [
    { id: "timeline",  label: "Timeline",  I: Icons.Clock,     c: 65396 },
    { id: "messages",  label: "Messages",  I: Icons.Message,   c: 48213 },
    { id: "photos",    label: "Photos",    I: Icons.Image,     c: 12847 },
    { id: "voicemail", label: "Voicemail", I: Icons.Voicemail, c: 24 },
    { id: "calls",     label: "Calls",     I: Icons.Phone,     c: 4281 },
    { id: "contacts",  label: "Contacts",  I: Icons.User,      c: 612 },
    { id: "notes",     label: "Notes",     I: Icons.FileText,  c: 189 },
  ];
  return (
    <nav style={{
      width: 208, flexShrink: 0, padding: "14px 8px",
      borderRight: `1px solid ${LG.rule}`, background: LG.bg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        fontSize: 10, color: LG.ink3, letterSpacing: "0.1em",
        textTransform: "uppercase", padding: "4px 10px 8px", fontWeight: 600,
      }}>Data</div>
      {items.map(it => {
        const on = it.id === active;
        const I = it.I;
        return (
          <div key={it.id} style={{
            display: "grid", gridTemplateColumns: "18px 1fr auto", alignItems: "center",
            gap: 9, padding: "6px 10px", borderRadius: 4, cursor: "pointer",
            color: on ? LG.ink : LG.ink2,
            background: on ? LG.accentW : "transparent",
            borderLeft: on ? `2px solid ${LG.accent}` : "2px solid transparent",
            marginLeft: on ? 0 : 2,
          }}>
            <I size={14} strokeWidth={1.6} stroke={on ? LG.accent : LG.ink2}/>
            <span style={{ fontSize: 12.5, fontWeight: on ? 500 : 400, letterSpacing: "-0.005em" }}>{it.label}</span>
            <span style={{ fontSize: 10, fontFamily: LG.mono, color: LG.ink3 }}>{it.c.toLocaleString()}</span>
          </div>
        );
      })}
      <div style={{ flex: 1 }}/>
      <div style={{
        padding: "10px 10px 4px", fontSize: 10.5, color: LG.ink3, lineHeight: 1.5,
        borderTop: `1px solid ${LG.rule}`, marginTop: 10, fontFamily: LG.mono,
      }}>
        BACKUP: iPhone 13 Pro<br/>
        OWNER: Mom<br/>
        SIZE: 84.2 GB · encrypted
      </div>
    </nav>
  );
};

// --- Backup picker: tabular ---
const LedgerBackup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;

  return (
    <div style={{ flex: 1, overflow: "auto", background: LG.bg }}>
      <div style={{ padding: "40px 44px 18px" }}>
        <div style={{
          fontSize: 10, color: LG.ink3, letterSpacing: "0.14em",
          textTransform: "uppercase", fontWeight: 600,
        }}>§ Step 1 — Select source</div>
        <h1 style={{
          margin: "10px 0 6px", fontSize: 32, fontWeight: 600,
          letterSpacing: "-0.025em", lineHeight: 1.05,
        }}>Three backups on this Mac.</h1>
        <p style={{
          margin: "6px 0 0", fontSize: 13.5, color: LG.ink2,
          maxWidth: 600, lineHeight: 1.6,
        }}>
          A plain ledger of what we found. Pick one to open — nothing leaves this machine.
        </p>
      </div>

      <div style={{ padding: "0 44px 44px" }}>
        {/* Table */}
        <div style={{
          background: LG.surface, border: `1px solid ${LG.rule}`, borderRadius: 4,
          overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "34px 1.6fr 1fr 1fr 110px 120px",
            padding: "10px 18px", background: LG.sunk,
            borderBottom: `1px solid ${LG.rule}`,
            fontSize: 10, color: LG.ink3, letterSpacing: "0.1em",
            textTransform: "uppercase", fontWeight: 600,
          }}>
            <div>№</div><div>Device</div><div>Period</div><div>Contents</div>
            <div style={{ textAlign: "right" }}>Size</div>
            <div></div>
          </div>
          {backups.map((b, i) => (
            <div key={b.id} style={{
              display: "grid",
              gridTemplateColumns: "34px 1.6fr 1fr 1fr 110px 120px",
              padding: "18px 18px", alignItems: "center",
              borderBottom: i === backups.length - 1 ? "none" : `1px solid ${LG.rule}`,
              gap: 10,
            }}>
              <div style={{ fontFamily: LG.mono, fontSize: 12, color: LG.ink3 }}>0{i+1}</div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.005em" }}>{b.device}</div>
                <div style={{ fontSize: 12, color: LG.ink2, marginTop: 1 }}>{b.owner} · {b.ios}</div>
              </div>
              <div style={{ fontFamily: LG.mono, fontSize: 12, color: LG.ink2 }}>
                {b.years[0]}–{b.years[b.years.length - 1]}
                <div style={{ fontSize: 10.5, color: LG.ink3, marginTop: 2 }}>last: {b.lastBackup}</div>
              </div>
              <div style={{ fontSize: 12, color: LG.ink2, lineHeight: 1.5 }}>
                <div><span style={{ fontFamily: LG.mono, color: LG.ink }}>{b.messages.toLocaleString()}</span> msgs · <span style={{ fontFamily: LG.mono, color: LG.ink }}>{b.photos.toLocaleString()}</span> photos</div>
                <div><span style={{ fontFamily: LG.mono, color: LG.ink }}>{b.calls.toLocaleString()}</span> calls · <span style={{ fontFamily: LG.mono, color: LG.ink }}>{b.voicemails}</span> vm</div>
              </div>
              <div style={{ fontFamily: LG.mono, fontSize: 12, color: LG.ink, textAlign: "right" }}>
                {b.size}
                <div style={{ fontSize: 10, color: LG.ink3, marginTop: 2, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
                  {b.encrypted && <Icons.Lock size={10} strokeWidth={1.7}/>} {b.encrypted ? "encrypted" : "plain"}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button style={{
                  background: i === 0 ? LG.accent : "transparent",
                  color: i === 0 ? "#fff" : LG.ink,
                  border: `1px solid ${i === 0 ? LG.accent : LG.rule}`,
                  padding: "7px 12px", borderRadius: 4,
                  fontSize: 12, fontWeight: 500, fontFamily: LG.sans,
                  display: "inline-flex", gap: 5, alignItems: "center",
                }}>
                  Open <Icons.ArrowRight size={11} strokeWidth={2}/>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: LG.ink2 }}>
          <button style={{
            background: "transparent", border: `1px solid ${LG.rule}`,
            padding: "7px 11px", borderRadius: 4, fontSize: 12, color: LG.ink,
            display: "inline-flex", gap: 6, alignItems: "center", fontFamily: LG.sans,
          }}>
            <Icons.Plus size={11} strokeWidth={1.8}/> Open a folder…
          </button>
          <span>— or drag a backup onto the window.</span>
        </div>
      </div>
    </div>
  );
};

// --- Messages with thin year axis scrubber ---
const LedgerMessages = () => {
  const { conversations, activeThread } = window.OE_DATA;
  const Icons = window.OEIcons;
  const years = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", background: LG.bg, minWidth: 0 }}>
      {/* conversation list */}
      <aside style={{
        width: 278, flexShrink: 0, borderRight: `1px solid ${LG.rule}`,
        display: "flex", flexDirection: "column", background: LG.bg,
      }}>
        <div style={{ padding: "14px 16px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Messages · 214 threads</h2>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            background: LG.surface, border: `1px solid ${LG.rule}`, borderRadius: 4,
            padding: "6px 9px",
          }}>
            <Icons.Search size={12} strokeWidth={1.6} stroke={LG.ink3}/>
            <span style={{ fontSize: 12, color: LG.ink3 }}>Find a person…</span>
            <span style={{ marginLeft: "auto", fontFamily: LG.mono, fontSize: 9.5, color: LG.ink3,
                           background: LG.sunk, padding: "1px 5px", borderRadius: 3 }}>⌘F</span>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "2px 6px 12px" }}>
          {conversations.map(c => {
            const on = c.id === activeThread.contactId;
            return (
              <div key={c.id} style={{
                display: "flex", gap: 10, padding: "9px 10px",
                borderRadius: 4, cursor: "pointer",
                background: on ? LG.accentW : "transparent",
                borderLeft: on ? `2px solid ${LG.accent}` : "2px solid transparent",
                marginLeft: on ? 0 : 2,
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                  background: `oklch(88% 0.04 ${c.avatarHue})`,
                  border: `1px solid ${LG.rule}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, color: LG.ink, fontWeight: 500,
                }}>{c.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 12.5, color: LG.ink, fontWeight: on ? 600 : 500 }}>{c.name}</span>
                    <span style={{ fontSize: 10, color: LG.ink3, fontFamily: LG.mono }}>{c.time}</span>
                  </div>
                  <div style={{
                    fontSize: 11.5, color: LG.ink2, marginTop: 1,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>{c.preview}</div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* thread + scrubber */}
      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          padding: "12px 22px", borderBottom: `1px solid ${LG.rule}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            background: "oklch(88% 0.04 14)", border: `1px solid ${LG.rule}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 500,
          }}>E</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Emma</div>
            <div style={{ fontSize: 11, color: LG.ink3, fontFamily: LG.mono, marginTop: 1 }}>
              847 msgs · 2016–2023
            </div>
          </div>
          <button style={{
            background: "transparent", border: `1px solid ${LG.rule}`,
            padding: "6px 10px", borderRadius: 4, fontSize: 11.5, color: LG.ink,
            display: "inline-flex", gap: 5, alignItems: "center",
          }}>
            <Icons.Filter size={11} strokeWidth={1.6}/> Filter
          </button>
          <button style={{
            background: LG.accent, color: "#fff", border: 0,
            padding: "6px 11px", borderRadius: 4, fontSize: 11.5, fontWeight: 500,
            display: "inline-flex", gap: 5, alignItems: "center",
          }}>
            <Icons.Export size={11} strokeWidth={1.8}/> Export
          </button>
        </div>

        {/* SCRUBBER: thin year axis with dotted ticks */}
        <div style={{
          padding: "14px 32px 12px", borderBottom: `1px solid ${LG.rule}`,
          background: LG.bg,
        }}>
          <div style={{ position: "relative", height: 36 }}>
            {/* axis */}
            <div style={{
              position: "absolute", left: 0, right: 0, top: 18, height: 1,
              background: LG.ruleStr,
            }}/>
            {/* year ticks */}
            {years.map((y, i) => {
              const x = (i / (years.length - 1)) * 100;
              const active = y === 2023;
              return (
                <div key={y} style={{
                  position: "absolute", left: `${x}%`, top: 0,
                  transform: "translateX(-50%)",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                }}>
                  <span style={{
                    fontSize: 10, fontFamily: LG.mono, color: active ? LG.accent : LG.ink3,
                    fontWeight: active ? 600 : 400,
                  }}>{y}</span>
                  <span style={{
                    width: 1, height: 8,
                    background: active ? LG.accent : LG.ink3,
                  }}/>
                </div>
              );
            })}
            {/* month dots */}
            {Array.from({ length: 84 }).map((_, i) => {
              const x = (i / 83) * 100;
              return (
                <span key={i} style={{
                  position: "absolute", left: `${x}%`, top: 30,
                  transform: "translateX(-50%)",
                  width: 2, height: 2, borderRadius: 99,
                  background: i === 80 ? LG.accent : LG.ink3,
                  opacity: i === 80 ? 1 : 0.3,
                }}/>
              );
            })}
            {/* current position handle */}
            <div style={{
              position: "absolute", left: "95.2%", top: 14, transform: "translateX(-50%)",
              width: 8, height: 8, borderRadius: 99, background: LG.accent,
              boxShadow: `0 0 0 4px ${LG.accentW}`,
            }}/>
          </div>
          <div style={{
            display: "flex", justifyContent: "space-between",
            fontSize: 10.5, color: LG.ink3, fontFamily: LG.mono, marginTop: 4,
          }}>
            <span>viewing Aug 2023</span>
            <span>drag to scrub · 847 events on axis</span>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "22px 32px 22px" }}>
          <div style={{
            textAlign: "center", fontSize: 10.5, color: LG.ink3, fontFamily: LG.mono,
            letterSpacing: "0.1em", marginBottom: 14, textTransform: "uppercase",
          }}>— Monday · Aug 14, 2023 · 2:02 PM —</div>
          {activeThread.messages.map(m => {
            const mine = m.from === "me";
            return (
              <div key={m.id} style={{
                display: "flex", justifyContent: mine ? "flex-end" : "flex-start",
                marginBottom: 5,
              }}>
                <div style={{
                  maxWidth: "62%",
                  background: mine ? LG.bubbleMe : LG.bubbleThem,
                  color: mine ? LG.bg : LG.ink,
                  padding: m.kind === "photo" ? 4 : "8px 12px",
                  borderRadius: 10,
                  border: mine ? "none" : `1px solid ${LG.rule}`,
                  fontSize: 13.5, lineHeight: 1.42, letterSpacing: "-0.005em",
                }}>
                  {m.kind === "photo" ? (
                    <div style={{
                      width: 220, height: 160, borderRadius: 7, overflow: "hidden",
                      background: `
                        linear-gradient(135deg, oklch(78% 0.06 45) 0%, oklch(55% 0.09 30) 100%),
                        repeating-linear-gradient(45deg, rgba(255,255,255,.08) 0 10px, rgba(0,0,0,.08) 10px 20px)
                      `, position: "relative",
                    }}>
                      <div style={{
                        position: "absolute", left: 8, bottom: 6, right: 8,
                        fontSize: 10, color: "#fff", fontFamily: LG.mono,
                      }}>{m.caption}</div>
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

// --- Novel TIMELINE: horizontal ribbon river ---
const LedgerTimelineRibbon = () => {
  const Icons = window.OEIcons;
  const events = window.OE_DATA.timeline;
  const typeColor = { photo: 45, message: 220, call: 200, voicemail: 180, note: 80 };
  const typeGlyph = { photo: "◨", message: "▪", call: "●", voicemail: "◇", note: "▲" };

  // lay out events on a horizontal axis — newest at right
  const w = 1000;
  const h = 300;
  const lanes = { photo: 60, message: 110, call: 160, voicemail: 210, note: 260 };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: LG.bg, minWidth: 0 }}>
      <div style={{
        padding: "20px 28px 14px", borderBottom: `1px solid ${LG.rule}`,
        display: "flex", alignItems: "flex-end", gap: 16, flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: LG.ink3, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>
            Timeline · river view
          </div>
          <h1 style={{ margin: "6px 0 0", fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>
            Scroll the whole backup, like a river.
          </h1>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 4,
                           background: LG.ink, color: "#fff", border: 0 }}>Ribbon</button>
          <button style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 4,
                           background: "transparent", color: LG.ink2, border: `1px solid ${LG.rule}` }}>List</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "28px 28px" }}>
        <div style={{
          background: LG.surface, border: `1px solid ${LG.rule}`,
          borderRadius: 4, padding: "18px 18px 14px", overflow: "auto",
        }}>
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block" }}>
            {/* lane labels */}
            {Object.entries(lanes).map(([k, y]) => (
              <g key={k}>
                <line x1={120} x2={w - 20} y1={y} y2={y} stroke={LG.rule} strokeDasharray="2 4"/>
                <text x={12} y={y + 4} fontSize="10" fontFamily={LG.mono} fill={LG.ink3}
                      letterSpacing="0.1em" textTransform="uppercase">
                  {k.toUpperCase()}
                </text>
              </g>
            ))}
            {/* month axis top */}
            {["Jun", "Jul 28", "Aug 04", "Aug 09", "Aug 11", "Aug 13", "Aug 14"].map((lbl, i, arr) => {
              const x = 140 + (i / (arr.length - 1)) * (w - 180);
              return (
                <g key={i}>
                  <line x1={x} x2={x} y1={30} y2={h - 20} stroke={LG.rule} strokeWidth={0.6}/>
                  <text x={x} y={22} fontSize="10" fontFamily={LG.mono} fill={LG.ink3} textAnchor="middle">{lbl}</text>
                </g>
              );
            })}
            {/* events */}
            {events.slice().reverse().map((e, i, arr) => {
              const x = 140 + (i / (arr.length - 1)) * (w - 180);
              const y = lanes[e.type];
              const c = `oklch(52% 0.12 ${typeColor[e.type]})`;
              return (
                <g key={i}>
                  <circle cx={x} cy={y} r={7} fill={c} opacity={0.18}/>
                  <circle cx={x} cy={y} r={3.5} fill={c}/>
                  {i % 2 === 0 && (
                    <text x={x} y={y - 12} fontSize="9.5" fontFamily={LG.sans} fill={LG.ink2} textAnchor="middle">
                      {e.title.length > 22 ? e.title.slice(0, 22) + "…" : e.title}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* legend + count */}
        <div style={{
          marginTop: 14, display: "flex", alignItems: "center", gap: 16,
          fontSize: 11, color: LG.ink2, fontFamily: LG.mono,
        }}>
          {Object.entries(typeColor).map(([k, h]) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: `oklch(52% 0.12 ${h})` }}/>
              {k}
            </span>
          ))}
          <span style={{ marginLeft: "auto", color: LG.ink3 }}>65,396 events across 7 years</span>
        </div>

        {/* last events as a mini-list */}
        <div style={{ marginTop: 22, fontSize: 10.5, color: LG.ink3, letterSpacing: "0.1em",
                       textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>
          Most recent
        </div>
        <div style={{
          background: LG.surface, border: `1px solid ${LG.rule}`, borderRadius: 4,
          overflow: "hidden",
        }}>
          {events.slice(0, 5).map((e, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "90px 90px 1fr auto",
              padding: "10px 16px", gap: 12, alignItems: "center",
              borderBottom: i === 4 ? "none" : `1px solid ${LG.rule}`,
              fontSize: 12.5,
            }}>
              <span style={{ fontFamily: LG.mono, fontSize: 11, color: LG.ink3 }}>{e.date}</span>
              <span style={{ fontFamily: LG.mono, fontSize: 11, color: LG.ink3 }}>{e.time}</span>
              <span><b style={{ fontWeight: 600 }}>{e.title}</b> <span style={{ color: LG.ink2 }}>· {e.meta}</span></span>
              <span style={{ fontSize: 10, color: LG.ink3, fontFamily: LG.mono, letterSpacing: "0.08em", textTransform: "uppercase" }}>{e.type}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

window.LedgerRoot = ({ screen }) => {
  const body = () => {
    switch (screen) {
      case "backup":   return <LedgerBackup/>;
      case "messages": return <LedgerMessages/>;
      case "timeline": return <LedgerTimelineRibbon/>;
      default: break;
    }
    // shared fallback
    return null;
  };

  const sharedBody = body();
  if (sharedBody) {
    return (
      <LedgerChrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {screen !== "backup" && <LedgerSidebar active={screen}/>}
          {sharedBody}
        </div>
      </LedgerChrome>
    );
  }
  return window.SharedScreens.render({
    screen, tokens: LG, Sidebar: LedgerSidebar, Chrome: LedgerChrome,
    backupComponent: LedgerBackup, messagesComponent: LedgerMessages,
  });
};
