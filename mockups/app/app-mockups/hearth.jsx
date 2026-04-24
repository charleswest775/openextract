// ======================================================================
// HEARTH — Photo album / dusk palette
// Warm off-white #fbf6f1, soft terracotta & sage, organic round cards.
// Fraunces display, Geist body.
// Novel UX: backup picker as STACKED PHOTO CARDS you flip through;
// messages show people as portrait circles with a subtle recent-glow.
// ======================================================================

const H = {
  bg:      "#fbf6f1",
  surface: "#ffffff",
  sand:    "#f2e9dd",
  ink:     "#1e1a16",
  ink2:    "#655a4f",
  ink3:    "#97897a",
  rule:    "#ece1d1",
  accent:  "#d97757",  // terracotta
  sage:    "#7a9a7a",
  cream:   "#f0d894",
  bubbleMe: "#d97757",
  bubbleThem: "#f2e9dd",
};

const HF = {
  serif: "'Fraunces', 'Newsreader', serif",
  sans:  "'Geist', system-ui, sans-serif",
  mono:  "'IBM Plex Mono', monospace",
};

const Hearth_Chrome = ({ children }) => (
  <div style={{
    background: H.bg, color: H.ink, height: "100%",
    fontFamily: HF.sans, display: "flex", flexDirection: "column",
  }}>
    <div style={{
      height: 44, display: "flex", alignItems: "center", padding: "0 16px",
      background: H.bg, borderBottom: `1px solid ${H.rule}`, flexShrink: 0,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{
        marginLeft: 16, display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{
          width: 18, height: 18, borderRadius: "50%",
          background: `radial-gradient(circle at 35% 35%, ${H.cream}, ${H.accent} 80%)`,
        }}/>
        <span style={{ fontFamily: HF.serif, fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}>
          OpenExtract
        </span>
      </div>
      <div style={{ flex: 1 }}/>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        background: H.sand, border: `1px solid ${H.rule}`, borderRadius: 999,
        padding: "4px 11px", fontSize: 11.5, color: H.ink2,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: H.sage }}/>
        iPhone 13 Pro · Mom's phone
      </div>
    </div>
    {children}
  </div>
);

const Hearth_Sidebar = ({ active }) => {
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
      width: 72, flexShrink: 0, padding: "14px 8px",
      background: H.bg, borderRight: `1px solid ${H.rule}`,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    }}>
      {items.map(it => {
        const on = it.id === active;
        const I = it.I;
        return (
          <div key={it.id} title={it.label} style={{
            width: 56, height: 56, borderRadius: 14,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 3, cursor: "pointer",
            background: on ? H.surface : "transparent",
            boxShadow: on ? "0 1px 2px rgba(30,26,22,.06), 0 4px 14px rgba(217,119,87,.10)" : "none",
            border: on ? `1px solid ${H.rule}` : "1px solid transparent",
            color: on ? H.accent : H.ink2,
          }}>
            <I size={18} strokeWidth={1.6} stroke={on ? H.accent : H.ink2}/>
            <span style={{ fontSize: 9.5, fontWeight: on ? 500 : 400 }}>{it.label}</span>
          </div>
        );
      })}
      <div style={{ flex: 1 }}/>
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: `oklch(82% 0.07 14)`, border: `1px solid ${H.rule}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: HF.serif, fontSize: 15,
      }}>M</div>
    </nav>
  );
};

// --- BACKUP: stacked photo cards ---
const Hearth_Backup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;
  const [sel, setSel] = React.useState(0);

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Left: intro copy */}
      <div style={{
        width: 420, padding: "60px 44px 44px",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ fontFamily: HF.mono, fontSize: 10, letterSpacing: "0.16em", color: H.ink3, textTransform: "uppercase" }}>
          Welcome back
        </div>
        <h1 style={{
          fontFamily: HF.serif, fontWeight: 400, fontSize: 54, lineHeight: 1.03,
          letterSpacing: "-0.025em", margin: "12px 0 10px",
        }}>
          Which phone<br/>
          are we <span style={{ fontStyle: "italic", color: H.accent }}>opening</span>?
        </h1>
        <p style={{ fontSize: 14.5, lineHeight: 1.55, color: H.ink2, margin: 0, maxWidth: 340 }}>
          Three backups live on this Mac. Flip through them, pick the one you want, and we'll gently pull out the messages, photos, and voicemails.
        </p>

        <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
          {backups.map((b, i) => {
            const on = i === sel;
            return (
              <button key={b.id} onClick={() => setSel(i)} style={{
                textAlign: "left", background: on ? H.surface : "transparent",
                border: `1px solid ${on ? H.rule : "transparent"}`,
                padding: "10px 14px", borderRadius: 12,
                display: "flex", alignItems: "center", gap: 12,
                boxShadow: on ? "0 1px 2px rgba(30,26,22,.04)" : "none",
              }}>
                <div style={{
                  width: 8, height: 40, borderRadius: 4,
                  background: on ? H.accent : H.rule, flexShrink: 0,
                }}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: H.ink }}>{b.device}</div>
                  <div style={{ fontSize: 12, color: H.ink2, marginTop: 2 }}>
                    {b.owner} · <span style={{ fontFamily: HF.mono }}>{b.lastBackup}</span>
                  </div>
                </div>
                <Icons.Chevron size={13} stroke={on ? H.accent : H.ink3} strokeWidth={1.7}/>
              </button>
            );
          })}
        </div>

        <div style={{
          marginTop: "auto", paddingTop: 24, fontSize: 12, color: H.ink3,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <Icons.Shield size={14} strokeWidth={1.5} stroke={H.sage}/>
          Nothing leaves your computer.
        </div>
      </div>

      {/* Right: photo-card stack */}
      <div style={{
        flex: 1, position: "relative", overflow: "hidden",
        background: `radial-gradient(ellipse at 60% 20%, #faecdc 0%, ${H.bg} 60%)`,
      }}>
        {backups.map((b, i) => {
          const offset = i - sel;
          const active = offset === 0;
          const rotate = offset === 0 ? -2 : offset === 1 ? 4 : offset === 2 ? -6 : 0;
          const translateX = offset * 30;
          const translateY = offset === 0 ? 0 : 20 + Math.abs(offset) * 14;
          const scale = active ? 1 : 0.96 - Math.abs(offset) * 0.02;
          const z = 10 - Math.abs(offset);
          return (
            <div key={b.id} style={{
              position: "absolute",
              top: "50%", left: "50%",
              width: 360, height: 450,
              background: H.surface,
              borderRadius: 14,
              border: `1px solid ${H.rule}`,
              boxShadow: active
                ? "0 24px 60px rgba(30,26,22,.18), 0 2px 6px rgba(30,26,22,.06)"
                : "0 10px 30px rgba(30,26,22,.12)",
              transform: `translate(-50%, -50%) translate(${translateX}px, ${translateY}px) rotate(${rotate}deg) scale(${scale})`,
              zIndex: z,
              padding: 14,
              transition: "transform .4s cubic-bezier(.2,.8,.2,1), box-shadow .4s",
            }}>
              {/* Polaroid image */}
              <div style={{
                width: "100%", height: 300, borderRadius: 8, overflow: "hidden",
                background: `
                  linear-gradient(135deg, rgba(217,119,87,.25), rgba(122,154,122,.25)),
                  repeating-linear-gradient(45deg, #e8d8c0 0 8px, #dec7a8 8px 16px)
                `,
                position: "relative",
              }}>
                {/* phone silhouette */}
                <div style={{
                  position: "absolute", left: "50%", top: "50%",
                  transform: "translate(-50%,-50%)",
                  width: 120, height: 220, borderRadius: 22,
                  background: "rgba(30,26,22,.86)",
                  border: "3px solid rgba(255,255,255,.3)",
                }}>
                  <div style={{
                    margin: "6px auto 0", width: 38, height: 14, borderRadius: 10,
                    background: "rgba(0,0,0,.5)",
                  }}/>
                </div>
                <div style={{
                  position: "absolute", left: 12, top: 12,
                  fontFamily: HF.mono, fontSize: 10, color: "rgba(30,26,22,.55)",
                  letterSpacing: "0.08em",
                }}>{b.lastBackup.toUpperCase()}</div>
                <div style={{
                  position: "absolute", right: 12, bottom: 12,
                  fontFamily: HF.mono, fontSize: 10, color: "rgba(30,26,22,.55)",
                  letterSpacing: "0.08em",
                }}>{b.color.toUpperCase()}</div>
              </div>

              {/* Caption */}
              <div style={{ padding: "14px 4px 4px" }}>
                <div style={{ fontFamily: HF.serif, fontSize: 22, lineHeight: 1.15, fontWeight: 500 }}>
                  {b.device}
                </div>
                <div style={{ fontSize: 12.5, color: H.ink2, marginTop: 3, fontStyle: "italic", fontFamily: HF.serif }}>
                  "{b.owner}"
                </div>

                {active && (
                  <>
                    <div style={{
                      display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8,
                      marginTop: 14,
                    }}>
                      {[
                        ["Photos",   b.photos.toLocaleString()],
                        ["Messages", b.messages.toLocaleString()],
                        ["Voicemail", b.voicemails],
                      ].map(([k, v]) => (
                        <div key={k} style={{
                          background: H.sand, borderRadius: 8, padding: "8px 10px",
                        }}>
                          <div style={{ fontFamily: HF.mono, fontSize: 9.5, letterSpacing: "0.1em", color: H.ink3, textTransform: "uppercase" }}>{k}</div>
                          <div style={{ fontFamily: HF.serif, fontSize: 18, fontWeight: 500, color: H.ink, marginTop: 2 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <button style={{
                      marginTop: 14, width: "100%",
                      background: H.accent, color: "#fff", border: 0,
                      padding: "11px 16px", borderRadius: 10,
                      fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.005em",
                      display: "inline-flex", justifyContent: "center", alignItems: "center", gap: 8,
                      boxShadow: "0 6px 18px rgba(217,119,87,.28)",
                    }}>
                      {b.encrypted && <Icons.Lock size={13} strokeWidth={1.8}/>}
                      Open this backup
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* page dots */}
        <div style={{
          position: "absolute", bottom: 28, left: 0, right: 0,
          display: "flex", justifyContent: "center", gap: 7,
        }}>
          {backups.map((_, i) => (
            <div key={i} onClick={() => setSel(i)} style={{
              width: i === sel ? 22 : 7, height: 7, borderRadius: 999,
              background: i === sel ? H.accent : H.rule,
              transition: "width .3s",
            }}/>
          ))}
        </div>
      </div>
    </div>
  );
};

// --- MESSAGES ---
const Hearth_Messages = () => {
  const { conversations, activeThread } = window.OE_DATA;
  const Icons = window.OEIcons;

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Conversation rail — people as portrait bubbles */}
      <aside style={{
        width: 310, flexShrink: 0, borderRight: `1px solid ${H.rule}`,
        display: "flex", flexDirection: "column", background: H.bg,
      }}>
        <div style={{ padding: "22px 22px 14px" }}>
          <h2 style={{ fontFamily: HF.serif, fontSize: 28, fontWeight: 500, margin: 0, letterSpacing: "-0.02em" }}>
            People
          </h2>
          <div style={{ fontSize: 12.5, color: H.ink2, marginTop: 4 }}>
            214 conversations, sorted by warmth
          </div>
          <div style={{
            marginTop: 14, display: "flex", alignItems: "center", gap: 8,
            background: H.surface, border: `1px solid ${H.rule}`, borderRadius: 999,
            padding: "8px 14px",
          }}>
            <Icons.Search size={13} strokeWidth={1.6} stroke={H.ink3}/>
            <span style={{ fontSize: 12.5, color: H.ink3 }}>Search people & messages</span>
          </div>
        </div>
        <div style={{ overflow: "auto", padding: "4px 12px 14px", flex: 1 }}>
          {conversations.map((c, i) => {
            const on = c.id === activeThread.contactId;
            const recent = i < 3;
            return (
              <div key={c.id} style={{
                display: "flex", gap: 12, padding: "10px 10px",
                borderRadius: 12,
                background: on ? H.surface : "transparent",
                border: `1px solid ${on ? H.rule : "transparent"}`,
                marginBottom: 2, cursor: "pointer",
                boxShadow: on ? "0 2px 10px rgba(30,26,22,.04)" : "none",
              }}>
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: "50%",
                    background: `radial-gradient(circle at 35% 30%,
                      oklch(85% 0.09 ${c.avatarHue}),
                      oklch(70% 0.10 ${c.avatarHue}))`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: HF.serif, fontSize: 18, color: "#fff",
                    boxShadow: recent ? `0 0 0 3px ${H.bg}, 0 0 0 4px rgba(217,119,87,.35)` : "none",
                  }}>
                    {c.name[0]}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 500, color: H.ink }}>{c.name}</span>
                    <span style={{ fontSize: 10.5, color: H.ink3, fontFamily: HF.mono }}>{c.time}</span>
                  </div>
                  <div style={{
                    fontSize: 12.5, color: H.ink2, marginTop: 2,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>{c.preview}</div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Body */}
      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0,
                        background: `linear-gradient(180deg, ${H.bg}, #f8eee1)` }}>
        <div style={{
          padding: "18px 28px", borderBottom: `1px solid ${H.rule}`,
          display: "flex", alignItems: "center", gap: 14,
          background: H.bg,
        }}>
          <div style={{
            width: 42, height: 42, borderRadius: "50%",
            background: `radial-gradient(circle at 35% 30%, oklch(85% 0.09 14), oklch(70% 0.10 14))`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: HF.serif, fontSize: 18, color: "#fff",
          }}>E</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: HF.serif, fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}>Emma</div>
            <div style={{ fontSize: 12, color: H.ink2, marginTop: 2 }}>
              Daughter · 847 messages · first hello in 2016
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{
              background: "transparent", border: `1px solid ${H.rule}`, color: H.ink,
              padding: "7px 12px", borderRadius: 999, fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center",
            }}>
              <Icons.Image size={13} strokeWidth={1.6}/> Photos only
            </button>
            <button style={{
              background: H.ink, color: H.bg, border: 0,
              padding: "7px 14px", borderRadius: 999, fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center",
            }}>
              <Icons.Export size={13} strokeWidth={1.7}/> Save thread
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "22px 40px 18px" }}>
          <div style={{ textAlign: "center", margin: "0 0 18px", fontSize: 11.5, color: H.ink3, fontFamily: HF.mono, letterSpacing: "0.1em" }}>
            MONDAY · AUG 14, 2023
          </div>

          {activeThread.messages.map(m => {
            const mine = m.from === "me";
            return (
              <div key={m.id} style={{
                display: "flex", justifyContent: mine ? "flex-end" : "flex-start",
                marginBottom: 8, gap: 10,
              }}>
                {!mine && (
                  <div style={{
                    width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                    background: `radial-gradient(circle at 35% 30%, oklch(85% 0.09 14), oklch(70% 0.10 14))`,
                    alignSelf: "flex-end",
                  }}/>
                )}
                <div style={{
                  maxWidth: "62%",
                  background: mine ? H.bubbleMe : H.bubbleThem,
                  color: mine ? "#fff" : H.ink,
                  padding: m.kind === "photo" ? 6 : "10px 15px",
                  borderRadius: 20,
                  borderBottomRightRadius: mine ? 6 : 20,
                  borderBottomLeftRadius: mine ? 20 : 6,
                  fontSize: 14.5, lineHeight: 1.42,
                  boxShadow: mine ? "0 6px 18px rgba(217,119,87,.22)" : "0 1px 0 rgba(30,26,22,.04)",
                }}>
                  {m.kind === "photo" ? (
                    <div>
                      <div style={{
                        width: 280, height: 200, borderRadius: 14, overflow: "hidden",
                        background: `
                          linear-gradient(135deg, rgba(217,119,87,.35), rgba(122,154,122,.25)),
                          repeating-linear-gradient(45deg, #e3cfa8 0 10px, #d5bc8c 10px 20px)
                        `,
                        position: "relative",
                      }}>
                        <div style={{
                          position: "absolute", inset: 0,
                          background: "linear-gradient(180deg, rgba(0,0,0,0) 50%, rgba(0,0,0,.4))",
                        }}/>
                        <div style={{
                          position: "absolute", left: 12, bottom: 10, right: 12,
                          fontFamily: HF.mono, fontSize: 10.5, color: "#fff6e9",
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

        {/* Time-slider ribbon along bottom */}
        <div style={{
          padding: "10px 28px 16px", borderTop: `1px solid ${H.rule}`,
          display: "flex", alignItems: "center", gap: 14, background: H.bg,
        }}>
          <span style={{ fontFamily: HF.mono, fontSize: 10, color: H.ink3, letterSpacing: "0.1em" }}>2016</span>
          <div style={{ flex: 1, position: "relative", height: 24 }}>
            <div style={{ position: "absolute", inset: "10px 0", background: H.sand, borderRadius: 999 }}/>
            {/* activity bars */}
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "end", gap: 2 }}>
              {Array.from({ length: 84 }).map((_, i) => {
                const h = 6 + Math.abs(Math.sin(i * 0.42)) * 16 + (i > 70 ? 4 : 0);
                return <div key={i} style={{
                  flex: 1, height: h, background: i > 78 ? H.accent : "rgba(217,119,87,.45)",
                  borderRadius: 2,
                }}/>;
              })}
            </div>
            <div style={{
              position: "absolute", left: "92%", top: -4, width: 3, height: 32,
              background: H.ink, borderRadius: 2,
            }}/>
          </div>
          <span style={{ fontFamily: HF.mono, fontSize: 10, color: H.accent, letterSpacing: "0.1em" }}>AUG '23</span>
        </div>
      </section>
    </div>
  );
};

window.HearthRoot = ({ screen }) => {
  if (screen === "backup") {
    return (
      <Hearth_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Hearth_Sidebar active="" />
          <Hearth_Backup />
        </div>
      </Hearth_Chrome>
    );
  }
  if (screen === "messages") {
    return (
      <Hearth_Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Hearth_Sidebar active="messages" />
          <Hearth_Messages />
        </div>
      </Hearth_Chrome>
    );
  }
  const tokens = {
    bg: H.bg, surface: H.surface, sunk: H.sand,
    ink: H.ink, ink2: H.ink2, ink3: H.ink3,
    rule: H.rule, ruleStr: H.rule,
    accent: H.accent, accentW: "#f7e6d8",
    sans: HF.sans, serif: HF.serif, mono: HF.mono,
    titleSerif: true, titleWeight: 500, titleLetter: "-0.02em", radius: 10,
    bubbleMe: H.bubbleMe, bubbleThem: H.bubbleThem,
    chipActive: H.ink, chipActiveFg: H.bg, chipFg: H.ink2,
  };
  return window.SharedScreens.render({
    screen, tokens,
    Sidebar: () => <Hearth_Sidebar active={screen}/>,
    Chrome: Hearth_Chrome,
    backupComponent: Hearth_Backup, messagesComponent: Hearth_Messages,
  });
};
