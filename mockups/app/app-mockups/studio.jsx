// ======================================================================
// STUDIO — Editorial dark
// Deep plum/ink #14101a with peach accent #f0a07a.
// Oversized Fraunces display, Inter body.
// Novel UX: messages view has a SCRUBBABLE YEAR STRIP at top — drag to jump.
// Backup picker: editorial "cover" treatment with big type and issue numbers.
// ======================================================================

const S = {
  bg:      "#14101a",
  surface: "#1c1824",
  raised:  "#251f2e",
  over:    "#2f2939",
  ink:     "#f4eee8",
  ink2:    "#a79eb0",
  ink3:    "#6c6579",
  rule:    "#2a2432",
  ruleSoft:"#221d2a",
  accent:  "#f0a07a",  // peach
  accent2: "#c58fd4",  // soft orchid for badges
  bubbleMe: "#f0a07a",
  bubbleThem: "#251f2e",
};
const SF = {
  serif: "'Fraunces', 'Instrument Serif', serif",
  sans:  "'Inter', system-ui, sans-serif",
  mono:  "'JetBrains Mono', monospace",
};

const Studio_Chrome = ({ children }) => (
  <div style={{
    background: S.bg, color: S.ink, height: "100%",
    fontFamily: SF.sans, display: "flex", flexDirection: "column",
  }}>
    <div style={{
      height: 44, display: "flex", alignItems: "center", padding: "0 16px",
      background: S.bg, borderBottom: `1px solid ${S.ruleSoft}`, flexShrink: 0,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{
        marginLeft: 16, fontFamily: SF.serif, fontSize: 18, fontWeight: 500, letterSpacing: "-0.015em",
      }}>
        Open<span style={{ fontStyle: "italic", color: S.accent }}>Extract</span>
      </div>
      <div style={{ flex: 1 }}/>
      <div style={{ fontFamily: SF.mono, fontSize: 10.5, color: S.ink3, letterSpacing: "0.14em", textTransform: "uppercase" }}>
        ISSUE 03 · MOM'S PHONE
      </div>
    </div>
    {children}
  </div>
);

const Studio_Sidebar = ({ active }) => {
  const Icons = window.OEIcons;
  const items = [
    { id: "timeline",  label: "Timeline",  n: "01" },
    { id: "messages",  label: "Messages",  n: "02" },
    { id: "photos",    label: "Photos",    n: "03" },
    { id: "voicemail", label: "Voicemail", n: "04" },
    { id: "calls",     label: "Calls",     n: "05" },
    { id: "contacts",  label: "Contacts",  n: "06" },
    { id: "notes",     label: "Notes",     n: "07" },
  ];
  const iconMap = { timeline: Icons.Clock, messages: Icons.Message, photos: Icons.Image,
                    voicemail: Icons.Voicemail, calls: Icons.Phone, contacts: Icons.User, notes: Icons.FileText };
  return (
    <nav style={{
      width: 210, flexShrink: 0, padding: "22px 16px",
      borderRight: `1px solid ${S.ruleSoft}`,
      background: S.bg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        fontFamily: SF.mono, fontSize: 10, letterSpacing: "0.18em",
        color: S.ink3, textTransform: "uppercase", padding: "6px 4px 14px",
      }}>Sections</div>
      {items.map(it => {
        const on = it.id === active;
        const I = iconMap[it.id];
        return (
          <div key={it.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "9px 10px", borderRadius: 8, cursor: "pointer",
            color: on ? S.ink : S.ink2,
            background: on ? S.surface : "transparent",
          }}>
            <span style={{ fontFamily: SF.mono, fontSize: 10, color: on ? S.accent : S.ink3, width: 18 }}>
              {it.n}
            </span>
            <I size={15} strokeWidth={1.6} stroke={on ? S.accent : S.ink2}/>
            <span style={{ fontSize: 13.5, fontWeight: on ? 500 : 400, letterSpacing: "-0.005em" }}>
              {it.label}
            </span>
          </div>
        );
      })}
      <div style={{ flex: 1 }}/>
      <div style={{
        padding: "12px 10px", borderTop: `1px solid ${S.ruleSoft}`,
        fontSize: 11, color: S.ink3, lineHeight: 1.5,
      }}>
        <div style={{ color: S.ink2, fontWeight: 500, fontSize: 12 }}>Privacy</div>
        Nothing sent anywhere. Source open on GitHub.
      </div>
    </nav>
  );
};

// --- BACKUP: editorial cover ---
const Studio_Backup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;

  return (
    <div style={{ flex: 1, overflow: "auto", background: S.bg }}>
      {/* Cover masthead */}
      <div style={{
        padding: "56px 56px 30px", position: "relative",
        borderBottom: `1px solid ${S.ruleSoft}`,
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "flex-end",
          fontFamily: SF.mono, fontSize: 10.5, color: S.ink3, letterSpacing: "0.16em",
          textTransform: "uppercase",
        }}>
          <span>Vol. 1 · Library</span>
          <span>3 backups found · MobileSync</span>
        </div>
        <h1 style={{
          margin: "18px 0 6px",
          fontFamily: SF.serif, fontWeight: 400,
          fontSize: 108, lineHeight: 0.92,
          letterSpacing: "-0.035em",
          maxWidth: 900,
        }}>
          Pick a <span style={{ fontStyle: "italic", color: S.accent }}>phone</span>,<br/>
          open a <span style={{ fontStyle: "italic", color: S.accent2 }}>decade</span>.
        </h1>
        <p style={{ maxWidth: 620, fontSize: 15, color: S.ink2, lineHeight: 1.55, marginTop: 18 }}>
          Every iTunes/Finder backup on this Mac, turned into something you can actually read. Choose one below — we'll open it locally, no accounts, no upload, no rush.
        </p>
      </div>

      {/* Cards */}
      <div style={{
        padding: "30px 56px 56px",
        display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 20,
      }}>
        {backups.map((b, i) => {
          const featured = i === 0;
          return (
            <div key={b.id} style={{
              background: featured ? S.surface : S.bg,
              border: `1px solid ${featured ? S.rule : S.ruleSoft}`,
              borderRadius: 14, padding: featured ? "28px" : "22px",
              display: "flex", flexDirection: "column", gap: 14,
              position: "relative", overflow: "hidden",
            }}>
              {featured && (
                <div style={{
                  position: "absolute", top: 0, right: 0, width: 220, height: 220,
                  background: `radial-gradient(circle at 70% 30%, rgba(240,160,122,.22), transparent 60%)`,
                  pointerEvents: "none",
                }}/>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative" }}>
                <div style={{ fontFamily: SF.mono, fontSize: 10, letterSpacing: "0.14em", color: S.ink3, textTransform: "uppercase" }}>
                  № {String(i + 1).padStart(2, "0")}
                </div>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 10px", borderRadius: 999,
                  border: `1px solid ${b.encrypted ? "rgba(240,160,122,.35)" : S.rule}`,
                  color: b.encrypted ? S.accent : S.ink2, fontSize: 10.5,
                  fontFamily: SF.mono, letterSpacing: "0.06em", textTransform: "uppercase",
                }}>
                  <Icons.Lock size={10} strokeWidth={1.8}/>
                  {b.encrypted ? "Encrypted" : "Open"}
                </div>
              </div>

              <div style={{ position: "relative" }}>
                <div style={{
                  fontFamily: SF.serif, fontWeight: 400,
                  fontSize: featured ? 56 : 34, lineHeight: 0.98,
                  letterSpacing: "-0.025em",
                }}>
                  {b.device}
                </div>
                <div style={{
                  marginTop: 6, fontSize: featured ? 15 : 13, color: S.ink2,
                  fontStyle: "italic", fontFamily: SF.serif,
                }}>
                  “{b.owner}”
                </div>
              </div>

              <div style={{
                display: "flex", gap: 14, flexWrap: "wrap", marginTop: 2,
                fontFamily: SF.mono, fontSize: 10.5, letterSpacing: "0.08em",
                color: S.ink3, textTransform: "uppercase",
              }}>
                <span>{b.ios}</span>
                <span>·</span>
                <span>{b.lastBackup}</span>
                <span>·</span>
                <span>{b.size}</span>
              </div>

              {featured ? (
                <div style={{
                  marginTop: 8, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10,
                }}>
                  {[["Messages", b.messages], ["Photos", b.photos], ["Calls", b.calls], ["Notes", b.notes]].map(([k, v]) => (
                    <div key={k} style={{
                      background: S.raised, border: `1px solid ${S.rule}`,
                      borderRadius: 10, padding: "10px 12px",
                    }}>
                      <div style={{ fontFamily: SF.mono, fontSize: 9.5, color: S.ink3, letterSpacing: "0.12em", textTransform: "uppercase" }}>{k}</div>
                      <div style={{ fontFamily: SF.serif, fontSize: 22, fontWeight: 500, color: S.ink, marginTop: 2 }}>
                        {v.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 4, fontSize: 12.5, color: S.ink2, lineHeight: 1.55 }}>
                  {b.messages.toLocaleString()} messages · {b.photos.toLocaleString()} photos · {b.voicemails} voicemails
                </div>
              )}

              <div style={{ flex: 1 }}/>

              <button style={{
                marginTop: 8,
                background: featured ? S.accent : "transparent",
                color: featured ? S.bg : S.ink,
                border: featured ? 0 : `1px solid ${S.rule}`,
                padding: "11px 16px", borderRadius: 10,
                fontSize: 13, fontWeight: 500, letterSpacing: "-0.005em",
                display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "center",
              }}>
                {featured ? "Open this backup" : "Open"}
                <Icons.ArrowRight size={14} strokeWidth={1.9}/>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- MESSAGES with scrubbable year strip ---
const Studio_Messages = () => {
  const { conversations, activeThread } = window.OE_DATA;
  const Icons = window.OEIcons;
  const years = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
  const activeYearIdx = 7;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      {/* Scrubbable year strip — novel UX element */}
      <div style={{
        padding: "16px 28px 14px",
        borderBottom: `1px solid ${S.ruleSoft}`,
        background: `linear-gradient(180deg, ${S.bg}, ${S.surface})`,
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10,
        }}>
          <div style={{ fontFamily: SF.mono, fontSize: 10, color: S.ink3, letterSpacing: "0.16em", textTransform: "uppercase" }}>
            Drag to travel in time — Emma · 847 messages
          </div>
          <div style={{ fontFamily: SF.serif, fontSize: 22, fontStyle: "italic", color: S.accent, letterSpacing: "-0.02em" }}>
            August 2023
          </div>
        </div>
        <div style={{ position: "relative", height: 56 }}>
          {/* activity histogram */}
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "end", gap: 2,
          }}>
            {Array.from({ length: 96 }).map((_, i) => {
              const density = 0.3 + Math.abs(Math.sin(i * 0.23)) * 0.6 + (i % 11 === 0 ? 0.15 : 0);
              const h = 10 + density * 40;
              const passed = i <= 94;
              return <div key={i} style={{
                flex: 1, height: h, borderRadius: 2,
                background: passed
                  ? `linear-gradient(180deg, ${S.accent} 0%, rgba(240,160,122,.3) 100%)`
                  : S.raised,
                opacity: passed ? 0.9 : 0.5,
              }}/>;
            })}
          </div>
          {/* year ticks */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                        display: "flex", alignItems: "flex-end", pointerEvents: "none" }}>
            {years.map((y, i) => (
              <div key={y} style={{
                flex: 1, borderLeft: i === 0 ? "none" : `1px dashed ${S.rule}`,
                padding: "0 0 -22px 6px", color: i === activeYearIdx ? S.accent : S.ink3,
                fontFamily: SF.mono, fontSize: 10, letterSpacing: "0.1em",
                position: "relative", height: "100%",
              }}>
                <span style={{ position: "absolute", bottom: -18, left: 6 }}>{y}</span>
              </div>
            ))}
          </div>
          {/* playhead */}
          <div style={{
            position: "absolute", top: -4, bottom: -22,
            left: "96%", width: 2, background: S.accent,
            boxShadow: `0 0 14px ${S.accent}`,
          }}>
            <div style={{
              position: "absolute", top: -6, left: -5, width: 12, height: 12,
              borderRadius: "50%", background: S.accent,
              boxShadow: `0 0 0 3px rgba(240,160,122,.25)`,
            }}/>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* People rail */}
        <aside style={{
          width: 270, flexShrink: 0, borderRight: `1px solid ${S.ruleSoft}`,
          display: "flex", flexDirection: "column", background: S.bg,
        }}>
          <div style={{
            padding: "16px 18px 12px",
            display: "flex", alignItems: "center", gap: 8,
            background: S.surface, border: `1px solid ${S.rule}`, borderRadius: 10,
            margin: "16px 14px 8px",
          }}>
            <Icons.Search size={13} strokeWidth={1.7} stroke={S.ink3}/>
            <span style={{ fontSize: 12.5, color: S.ink3 }}>Search 214 conversations</span>
          </div>
          <div style={{ overflow: "auto", flex: 1, padding: "6px 10px 10px" }}>
            {conversations.map(c => {
              const on = c.id === activeThread.contactId;
              return (
                <div key={c.id} style={{
                  display: "flex", gap: 11, padding: "10px 10px",
                  borderRadius: 10, marginBottom: 1, cursor: "pointer",
                  background: on ? S.surface : "transparent",
                  border: `1px solid ${on ? S.rule : "transparent"}`,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                    background: `oklch(55% 0.12 ${c.avatarHue})`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontFamily: SF.serif, fontSize: 15,
                  }}>{c.name[0]}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: 13.5, color: S.ink, fontWeight: on ? 500 : 400, letterSpacing: "-0.005em" }}>{c.name}</span>
                      <span style={{ fontSize: 10.5, fontFamily: SF.mono, color: S.ink3 }}>{c.time}</span>
                    </div>
                    <div style={{
                      fontSize: 12.5, color: S.ink2, marginTop: 2,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>{c.preview}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Thread */}
        <section style={{
          flex: 1, display: "flex", flexDirection: "column", minWidth: 0,
          background: S.bg,
        }}>
          <div style={{
            padding: "18px 32px", borderBottom: `1px solid ${S.ruleSoft}`,
            display: "flex", alignItems: "flex-end", gap: 14,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: "50%",
              background: `oklch(55% 0.12 14)`,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontFamily: SF.serif, fontSize: 22,
            }}>E</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: SF.serif, fontSize: 42, fontWeight: 400, letterSpacing: "-0.03em", lineHeight: 1 }}>
                Emma.
              </div>
              <div style={{
                fontFamily: SF.mono, fontSize: 10.5, color: S.ink3,
                letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 8,
              }}>
                Daughter · 847 messages · Opened Aug 14, 2023
              </div>
            </div>
            <button style={{
              background: S.accent, color: S.bg, border: 0,
              padding: "9px 16px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em",
              display: "inline-flex", gap: 7, alignItems: "center",
            }}>
              <Icons.Export size={13} strokeWidth={2}/>
              Save thread
            </button>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: "22px 32px 22px" }}>
            <div style={{
              fontFamily: SF.mono, fontSize: 10, letterSpacing: "0.14em",
              color: S.ink3, textAlign: "center", textTransform: "uppercase",
              marginBottom: 18,
            }}>
              ── Monday, Aug 14, 2023 ──
            </div>
            {activeThread.messages.map(m => {
              const mine = m.from === "me";
              return (
                <div key={m.id} style={{
                  display: "flex", justifyContent: mine ? "flex-end" : "flex-start",
                  marginBottom: 8,
                }}>
                  <div style={{
                    maxWidth: "62%",
                    background: mine ? S.bubbleMe : S.bubbleThem,
                    color: mine ? S.bg : S.ink,
                    padding: m.kind === "photo" ? 6 : "10px 15px",
                    borderRadius: 16,
                    border: mine ? "none" : `1px solid ${S.rule}`,
                    fontSize: 14.5, lineHeight: 1.4, letterSpacing: "-0.005em",
                  }}>
                    {m.kind === "photo" ? (
                      <div>
                        <div style={{
                          width: 260, height: 180, borderRadius: 12, overflow: "hidden",
                          background: `
                            linear-gradient(135deg, rgba(240,160,122,.35), rgba(197,143,212,.3)),
                            repeating-linear-gradient(45deg, #3a3145 0 10px, #2d2635 10px 20px)
                          `,
                          position: "relative",
                        }}>
                          <div style={{
                            position: "absolute", left: 12, bottom: 10, right: 12,
                            fontFamily: SF.mono, fontSize: 10.5, color: "#fff6e9",
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
        </section>
      </div>
    </div>
  );
};

window.StudioRoot = ({ screen }) => {
  if (screen === "backup") {
    return (
      <Studio_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Studio_Sidebar active="" />
          <Studio_Backup />
        </div>
      </Studio_Chrome>
    );
  }
  if (screen === "messages") {
    return (
      <Studio_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Studio_Sidebar active="messages" />
          <Studio_Messages />
        </div>
      </Studio_Chrome>
    );
  }
  const tokens = {
    bg: S.bg, surface: S.surface, sunk: S.raised,
    ink: S.ink, ink2: S.ink2, ink3: S.ink3,
    rule: S.rule, ruleStr: S.rule,
    accent: S.accent, accentW: "rgba(240,160,122,0.10)",
    sans: SF.sans, serif: SF.serif, mono: SF.mono,
    titleSerif: true, titleWeight: 400, titleLetter: "-0.03em", radius: 8,
    bubbleMe: S.bubbleMe, bubbleThem: S.bubbleThem,
    chipActive: S.accent, chipActiveFg: S.bg, chipFg: S.ink2,
  };
  return window.SharedScreens.render({
    screen, tokens,
    Sidebar: () => <Studio_Sidebar active={screen}/>,
    Chrome: Studio_Chrome,
    backupComponent: Studio_Backup, messagesComponent: Studio_Messages,
  });
};
