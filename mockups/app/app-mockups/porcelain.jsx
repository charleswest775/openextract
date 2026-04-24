// ======================================================================
// PORCELAIN — Near-white, one strong accent (deep ultramarine).
// Restrained, confident. Editorial-clean.
// Novel UX: Voicemail with a cassette-tape tactile player (with spools).
// ======================================================================

const PC = {
  bg:       "#fbfbfb",
  surface:  "#ffffff",
  sunk:     "#f3f3f3",
  ink:      "#0e0e14",
  ink2:     "#505058",
  ink3:     "#8a8a90",
  rule:     "#e9e9ec",
  ruleStr:  "#d8d8dc",
  accent:   "#2848c8",
  accentW:  "#e3e7f8",
  sans:     "'Inter', system-ui, sans-serif",
  serif:    "'Instrument Serif', 'Newsreader', serif",
  mono:     "'JetBrains Mono', monospace",
  titleSerif: false,
  titleWeight: 600,
  titleLetter: "-0.025em",
  radius:   6,
  bubbleMe:  "#2848c8",
  bubbleThem:"#f3f3f3",
  chipActive: "#0e0e14",
  chipActiveFg: "#ffffff",
  chipFg: "#505058",
};

const PorcelainChrome = ({ children }) => (
  <div style={{
    background: PC.bg, color: PC.ink, height: "100%",
    fontFamily: PC.sans, display: "flex", flexDirection: "column",
  }}>
    <div style={{
      height: 42, display: "flex", alignItems: "center", padding: "0 16px",
      background: PC.bg, borderBottom: `1px solid ${PC.rule}`, flexShrink: 0,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{ marginLeft: 16, fontSize: 13, fontWeight: 600, letterSpacing: "-0.015em" }}>OpenExtract</div>
      <span style={{ width: 3, height: 3, borderRadius: 99, background: PC.ink3, margin: "0 10px" }}/>
      <span style={{ fontSize: 12, color: PC.ink2 }}>iPhone 13 Pro · Mom</span>
      <div style={{ flex: 1 }}/>
      <span style={{ fontSize: 10.5, color: PC.ink3, fontFamily: PC.mono, letterSpacing: "0.08em" }}>
        ⎯ offline, always
      </span>
    </div>
    {children}
  </div>
);

const PorcelainSidebar = ({ active }) => {
  const Icons = window.OEIcons;
  const items = [
    { id: "timeline",  label: "Timeline",  I: Icons.Clock },
    { id: "messages",  label: "Messages",  I: Icons.Message },
    { id: "photos",    label: "Photos",    I: Icons.Image },
    { id: "voicemail", label: "Voicemail", I: Icons.Voicemail },
    { id: "calls",     label: "Calls",     I: Icons.Phone },
    { id: "contacts",  label: "Contacts",  I: Icons.User },
    { id: "notes",     label: "Notes",     I: Icons.FileText },
  ];
  return (
    <nav style={{
      width: 204, flexShrink: 0, padding: "16px 10px",
      borderRight: `1px solid ${PC.rule}`, background: PC.bg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ fontSize: 10.5, color: PC.ink3, letterSpacing: "0.12em",
                    textTransform: "uppercase", padding: "4px 10px 10px", fontWeight: 600 }}>Library</div>
      {items.map(it => {
        const on = it.id === active;
        const I = it.I;
        return (
          <div key={it.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "7px 10px", borderRadius: 6, cursor: "pointer",
            color: on ? PC.ink : PC.ink2,
            background: on ? PC.accentW : "transparent",
            borderLeft: on ? `2px solid ${PC.accent}` : "2px solid transparent",
            marginLeft: on ? 0 : 2, marginBottom: 1,
          }}>
            <I size={14} strokeWidth={1.6} stroke={on ? PC.accent : PC.ink2}/>
            <span style={{ fontSize: 13, fontWeight: on ? 600 : 400, letterSpacing: "-0.005em" }}>{it.label}</span>
          </div>
        );
      })}
    </nav>
  );
};

const PorcelainBackup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;
  return (
    <div style={{ flex: 1, overflow: "auto", background: PC.bg }}>
      <div style={{ padding: "64px 72px 22px", maxWidth: 900 }}>
        <div style={{ fontSize: 11, color: PC.accent, letterSpacing: "0.12em",
                      textTransform: "uppercase", fontWeight: 600 }}>OpenExtract</div>
        <h1 style={{
          margin: "16px 0 12px", fontSize: 56, fontWeight: 600,
          letterSpacing: "-0.03em", lineHeight: 1.02,
        }}>
          Three backups.<br/>
          <span style={{ color: PC.ink3 }}>One is most recent.</span>
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 15, color: PC.ink2, lineHeight: 1.6, maxWidth: 560 }}>
          Choose a backup. Everything is processed locally; no account, no upload.
        </p>
      </div>

      <div style={{ padding: "0 72px 72px" }}>
        {backups.map((b, i) => (
          <div key={b.id} style={{
            display: "grid", gridTemplateColumns: "60px 1.4fr 1fr 1fr 140px",
            alignItems: "center", gap: 18, padding: "22px 0",
            borderBottom: `1px solid ${PC.rule}`,
          }}>
            <div style={{
              fontSize: 40, fontWeight: 600, color: i === 0 ? PC.accent : PC.ink3,
              letterSpacing: "-0.02em", fontFamily: PC.sans,
            }}>0{i+1}</div>
            <div>
              <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.015em" }}>{b.device}</div>
              <div style={{ fontSize: 13, color: PC.ink2, marginTop: 2 }}>{b.owner} · {b.ios}</div>
            </div>
            <div style={{ fontSize: 12.5, color: PC.ink2, lineHeight: 1.6, fontFamily: PC.mono }}>
              {b.years[0]}—{b.years[b.years.length-1]}<br/>
              <span style={{ color: PC.ink3 }}>last {b.lastBackup}</span>
            </div>
            <div style={{ fontSize: 12.5, color: PC.ink2, lineHeight: 1.6 }}>
              <span style={{ color: PC.ink, fontFamily: PC.mono }}>{b.messages.toLocaleString()}</span> msgs ·
              <span style={{ color: PC.ink, fontFamily: PC.mono }}> {b.photos.toLocaleString()}</span> photos<br/>
              <span style={{ color: PC.ink, fontFamily: PC.mono }}>{b.calls.toLocaleString()}</span> calls ·
              <span style={{ color: PC.ink, fontFamily: PC.mono }}> {b.voicemails}</span> vm
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button style={{
                background: i === 0 ? PC.accent : PC.ink,
                color: "#fff", border: 0,
                padding: "10px 18px", borderRadius: 6,
                fontSize: 13, fontWeight: 500,
                display: "inline-flex", gap: 6, alignItems: "center",
              }}>
                Open <Icons.ArrowRight size={12} strokeWidth={2}/>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PorcelainMessages = () => {
  const { conversations, activeThread } = window.OE_DATA;
  const Icons = window.OEIcons;

  return (
    <div style={{ flex: 1, display: "flex", background: PC.bg, minWidth: 0 }}>
      <aside style={{
        width: 280, flexShrink: 0, borderRight: `1px solid ${PC.rule}`,
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "16px 16px 10px" }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: "-0.015em" }}>Messages</h2>
          <div style={{ fontSize: 11.5, color: PC.ink3, marginTop: 2, fontFamily: PC.mono }}>214 threads · 48,213 total</div>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "4px 8px 12px" }}>
          {conversations.map(c => {
            const on = c.id === activeThread.contactId;
            return (
              <div key={c.id} style={{
                display: "flex", gap: 10, padding: "9px 10px",
                borderRadius: 6, cursor: "pointer",
                background: on ? PC.accentW : "transparent",
                borderLeft: on ? `2px solid ${PC.accent}` : "2px solid transparent",
                marginLeft: on ? 0 : 2, marginBottom: 1,
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                  background: `oklch(88% 0.04 ${c.avatarHue})`,
                  border: `1px solid ${PC.rule}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, color: PC.ink, fontWeight: 500,
                }}>{c.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, color: PC.ink, fontWeight: on ? 600 : 500 }}>{c.name}</span>
                    <span style={{ fontSize: 10, color: PC.ink3, fontFamily: PC.mono }}>{c.time}</span>
                  </div>
                  <div style={{
                    fontSize: 11.5, color: PC.ink2, marginTop: 2,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>{c.preview}</div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          padding: "14px 26px", borderBottom: `1px solid ${PC.rule}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: "50%",
            background: "oklch(88% 0.04 14)", border: `1px solid ${PC.rule}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 600,
          }}>E</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Emma</div>
            <div style={{ fontSize: 11.5, color: PC.ink3, marginTop: 1, fontFamily: PC.mono }}>847 msgs · 2016—2023</div>
          </div>
          <button style={{
            background: PC.accent, color: "#fff", border: 0,
            padding: "7px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500,
            display: "inline-flex", gap: 5, alignItems: "center",
          }}>
            <Icons.Export size={12} strokeWidth={1.8}/> Export
          </button>
        </div>

        {/* scrubber: minimal dotted spine */}
        <div style={{ padding: "14px 28px 10px", borderBottom: `1px solid ${PC.rule}` }}>
          <div style={{ position: "relative", height: 26 }}>
            <div style={{
              position: "absolute", left: 0, right: 0, top: 12, height: 0,
              borderTop: `1.5px dotted ${PC.ruleStr}`,
            }}/>
            {[2016,2017,2018,2019,2020,2021,2022,2023].map((y, i, arr) => {
              const x = (i / (arr.length - 1)) * 100;
              const active = y === 2023;
              return (
                <div key={y} style={{
                  position: "absolute", left: `${x}%`, top: 0,
                  transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center",
                }}>
                  <span style={{ fontSize: 10, color: active ? PC.accent : PC.ink3,
                                  fontFamily: PC.mono, fontWeight: active ? 600 : 400 }}>{y}</span>
                  <span style={{ marginTop: 2, width: active ? 10 : 4, height: active ? 10 : 4, borderRadius: 99,
                                  background: active ? PC.accent : PC.ruleStr,
                                  boxShadow: active ? `0 0 0 3px ${PC.accentW}` : "none" }}/>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "22px 32px" }}>
          <div style={{
            textAlign: "center", fontSize: 11, color: PC.ink3, fontFamily: PC.mono,
            letterSpacing: "0.1em", marginBottom: 16, textTransform: "uppercase",
          }}>Aug 14, 2023 · 2:02 PM</div>
          {activeThread.messages.map(m => {
            const mine = m.from === "me";
            return (
              <div key={m.id} style={{
                display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 5,
              }}>
                <div style={{
                  maxWidth: "62%",
                  background: mine ? PC.bubbleMe : PC.bubbleThem,
                  color: mine ? "#fff" : PC.ink,
                  padding: m.kind === "photo" ? 4 : "9px 13px",
                  borderRadius: 12,
                  fontSize: 13.5, lineHeight: 1.42,
                }}>
                  {m.kind === "photo" ? (
                    <div style={{
                      width: 220, height: 160, borderRadius: 8, overflow: "hidden",
                      background: "linear-gradient(135deg, oklch(72% 0.1 45), oklch(50% 0.14 25))",
                      position: "relative",
                    }}>
                      <div style={{ position: "absolute", left: 8, bottom: 6, right: 8,
                                     fontSize: 10, color: "#fff", fontFamily: PC.mono }}>{m.caption}</div>
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

// --- Novel VOICEMAIL: cassette-tape player ---
const PorcelainVoicemailNovel = ({ active, tokens: T }) => {
  const Icons = window.OEIcons;
  return (
    <div style={{ flex: 1, padding: "32px 36px", overflow: "auto" }}>
      {/* cassette body */}
      <div style={{
        background: "#1a1a1e", borderRadius: 14,
        padding: "22px 26px 24px", position: "relative",
        boxShadow: "0 30px 60px rgba(0,0,0,.18), inset 0 0 0 1px rgba(255,255,255,.06)",
        maxWidth: 720,
      }}>
        {/* top label area */}
        <div style={{
          background: "#f7f3e9", borderRadius: 6, padding: "14px 16px 16px",
          border: "1px solid #d8d0b8", marginBottom: 18, position: "relative",
        }}>
          <div style={{ fontSize: 10, color: "#7a6f50", letterSpacing: "0.14em",
                         textTransform: "uppercase", fontWeight: 700, fontFamily: T.mono }}>
            voicemail · side A
          </div>
          <div style={{
            fontFamily: T.serif, fontSize: 22, color: "#222", marginTop: 4,
            letterSpacing: "-0.01em",
          }}>{active.from}</div>
          <div style={{
            fontFamily: T.mono, fontSize: 11, color: "#6a6a6a", marginTop: 2,
          }}>{active.date} · {active.time} · {active.duration}</div>
          <div style={{
            position: "absolute", right: 14, top: 12,
            fontFamily: T.mono, fontSize: 10, color: "#a89b7a", letterSpacing: "0.1em",
          }}>C‑90</div>
        </div>

        {/* spools */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-around",
          padding: "0 4px", marginBottom: 16,
        }}>
          {[0, 1].map(s => (
            <div key={s} style={{
              width: 110, height: 110, borderRadius: "50%",
              background: "radial-gradient(circle at 50% 50%, #2a2a30 0%, #141418 70%)",
              border: "2px solid #3a3a42", position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {/* spokes */}
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={{
                  position: "absolute", width: 4, height: 58,
                  background: "#3a3a42", borderRadius: 2,
                  transform: `rotate(${i * 30 + (s * 15)}deg)`,
                  transformOrigin: "center",
                }}/>
              ))}
              {/* hub */}
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                background: T.accent, border: "2px solid #1a1a1e",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <div style={{ width: 8, height: 8, background: "#1a1a1e", borderRadius: 99 }}/>
              </div>
            </div>
          ))}
        </div>

        {/* tape window */}
        <div style={{
          height: 14, background: "#6b5a3a", borderRadius: 3,
          margin: "0 30px 18px", position: "relative",
          boxShadow: "inset 0 2px 4px rgba(0,0,0,.5)",
        }}>
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: 0,
            width: "62%", background: "#8b7a4a", borderRadius: 3,
          }}/>
        </div>

        {/* transport */}
        <div style={{
          display: "flex", gap: 8, justifyContent: "center", alignItems: "center",
        }}>
          {["⏮", "⏸", "▶", "⏹", "⏭"].map((c, i) => (
            <button key={i} style={{
              width: i === 2 ? 54 : 40, height: 40,
              borderRadius: 8, border: "1px solid #3a3a42",
              background: i === 2 ? T.accent : "#2a2a30",
              color: "#fff", fontSize: 14,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{c}</button>
          ))}
          <div style={{ flex: 1 }}/>
          <div style={{ fontFamily: T.mono, fontSize: 11, color: "#bbb" }}>0:14 / {active.duration}</div>
        </div>
      </div>

      {/* transcript below */}
      <div style={{
        marginTop: 26, paddingTop: 20, borderTop: `1px solid ${T.rule}`, maxWidth: 680,
      }}>
        <div style={{ fontSize: 10.5, color: T.ink3, letterSpacing: "0.1em",
                       textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Transcript</div>
        <div style={{ fontFamily: T.serif, fontSize: 20, lineHeight: 1.55, color: T.ink, letterSpacing: "-0.005em" }}>
          "{active.transcript}"
        </div>
      </div>
    </div>
  );
};

window.PorcelainRoot = ({ screen }) => {
  const overrides = {
    backup:   <PorcelainBackup/>,
    messages: <PorcelainMessages/>,
  };
  const custom = overrides[screen];
  if (custom) {
    return (
      <PorcelainChrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {screen !== "backup" && <PorcelainSidebar active={screen}/>}
          {custom}
        </div>
      </PorcelainChrome>
    );
  }
  return window.SharedScreens.render({
    screen, tokens: PC, Sidebar: PorcelainSidebar, Chrome: PorcelainChrome,
    backupComponent: PorcelainBackup, messagesComponent: PorcelainMessages,
    novelVoicemail: (args) => <PorcelainVoicemailNovel {...args}/>,
  });
};
