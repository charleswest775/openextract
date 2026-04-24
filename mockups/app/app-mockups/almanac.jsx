// ======================================================================
// ALMANAC — Field journal aesthetic
// Warm paper #f6eee4, ink #201a15, terracotta #c85a3a accent.
// Instrument Serif display, Geist body, IBM Plex Mono for data.
// Novel UX: backups shown as a ledger on a vertical time-rail;
// messages view has a right-margin annotation rail with dated callouts.
// ======================================================================

const A_TOKENS = {
  paper:    "#f6eee4",
  paperAlt: "#efe5d5",
  ink:      "#201a15",
  ink2:     "#5a4f46",
  ink3:     "#8f8475",
  rule:     "#d9ccb7",
  ruleSoft: "#e6dcc8",
  accent:   "#c85a3a",
  accent2:  "#8a7a5a",
  accent3:  "#e6b070",
  bubbleMe: "#201a15",   // ink bubble for outgoing
  bubbleThem: "#ece1cd", // warm card for incoming
};

const A_FONTS = {
  serif: "'Instrument Serif', 'Newsreader', serif",
  sans:  "'Geist', system-ui, sans-serif",
  mono:  "'IBM Plex Mono', ui-monospace, monospace",
};

const Almanac_Chrome = ({ children, title, subtitle, right }) => (
  <div style={{
    background: A_TOKENS.paper, color: A_TOKENS.ink, height: "100%",
    fontFamily: A_FONTS.sans, display: "flex", flexDirection: "column"
  }}>
    {/* Title bar — mac traffic lights + wordmark */}
    <div style={{
      height: 44, display: "flex", alignItems: "center", padding: "0 16px",
      borderBottom: `1px solid ${A_TOKENS.ruleSoft}`, flexShrink: 0,
      background: A_TOKENS.paper,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{
        marginLeft: 16, fontFamily: A_FONTS.serif, fontSize: 18,
        letterSpacing: "-0.01em", fontWeight: 400,
      }}>
        Open<span style={{ fontStyle: "italic", color: A_TOKENS.accent }}>Extract</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ fontFamily: A_FONTS.mono, fontSize: 10.5, color: A_TOKENS.ink3, letterSpacing: "0.04em" }}>
        VOL. I · No. 3 · {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </div>
    </div>
    {children}
  </div>
);

const Almanac_Sidebar = ({ active = "messages" }) => {
  const Icons = window.OEIcons;
  const items = [
    { id: "timeline",  label: "Timeline",  count: "—",      I: Icons.Clock },
    { id: "messages",  label: "Messages",  count: "48,213", I: Icons.Message },
    { id: "photos",    label: "Photos",    count: "12,847", I: Icons.Image },
    { id: "voicemail", label: "Voicemail", count: "24",     I: Icons.Voicemail },
    { id: "calls",     label: "Calls",     count: "4,281",  I: Icons.Phone },
    { id: "contacts",  label: "Contacts",  count: "612",    I: Icons.User },
    { id: "notes",     label: "Notes",     count: "189",    I: Icons.FileText },
  ];
  return (
    <nav style={{
      width: 220, flexShrink: 0, padding: "18px 14px",
      borderRight: `1px solid ${A_TOKENS.ruleSoft}`,
      background: A_TOKENS.paperAlt,
    }}>
      <div style={{
        fontFamily: A_FONTS.mono, fontSize: 10, letterSpacing: "0.14em",
        color: A_TOKENS.ink3, textTransform: "uppercase", padding: "6px 8px 10px",
      }}>§ Contents</div>
      {items.map((it, i) => {
        const I = it.I;
        const on = it.id === active;
        return (
          <div key={it.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 10px", borderRadius: 6,
            background: on ? A_TOKENS.paper : "transparent",
            color: on ? A_TOKENS.ink : A_TOKENS.ink2,
            position: "relative", cursor: "pointer",
            borderLeft: on ? `2px solid ${A_TOKENS.accent}` : "2px solid transparent",
            marginLeft: on ? 0 : 2,
          }}>
            <I size={15} strokeWidth={1.5} stroke={on ? A_TOKENS.accent : A_TOKENS.ink2} />
            <span style={{
              fontSize: 13, fontWeight: on ? 500 : 400, letterSpacing: "-0.005em",
              flex: 1,
            }}>{it.label}</span>
            <span style={{ fontFamily: A_FONTS.mono, fontSize: 10, color: A_TOKENS.ink3 }}>
              {it.count}
            </span>
          </div>
        );
      })}
      <div style={{
        marginTop: 22, padding: "12px", borderTop: `1px dashed ${A_TOKENS.rule}`,
        fontFamily: A_FONTS.serif, fontSize: 14, fontStyle: "italic",
        color: A_TOKENS.ink2, lineHeight: 1.35,
      }}>
        “Nothing leaves this machine.”
        <div style={{ fontFamily: A_FONTS.mono, fontSize: 9.5, color: A_TOKENS.ink3, letterSpacing: "0.1em", marginTop: 6 }}>
          — LOCAL · OFFLINE · OPEN SOURCE
        </div>
      </div>
    </nav>
  );
};

// ------ BACKUP SELECTOR: ledger on a vertical time-rail ------
const Almanac_Backup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: A_TOKENS.paper, overflow: "auto",
    }}>
      {/* Masthead */}
      <div style={{ padding: "44px 64px 28px" }}>
        <div style={{
          fontFamily: A_FONTS.mono, fontSize: 10, letterSpacing: "0.18em",
          color: A_TOKENS.ink3, textTransform: "uppercase",
        }}>§ 01 — Choose a backup</div>
        <h1 style={{
          fontFamily: A_FONTS.serif, fontSize: 64, lineHeight: 1.02, margin: "10px 0 8px",
          fontWeight: 400, letterSpacing: "-0.02em",
        }}>
          Three <span style={{ fontStyle: "italic", color: A_TOKENS.accent }}>time capsules</span><br/>
          found on this Mac.
        </h1>
        <p style={{
          maxWidth: 640, fontSize: 14.5, lineHeight: 1.55, color: A_TOKENS.ink2,
          margin: "6px 0 0",
        }}>
          We looked in <span style={{ fontFamily: A_FONTS.mono, fontSize: 12 }}>~/Library/Application Support/MobileSync</span> and
          cross-referenced Finder's index. Pick a backup to open — we'll read it here, never upload anything.
        </p>
      </div>

      {/* Ledger */}
      <div style={{ padding: "0 64px 44px", position: "relative" }}>
        {/* Column header */}
        <div style={{
          display: "grid", gridTemplateColumns: "90px 1fr 200px 180px 140px",
          gap: 18, padding: "10px 0 12px",
          borderBottom: `1px solid ${A_TOKENS.rule}`,
          fontFamily: A_FONTS.mono, fontSize: 9.5, letterSpacing: "0.14em",
          color: A_TOKENS.ink3, textTransform: "uppercase",
        }}>
          <div>Year</div>
          <div>Device</div>
          <div>What's inside</div>
          <div>Size · Encryption</div>
          <div style={{ textAlign: "right" }}>—</div>
        </div>

        {/* Entries */}
        {backups.map((b, i) => {
          const year = b.lastBackup.match(/\d{4}/)[0];
          const featured = i === 0;
          return (
            <div key={b.id} style={{
              display: "grid", gridTemplateColumns: "90px 1fr 200px 180px 140px",
              gap: 18, alignItems: "stretch",
              padding: "22px 0",
              borderBottom: `1px solid ${A_TOKENS.ruleSoft}`,
              position: "relative",
            }}>
              {/* Year — huge numeral */}
              <div style={{
                fontFamily: A_FONTS.serif, fontSize: 48, lineHeight: 1,
                fontWeight: 400, color: featured ? A_TOKENS.accent : A_TOKENS.ink,
                letterSpacing: "-0.02em",
              }}>
                {year}
                <div style={{
                  fontFamily: A_FONTS.mono, fontSize: 10, color: A_TOKENS.ink3,
                  letterSpacing: "0.06em", marginTop: 4,
                }}>{b.relative}</div>
              </div>

              {/* Device */}
              <div>
                <div style={{
                  fontFamily: A_FONTS.serif, fontSize: 26, lineHeight: 1.1,
                  fontWeight: 400, letterSpacing: "-0.01em",
                }}>{b.device}</div>
                <div style={{
                  fontSize: 13, color: A_TOKENS.ink2, marginTop: 4,
                  fontStyle: "italic", fontFamily: A_FONTS.serif,
                }}>“{b.owner}”</div>
                <div style={{
                  fontFamily: A_FONTS.mono, fontSize: 10.5, color: A_TOKENS.ink3,
                  letterSpacing: "0.04em", marginTop: 8,
                }}>
                  {b.ios.toUpperCase()} · {b.color.toUpperCase()} · {b.lastBackup.toUpperCase()}
                </div>
              </div>

              {/* Contents — compact item bars */}
              <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: A_TOKENS.ink2 }}>
                {[
                  ["Messages", b.messages],
                  ["Photos",   b.photos],
                  ["Contacts", b.contacts],
                  ["Calls",    b.calls],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>{k}</span>
                    <span style={{ fontFamily: A_FONTS.mono, fontSize: 11.5, color: A_TOKENS.ink }}>
                      {v.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>

              {/* Size + encryption */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{
                  fontFamily: A_FONTS.serif, fontSize: 22, fontWeight: 400,
                }}>{b.size}</div>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 11.5, color: b.encrypted ? A_TOKENS.accent : A_TOKENS.ink2,
                  background: b.encrypted ? "rgba(200,90,58,.08)" : "rgba(138,122,90,.10)",
                  padding: "4px 9px", borderRadius: 999, alignSelf: "flex-start",
                  border: `1px solid ${b.encrypted ? "rgba(200,90,58,.28)" : "rgba(138,122,90,.22)"}`,
                }}>
                  <Icons.Lock size={11} strokeWidth={1.7} />
                  {b.encrypted ? "Encrypted · password needed" : "Unencrypted"}
                </div>
                <div style={{
                  fontFamily: A_FONTS.mono, fontSize: 9.5, color: A_TOKENS.ink3,
                  letterSpacing: "0.08em", marginTop: 4,
                }}>
                  UDID {b.id.toUpperCase().replace("-", "·")}
                </div>
              </div>

              {/* Action */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                <button style={{
                  background: featured ? A_TOKENS.ink : "transparent",
                  color: featured ? A_TOKENS.paper : A_TOKENS.ink,
                  border: `1px solid ${featured ? A_TOKENS.ink : A_TOKENS.rule}`,
                  borderRadius: 999, padding: "10px 18px",
                  fontFamily: A_FONTS.sans, fontSize: 12.5, fontWeight: 500,
                  letterSpacing: "-0.005em",
                  display: "inline-flex", alignItems: "center", gap: 8,
                }}>
                  Open
                  <Icons.ArrowRight size={13} strokeWidth={1.7} />
                </button>
              </div>
            </div>
          );
        })}

        {/* Add backup */}
        <div style={{
          marginTop: 18, padding: "20px 22px",
          border: `1px dashed ${A_TOKENS.rule}`, borderRadius: 6,
          display: "flex", alignItems: "center", gap: 14,
          color: A_TOKENS.ink2, fontSize: 13,
        }}>
          <Icons.Plus size={16} strokeWidth={1.6} stroke={A_TOKENS.ink2} />
          Don't see yours? Point OpenExtract at a folder —
          <span style={{ fontFamily: A_FONTS.mono, fontSize: 11.5 }}>File ▸ Open backup folder…</span>
        </div>
      </div>
    </div>
  );
};

// ------ MESSAGES with right-margin annotation rail ------
const Almanac_Messages = () => {
  const { conversations, activeThread, marginalia } = window.OE_DATA;
  const Icons = window.OEIcons;

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, background: A_TOKENS.paper, overflow: "hidden" }}>
      <Almanac_Sidebar active="messages" />

      {/* Conversation list */}
      <aside style={{
        width: 270, flexShrink: 0, borderRight: `1px solid ${A_TOKENS.ruleSoft}`,
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "18px 18px 10px" }}>
          <div style={{ fontFamily: A_FONTS.mono, fontSize: 10, letterSpacing: "0.14em", color: A_TOKENS.ink3, textTransform: "uppercase" }}>
            § Messages
          </div>
          <div style={{ fontFamily: A_FONTS.serif, fontSize: 26, lineHeight: 1.1, marginTop: 4 }}>
            214 threads
          </div>
          <div style={{
            marginTop: 12, display: "flex", alignItems: "center", gap: 8,
            background: A_TOKENS.paperAlt, border: `1px solid ${A_TOKENS.ruleSoft}`,
            borderRadius: 6, padding: "7px 10px",
          }}>
            <Icons.Search size={13} strokeWidth={1.5} stroke={A_TOKENS.ink3} />
            <span style={{ fontSize: 12, color: A_TOKENS.ink3 }}>Search conversations</span>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "0 8px 12px" }}>
          {conversations.map((c) => {
            const on = c.id === activeThread.contactId;
            return (
              <div key={c.id} style={{
                display: "flex", gap: 11, padding: "10px 10px", borderRadius: 6,
                background: on ? A_TOKENS.paperAlt : "transparent",
                borderLeft: on ? `2px solid ${A_TOKENS.accent}` : "2px solid transparent",
                marginLeft: on ? 0 : 2,
                cursor: "pointer",
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                  background: `oklch(78% 0.06 ${c.avatarHue})`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: A_FONTS.serif, fontSize: 15, color: A_TOKENS.ink,
                  border: `1px solid ${A_TOKENS.rule}`,
                }}>
                  {c.name[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13.5, fontWeight: on ? 500 : 400, color: A_TOKENS.ink, letterSpacing: "-0.005em" }}>
                      {c.name}
                    </span>
                    <span style={{ fontFamily: A_FONTS.mono, fontSize: 10, color: A_TOKENS.ink3 }}>
                      {c.time}
                    </span>
                  </div>
                  <div style={{
                    fontSize: 12.5, color: A_TOKENS.ink2, marginTop: 2,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {c.preview}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Conversation body */}
      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: A_TOKENS.paper }}>
        {/* Thread header */}
        <div style={{
          padding: "20px 28px 16px", borderBottom: `1px solid ${A_TOKENS.ruleSoft}`,
          display: "flex", alignItems: "flex-start", gap: 14,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
            background: "oklch(78% 0.06 14)", border: `1px solid ${A_TOKENS.rule}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: A_FONTS.serif, fontSize: 20,
          }}>E</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: A_FONTS.serif, fontSize: 28, lineHeight: 1, fontWeight: 400 }}>
              Emma
            </div>
            <div style={{
              fontFamily: A_FONTS.mono, fontSize: 10.5, letterSpacing: "0.06em",
              color: A_TOKENS.ink3, marginTop: 6, textTransform: "uppercase",
            }}>
              Daughter · 847 messages · 2016–2023
            </div>
          </div>
          <button style={{
            background: "transparent", border: `1px solid ${A_TOKENS.rule}`,
            color: A_TOKENS.ink, padding: "7px 14px", borderRadius: 999,
            fontSize: 12, display: "inline-flex", alignItems: "center", gap: 7,
          }}>
            <Icons.Export size={13} strokeWidth={1.6} />
            Export thread
          </button>
        </div>

        {/* Thread + margin rail */}
        <div style={{ flex: 1, overflow: "auto", display: "grid", gridTemplateColumns: "1fr 220px", gap: 0 }}>
          <div style={{ padding: "22px 28px 18px 28px", position: "relative" }}>
            {/* Date divider */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 18px" }}>
              <div style={{ flex: 1, height: 1, background: A_TOKENS.ruleSoft }}/>
              <div style={{
                fontFamily: A_FONTS.mono, fontSize: 10, letterSpacing: "0.14em",
                color: A_TOKENS.ink3, textTransform: "uppercase",
              }}>Monday · Aug 14, 2023</div>
              <div style={{ flex: 1, height: 1, background: A_TOKENS.ruleSoft }}/>
            </div>

            {activeThread.messages.map((m) => {
              const mine = m.from === "me";
              const anno = marginalia.find(x => x.anchorId === m.id);
              return (
                <div key={m.id} id={`am-msg-${m.id}`}
                     style={{
                       display: "flex", justifyContent: mine ? "flex-end" : "flex-start",
                       marginBottom: 10,
                     }}>
                  <div style={{
                    maxWidth: "68%",
                    background: mine ? A_TOKENS.bubbleMe : A_TOKENS.bubbleThem,
                    color: mine ? A_TOKENS.paper : A_TOKENS.ink,
                    padding: m.kind === "photo" ? 8 : "9px 14px",
                    borderRadius: 14,
                    border: mine ? "none" : `1px solid ${A_TOKENS.rule}`,
                    fontSize: 14, lineHeight: 1.4, letterSpacing: "-0.005em",
                  }}>
                    {m.kind === "photo" ? (
                      <div>
                        <div style={{
                          width: 260, height: 180, borderRadius: 8,
                          background: `repeating-linear-gradient(135deg, #d9c6a8 0 10px, #cdb996 10px 20px)`,
                          position: "relative", overflow: "hidden",
                          border: `1px solid ${A_TOKENS.rule}`,
                        }}>
                          <div style={{
                            position: "absolute", inset: 0,
                            background: "linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,.35))",
                          }}/>
                          <div style={{
                            position: "absolute", left: 10, bottom: 8, right: 10,
                            fontFamily: A_FONTS.mono, fontSize: 10, color: "#fff8ec",
                            letterSpacing: "0.04em",
                          }}>
                            [IMG_{String(m.id).padStart(4, "0")}] · {m.caption}
                          </div>
                        </div>
                        <div style={{
                          marginTop: 6, fontFamily: A_FONTS.mono, fontSize: 10,
                          color: A_TOKENS.ink3, letterSpacing: "0.04em",
                        }}>{m.time}</div>
                      </div>
                    ) : (
                      <>
                        <div>{m.text}</div>
                        <div style={{
                          marginTop: 4, fontFamily: A_FONTS.mono, fontSize: 10,
                          color: mine ? "rgba(246,238,228,.45)" : A_TOKENS.ink3,
                          textAlign: mine ? "right" : "left",
                          letterSpacing: "0.04em",
                        }}>{m.time}</div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Composer-ish read-only row */}
            <div style={{
              marginTop: 18, padding: "10px 14px",
              background: A_TOKENS.paperAlt, border: `1px dashed ${A_TOKENS.rule}`,
              borderRadius: 8, fontSize: 12, color: A_TOKENS.ink3,
              fontStyle: "italic", fontFamily: A_FONTS.serif,
            }}>
              Read-only — OpenExtract never sends messages. This is the record as it was on Aug 14, 2023.
            </div>
          </div>

          {/* Annotation rail — the novel bit */}
          <div style={{
            borderLeft: `1px dashed ${A_TOKENS.rule}`,
            padding: "22px 20px 18px 22px",
            background: "linear-gradient(180deg, transparent, rgba(217,204,183,.10))",
          }}>
            <div style={{
              fontFamily: A_FONTS.mono, fontSize: 9.5, letterSpacing: "0.16em",
              color: A_TOKENS.ink3, textTransform: "uppercase", marginBottom: 12,
            }}>
              Marginalia
            </div>
            {marginalia.map((a) => (
              <div key={a.anchorId} style={{
                marginBottom: 16, paddingLeft: 12,
                borderLeft: `2px solid ${A_TOKENS.accent}`,
              }}>
                <div style={{
                  fontFamily: A_FONTS.serif, fontSize: 15, lineHeight: 1.25,
                  fontStyle: "italic", color: A_TOKENS.ink,
                }}>
                  {a.label}
                </div>
                <div style={{
                  fontSize: 12, color: A_TOKENS.ink2, marginTop: 4, lineHeight: 1.4,
                }}>
                  {a.note}
                </div>
              </div>
            ))}

            <div style={{
              marginTop: 24, paddingTop: 16,
              borderTop: `1px dashed ${A_TOKENS.rule}`,
              fontSize: 11.5, color: A_TOKENS.ink3, lineHeight: 1.5,
            }}>
              <span style={{ fontFamily: A_FONTS.mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                Filters
              </span>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["3mo", "6mo", "This year", "All time", "Photos only"].map((f, i) => (
                  <span key={f} style={{
                    padding: "4px 10px", fontSize: 11, borderRadius: 999,
                    border: `1px solid ${i === 3 ? A_TOKENS.ink : A_TOKENS.rule}`,
                    color: i === 3 ? A_TOKENS.paper : A_TOKENS.ink2,
                    background: i === 3 ? A_TOKENS.ink : "transparent",
                  }}>{f}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

window.AlmanacRoot = ({ screen }) => {
  if (screen === "backup") {
    return (
      <Almanac_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Almanac_Sidebar active="" />
          <Almanac_Backup />
        </div>
      </Almanac_Chrome>
    );
  }
  if (screen === "messages") {
    return (
      <Almanac_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Almanac_Sidebar active="messages" />
          <Almanac_Messages />
        </div>
      </Almanac_Chrome>
    );
  }
  const tokens = {
    bg: A_TOKENS.paper, surface: "#fffaf0", sunk: A_TOKENS.paperAlt,
    ink: A_TOKENS.ink, ink2: A_TOKENS.ink2, ink3: A_TOKENS.ink3,
    rule: A_TOKENS.ruleSoft, ruleStr: A_TOKENS.rule,
    accent: A_TOKENS.accent, accentW: "#f4e0d2",
    sans: A_FONTS.sans, serif: A_FONTS.serif, mono: A_FONTS.mono,
    titleSerif: true, titleWeight: 400, titleLetter: "-0.02em", radius: 6,
    bubbleMe: A_TOKENS.ink, bubbleThem: A_TOKENS.bubbleThem,
    chipActive: A_TOKENS.ink, chipActiveFg: A_TOKENS.paper, chipFg: A_TOKENS.ink2,
  };
  return window.SharedScreens.render({
    screen, tokens,
    Sidebar: (p) => <Almanac_Sidebar active={screen}/>,
    Chrome: Almanac_Chrome,
    backupComponent: Almanac_Backup, messagesComponent: Almanac_Messages,
  });
};
