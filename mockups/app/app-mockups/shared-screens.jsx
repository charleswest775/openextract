// Shared screen primitives — Timeline, Photos, Voicemail, Calls, Contacts, Notes.
// Each variant supplies a `tokens` bundle describing its look, and a Sidebar
// component. Backup + Messages stay variant-specific (that's where the novel
// bits live).
//
// tokens: {
//   bg, surface, sunk, ink, ink2, ink3, rule, ruleStr, accent, accentW,
//   sans, serif, mono,
//   titleSerif (bool), titleWeight (num), titleLetter (e.g. "-0.02em"),
//   radius (num px), density: "compact"|"cozy",
//   bubbleMe, bubbleThem,  // not used here but kept for symmetry
//   chipActive (bg), chipActiveFg, chipFg,
// }

(function () {
  const {
    useState, useMemo, Fragment,
  } = React;

  const fmtNum = (n) => n.toLocaleString();

  // ------- Common primitives -------
  const HeaderBar = ({ tokens: T, title, sub, right }) => (
    <div style={{
      padding: "20px 28px 14px",
      borderBottom: `1px solid ${T.rule}`,
      display: "flex", alignItems: "flex-end", gap: 16,
      background: T.bg, flexShrink: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: T.ink3, letterSpacing: "0.06em",
          textTransform: "uppercase", fontWeight: 500, marginBottom: 6,
        }}>{sub}</div>
        <h1 style={{
          margin: 0,
          fontFamily: T.titleSerif ? T.serif : T.sans,
          fontWeight: T.titleWeight ?? (T.titleSerif ? 400 : 600),
          fontSize: T.titleSerif ? 34 : 22,
          letterSpacing: T.titleLetter ?? "-0.01em",
          lineHeight: 1.05, color: T.ink,
        }}>{title}</h1>
      </div>
      {right && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{right}</div>}
    </div>
  );

  const Chip = ({ tokens: T, active, children }) => (
    <button style={{
      fontSize: 11.5, padding: "5px 10px", borderRadius: 99,
      background: active ? (T.chipActive ?? T.ink) : "transparent",
      color: active ? (T.chipActiveFg ?? T.bg) : (T.chipFg ?? T.ink2),
      border: `1px solid ${active ? (T.chipActive ?? T.ink) : T.rule}`,
      fontFamily: T.sans, fontWeight: active ? 500 : 400,
    }}>{children}</button>
  );

  const GhostBtn = ({ tokens: T, children, icon }) => (
    <button style={{
      background: "transparent", border: `1px solid ${T.rule}`,
      padding: "6px 11px", borderRadius: T.radius ?? 6,
      fontSize: 12, color: T.ink, fontFamily: T.sans,
      display: "inline-flex", gap: 6, alignItems: "center",
    }}>{icon}{children}</button>
  );

  const PrimaryBtn = ({ tokens: T, children, icon }) => (
    <button style={{
      background: T.accent, color: "#fff", border: 0,
      padding: "6px 12px", borderRadius: T.radius ?? 6,
      fontSize: 12, fontWeight: 500, fontFamily: T.sans,
      display: "inline-flex", gap: 6, alignItems: "center",
    }}>{icon}{children}</button>
  );

  // ---------------- TIMELINE ----------------
  const Timeline = ({ tokens: T }) => {
    const Icons = window.OEIcons;
    const events = window.OE_DATA.timeline;

    const iconFor = (type) => ({
      photo: Icons.Image, message: Icons.Message, call: Icons.Phone,
      voicemail: Icons.Voicemail, note: Icons.FileText,
    }[type]);

    // Group by date
    const byDate = [];
    events.forEach(e => {
      const last = byDate[byDate.length - 1];
      if (last && last.date === e.date) last.items.push(e);
      else byDate.push({ date: e.date, items: [e] });
    });

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.bg, minWidth: 0 }}>
        <HeaderBar tokens={T}
          sub="Timeline · 65,396 events"
          title="Everything, in order."
          right={<>
            <GhostBtn tokens={T} icon={<Icons.Filter size={12} strokeWidth={1.6}/>}>All types</GhostBtn>
            <GhostBtn tokens={T} icon={<Icons.Search size={12} strokeWidth={1.6}/>}>Search</GhostBtn>
            <PrimaryBtn tokens={T} icon={<Icons.Export size={12} strokeWidth={1.8}/>}>Export</PrimaryBtn>
          </>}
        />
        <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
          {byDate.map((grp, gi) => (
            <div key={gi} style={{ marginBottom: 22 }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 12, marginBottom: 10,
              }}>
                <div style={{
                  fontSize: 12, color: T.ink2, fontFamily: T.mono, letterSpacing: "0.04em",
                }}>{grp.date}</div>
                <div style={{ flex: 1, height: 1, background: T.rule }}/>
                <div style={{
                  fontSize: 10.5, color: T.ink3, fontFamily: T.mono,
                }}>{grp.items.length} {grp.items.length === 1 ? "event" : "events"}</div>
              </div>
              <div style={{
                background: T.surface, border: `1px solid ${T.rule}`,
                borderRadius: T.radius ?? 8, overflow: "hidden",
              }}>
                {grp.items.map((e, i) => {
                  const I = iconFor(e.type);
                  return (
                    <div key={i} style={{
                      display: "grid", gridTemplateColumns: "44px 60px 1fr auto",
                      alignItems: "center", gap: 14, padding: "12px 16px",
                      borderBottom: i === grp.items.length - 1 ? "none" : `1px solid ${T.rule}`,
                    }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: 8,
                        background: `oklch(94% 0.03 ${e.hue})`,
                        border: `1px solid ${T.rule}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: `oklch(45% 0.12 ${e.hue})`,
                      }}>
                        <I size={14} strokeWidth={1.7}/>
                      </div>
                      <div style={{ fontSize: 11.5, color: T.ink3, fontFamily: T.mono }}>{e.time}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, color: T.ink, fontWeight: 500, letterSpacing: "-0.005em" }}>{e.title}</div>
                        <div style={{ fontSize: 12, color: T.ink2, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.meta}</div>
                      </div>
                      <div style={{
                        fontSize: 10.5, color: T.ink3, fontFamily: T.mono,
                        textTransform: "uppercase", letterSpacing: "0.06em",
                      }}>{e.type}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ---------------- PHOTOS ----------------
  const Photos = ({ tokens: T }) => {
    const Icons = window.OEIcons;
    const photos = window.OE_DATA.photos;

    const Tile = ({ p, big }) => (
      <div style={{
        gridColumn: big ? "span 2" : "span 1",
        gridRow:    big ? "span 2" : "span 1",
        borderRadius: T.radius ?? 8,
        overflow: "hidden",
        border: `1px solid ${T.rule}`,
        background: `
          linear-gradient(135deg, oklch(80% 0.08 ${p.hue}) 0%, oklch(62% 0.14 ${p.hue}) 100%),
          repeating-linear-gradient(45deg, rgba(255,255,255,.08) 0 14px, rgba(0,0,0,.06) 14px 28px)
        `,
        backgroundBlendMode: "overlay",
        position: "relative", minHeight: big ? 280 : 140,
      }}>
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,.55) 100%)",
        }}/>
        <div style={{
          position: "absolute", left: 10, bottom: 8, right: 10,
          color: "#fff", fontFamily: T.sans,
        }}>
          <div style={{ fontSize: big ? 15 : 12.5, fontWeight: 500, letterSpacing: "-0.005em" }}>{p.album}</div>
          <div style={{ fontSize: big ? 11 : 10, opacity: 0.85, marginTop: 2, fontFamily: T.mono, letterSpacing: "0.04em" }}>
            {p.date} · {p.count} photos
          </div>
        </div>
      </div>
    );

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.bg, minWidth: 0 }}>
        <HeaderBar tokens={T}
          sub="Photos · 12,847 recovered"
          title="Albums across seven years."
          right={<>
            <div style={{ display: "flex", gap: 6, marginRight: 8 }}>
              <Chip tokens={T} active>Albums</Chip>
              <Chip tokens={T}>All photos</Chip>
              <Chip tokens={T}>Videos</Chip>
              <Chip tokens={T}>Screenshots</Chip>
            </div>
            <PrimaryBtn tokens={T} icon={<Icons.Export size={12} strokeWidth={1.8}/>}>Export</PrimaryBtn>
          </>}
        />
        <div style={{ flex: 1, overflow: "auto", padding: "22px 28px 32px" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
            gridAutoRows: 140, gap: 12,
          }}>
            {photos.map(p => <Tile key={p.id} p={p} big={p.big}/>)}
          </div>
        </div>
      </div>
    );
  };

  // ---------------- VOICEMAIL ----------------
  const Voicemail = ({ tokens: T, novelRenderer }) => {
    const Icons = window.OEIcons;
    const vms = window.OE_DATA.voicemails;
    const [activeId, setActiveId] = useState(vms[0].id);
    const active = vms.find(v => v.id === activeId) ?? vms[0];

    return (
      <div style={{ flex: 1, display: "flex", background: T.bg, minWidth: 0 }}>
        {/* list */}
        <aside style={{
          width: 340, flexShrink: 0, borderRight: `1px solid ${T.rule}`,
          display: "flex", flexDirection: "column", background: T.bg,
        }}>
          <div style={{ padding: "18px 18px 8px" }}>
            <div style={{
              fontSize: 11, color: T.ink3, letterSpacing: "0.06em",
              textTransform: "uppercase", fontWeight: 500, marginBottom: 6,
            }}>Voicemails · {vms.length}</div>
            <h2 style={{
              margin: 0, fontFamily: T.titleSerif ? T.serif : T.sans,
              fontWeight: T.titleWeight ?? (T.titleSerif ? 400 : 600),
              fontSize: T.titleSerif ? 24 : 18,
              letterSpacing: T.titleLetter ?? "-0.01em",
            }}>Voicemail</h2>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "4px 8px 12px" }}>
            {vms.map(v => {
              const on = v.id === activeId;
              return (
                <div key={v.id} onClick={() => setActiveId(v.id)} style={{
                  padding: "10px 12px", borderRadius: T.radius ?? 6,
                  cursor: "pointer",
                  background: on ? T.accentW : "transparent",
                  borderLeft: on ? `2px solid ${T.accent}` : "2px solid transparent",
                  marginLeft: on ? 0 : 2, marginBottom: 2,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                    <span style={{ fontSize: 13, color: T.ink, fontWeight: on ? 600 : 500, letterSpacing: "-0.005em" }}>{v.from}</span>
                    <span style={{ fontSize: 10.5, color: T.ink3, fontFamily: T.mono }}>{v.duration}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: T.ink3, fontFamily: T.mono, marginBottom: 4 }}>{v.date} · {v.time}</div>
                  <div style={{
                    fontSize: 12, color: T.ink2, lineHeight: 1.4,
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}>{v.transcript}</div>
                </div>
              );
            })}
          </div>
        </aside>
        {/* detail */}
        <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{
            padding: "18px 28px", borderBottom: `1px solid ${T.rule}`,
            display: "flex", alignItems: "center", gap: 14,
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: "50%",
              background: `oklch(88% 0.05 ${200})`, border: `1px solid ${T.rule}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: T.ink, fontWeight: 500,
            }}>{active.from[0]}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.005em" }}>{active.from}</div>
              <div style={{ fontSize: 11.5, color: T.ink3, fontFamily: T.mono, marginTop: 2 }}>
                {active.date} · {active.time} · {active.duration}
              </div>
            </div>
            <GhostBtn tokens={T} icon={<Icons.Download size={12} strokeWidth={1.7}/>}>Export audio</GhostBtn>
          </div>

          {/* novel area — fall back to a waveform + transcript */}
          {novelRenderer ? novelRenderer({ active, tokens: T }) : (
            <div style={{ flex: 1, padding: "28px 28px", overflow: "auto" }}>
              <div style={{
                background: T.surface, border: `1px solid ${T.rule}`,
                borderRadius: T.radius ?? 10, padding: "18px 20px", marginBottom: 18,
              }}>
                <svg viewBox="0 0 600 80" width="100%" height="70" preserveAspectRatio="none">
                  {Array.from({ length: 120 }).map((_, i) => {
                    const h = 6 + Math.abs(Math.sin(i * 0.35 + i * 0.08)) * 40 + (i % 7 === 0 ? 14 : 0);
                    return <rect key={i} x={i * 5} y={40 - h/2} width={2.6} height={h}
                                 fill={i < 36 ? T.accent : T.ink3} rx={1} opacity={i < 36 ? 1 : 0.5}/>;
                  })}
                </svg>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
                  <button style={{
                    width: 34, height: 34, borderRadius: 99, border: 0,
                    background: T.accent, color: "#fff",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>
                  </button>
                  <div style={{ fontFamily: T.mono, fontSize: 11, color: T.ink2 }}>0:14 / {active.duration}</div>
                  <div style={{ flex: 1 }}/>
                  <div style={{ fontFamily: T.mono, fontSize: 11, color: T.ink3 }}>1.0×</div>
                </div>
              </div>
              <div style={{
                fontSize: 11, color: T.ink3, letterSpacing: "0.06em",
                textTransform: "uppercase", fontWeight: 500, marginBottom: 8,
              }}>Transcript · auto-generated</div>
              <div style={{
                fontFamily: T.serif ?? T.sans, fontSize: 16, lineHeight: 1.65, color: T.ink,
                maxWidth: 640,
              }}>
                “{active.transcript}”
              </div>
            </div>
          )}
        </section>
      </div>
    );
  };

  // ---------------- CALLS ----------------
  const Calls = ({ tokens: T }) => {
    const Icons = window.OEIcons;
    const calls = window.OE_DATA.calls;
    const dirIcon = (d) => {
      if (d === "in")     return { char: "↙", color: "oklch(48% 0.14 150)" };
      if (d === "out")    return { char: "↗", color: "oklch(50% 0.14 220)" };
      return                     { char: "×", color: "oklch(55% 0.16 25)" };
    };

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.bg, minWidth: 0 }}>
        <HeaderBar tokens={T}
          sub="Calls · 4,281 records"
          title="Every call, inbound and out."
          right={<>
            <div style={{ display: "flex", gap: 6, marginRight: 8 }}>
              <Chip tokens={T} active>All</Chip>
              <Chip tokens={T}>Missed</Chip>
              <Chip tokens={T}>FaceTime</Chip>
            </div>
            <PrimaryBtn tokens={T} icon={<Icons.Export size={12} strokeWidth={1.8}/>}>Export CSV</PrimaryBtn>
          </>}
        />
        <div style={{ flex: 1, overflow: "auto", padding: "22px 28px 32px" }}>
          <div style={{
            background: T.surface, border: `1px solid ${T.rule}`, borderRadius: T.radius ?? 10,
            overflow: "hidden",
          }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "40px 1.4fr 1.4fr 0.8fr 0.7fr",
              padding: "11px 18px", background: T.sunk,
              borderBottom: `1px solid ${T.rule}`,
              fontSize: 10.5, color: T.ink3, letterSpacing: "0.06em",
              textTransform: "uppercase", fontWeight: 500,
            }}>
              <div></div><div>Contact</div><div>When</div><div>Duration</div><div>Service</div>
            </div>
            {calls.map((c, i) => {
              const d = dirIcon(c.dir);
              return (
                <div key={i} style={{
                  display: "grid",
                  gridTemplateColumns: "40px 1.4fr 1.4fr 0.8fr 0.7fr",
                  padding: "12px 18px", alignItems: "center",
                  borderBottom: i === calls.length - 1 ? "none" : `1px solid ${T.rule}`,
                  fontSize: 13, color: T.ink,
                }}>
                  <div style={{ color: d.color, fontSize: 15, fontWeight: 600 }}>{d.char}</div>
                  <div style={{ fontWeight: 500, letterSpacing: "-0.005em" }}>{c.who}</div>
                  <div style={{ color: T.ink2, fontFamily: T.mono, fontSize: 12 }}>{c.date}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 12 }}>{c.dur}</div>
                  <div style={{ color: T.ink2, fontSize: 12 }}>{c.svc}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ---------------- CONTACTS ----------------
  const Contacts = ({ tokens: T, novelRenderer }) => {
    const Icons = window.OEIcons;
    const contacts = window.OE_DATA.contacts;

    if (novelRenderer) {
      return (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.bg, minWidth: 0 }}>
          <HeaderBar tokens={T}
            sub="Contacts · 612 total"
            title="People, by how often she called."
          />
          {novelRenderer({ contacts, tokens: T })}
        </div>
      );
    }

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.bg, minWidth: 0 }}>
        <HeaderBar tokens={T}
          sub="Contacts · 612 total"
          title="The people who mattered."
          right={<>
            <GhostBtn tokens={T} icon={<Icons.Search size={12} strokeWidth={1.6}/>}>Search</GhostBtn>
            <PrimaryBtn tokens={T} icon={<Icons.Export size={12} strokeWidth={1.8}/>}>Export vCard</PrimaryBtn>
          </>}
        />
        <div style={{ flex: 1, overflow: "auto", padding: "22px 28px 32px" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12,
          }}>
            {contacts.map((c, i) => (
              <div key={i} style={{
                background: T.surface, border: `1px solid ${T.rule}`,
                borderRadius: T.radius ?? 8, padding: "14px 16px",
                display: "flex", gap: 12, alignItems: "center",
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
                  background: `oklch(88% 0.05 ${c.hue})`,
                  border: `1px solid ${T.rule}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 15, color: T.ink, fontWeight: 500, fontFamily: T.sans,
                }}>{c.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.005em",
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: T.ink3 }}>{c.role}</div>
                  <div style={{ fontSize: 11, color: T.ink3, fontFamily: T.mono, marginTop: 3 }}>
                    {c.phone}
                  </div>
                </div>
                <div style={{
                  fontSize: 10.5, color: T.ink3, fontFamily: T.mono,
                  textAlign: "right",
                }}>
                  <div style={{ fontWeight: 500, color: T.accent, fontSize: 12 }}>{c.freq}</div>
                  <div>msgs</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ---------------- NOTES ----------------
  const Notes = ({ tokens: T }) => {
    const Icons = window.OEIcons;
    const notes = window.OE_DATA.notes;
    const [activeId, setActiveId] = useState(notes[0].id);
    const active = notes.find(n => n.id === activeId) ?? notes[0];

    const noteBody = {
      n1: "Emma: medium, navy preferred. Something soft, nothing itchy.\n\nNora: 6X, avoid pink if possible. Loves dinosaurs right now.\n\nEthan: large. Asked for nothing. Get him a sweater anyway.\n\nTeddy (new baby): 3–6m, earth tones. Sarah said no white, no yellow — they stain.",
      n2: "bread\npeaches (2 lb, ripe ones)\nvanilla bean\nolive oil — good kind\nthat cheese Dad likes (tell Noah at counter)\ncoffee filters\nstamps",
      n3: "Mom's peach cobbler\n\n6 peaches, peeled and sliced\n1 cup flour\n1 cup sugar\n1 stick butter, melted in the pan\n1 cup milk\n1 tsp baking powder\npinch salt\ncinnamon + nutmeg\n\n350° for 45 min. Do NOT stir after pouring batter.",
      n4: "Demon Copperhead — Marjorie rec, keeps mentioning it\nTom Lake — finally\nTrust (Hernan Diaz)\nNorth Woods — Dan bought me this, finish it\nBel Canto — reread?",
      n5: "not storing any here anymore — use the little book",
      n6: "23 letters, Dad to Mom, bundled with blue ribbon. Postmarks: Ann Arbor (Oct 1986 – May 1987), Boulder (Jun–Aug 1987), Charleston (Sep 1987 – Feb 1988). All Dad's handwriting. Need to photograph these before they fade any more.",
      n7: "senior food, half scoop breakfast, half scoop dinner\nno table scraps per Dr. Okafor\nglucosamine chew every morning\nvet every 6 months now",
    }[active.id] ?? active.preview;

    return (
      <div style={{ flex: 1, display: "flex", background: T.bg, minWidth: 0 }}>
        <aside style={{
          width: 320, flexShrink: 0, borderRight: `1px solid ${T.rule}`,
          display: "flex", flexDirection: "column", background: T.bg,
        }}>
          <div style={{ padding: "18px 18px 10px" }}>
            <div style={{
              fontSize: 11, color: T.ink3, letterSpacing: "0.06em",
              textTransform: "uppercase", fontWeight: 500, marginBottom: 6,
            }}>Notes · {notes.length} recovered</div>
            <h2 style={{
              margin: 0, fontFamily: T.titleSerif ? T.serif : T.sans,
              fontWeight: T.titleWeight ?? (T.titleSerif ? 400 : 600),
              fontSize: T.titleSerif ? 24 : 18,
              letterSpacing: T.titleLetter ?? "-0.01em",
            }}>Notes</h2>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "4px 8px 12px" }}>
            {notes.map(n => {
              const on = n.id === activeId;
              return (
                <div key={n.id} onClick={() => setActiveId(n.id)} style={{
                  padding: "11px 12px", borderRadius: T.radius ?? 6, cursor: "pointer",
                  background: on ? T.accentW : "transparent",
                  borderLeft: on ? `2px solid ${T.accent}` : "2px solid transparent",
                  marginLeft: on ? 0 : 2, marginBottom: 2,
                }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    {n.pinned && <span style={{ color: T.accent, fontSize: 10 }}>●</span>}
                    <span style={{ fontSize: 13, color: T.ink, fontWeight: on ? 600 : 500, letterSpacing: "-0.005em",
                                   flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.title}</span>
                    <span style={{ fontSize: 10.5, color: T.ink3, fontFamily: T.mono }}>{n.date.split(",")[0]}</span>
                  </div>
                  <div style={{
                    fontSize: 12, color: T.ink2, lineHeight: 1.4, marginTop: 2,
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}>{n.preview}</div>
                </div>
              );
            })}
          </div>
        </aside>
        <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{
            padding: "18px 32px", borderBottom: `1px solid ${T.rule}`,
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10.5, color: T.ink3, fontFamily: T.mono, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                {active.date}{active.pinned ? " · pinned" : ""}
              </div>
              <div style={{
                fontSize: T.titleSerif ? 22 : 18, fontWeight: T.titleSerif ? 500 : 600,
                fontFamily: T.titleSerif ? T.serif : T.sans, marginTop: 3, letterSpacing: "-0.01em",
              }}>{active.title}</div>
            </div>
            <GhostBtn tokens={T} icon={<Icons.Export size={12} strokeWidth={1.7}/>}>Export</GhostBtn>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "26px 38px 40px" }}>
            <pre style={{
              fontFamily: T.serif ?? T.sans, fontSize: 15.5, lineHeight: 1.7, color: T.ink,
              margin: 0, whiteSpace: "pre-wrap", maxWidth: 680,
            }}>{noteBody}</pre>
          </div>
        </section>
      </div>
    );
  };

  // -------------- Renderer --------------
  // variant passes { screen, tokens, Sidebar, Chrome,
  //   backupComponent, messagesComponent,
  //   novelVoicemail?, novelContacts? }
  const render = ({
    screen, tokens, Sidebar, Chrome,
    backupComponent: Backup,
    messagesComponent: Messages,
    novelVoicemail, novelContacts,
  }) => {
    let Body;
    switch (screen) {
      case "backup":    Body = <Backup/>; break;
      case "messages":  Body = <Messages/>; break;
      case "timeline":  Body = <Timeline tokens={tokens}/>; break;
      case "photos":    Body = <Photos tokens={tokens}/>; break;
      case "voicemail": Body = <Voicemail tokens={tokens} novelRenderer={novelVoicemail}/>; break;
      case "calls":     Body = <Calls tokens={tokens}/>; break;
      case "contacts":  Body = <Contacts tokens={tokens} novelRenderer={novelContacts}/>; break;
      case "notes":     Body = <Notes tokens={tokens}/>; break;
      default:          Body = <Backup/>;
    }

    // Chrome wraps everything; inside, sidebar + body sit side-by-side
    // (backup screen is full-width — skip sidebar)
    const showSidebar = screen !== "backup";
    return (
      <Chrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {showSidebar && <Sidebar active={screen}/>}
          {Body}
        </div>
      </Chrome>
    );
  };

  window.SharedScreens = { render, Timeline, Photos, Voicemail, Calls, Contacts, Notes, HeaderBar, Chip, GhostBtn, PrimaryBtn };
})();
