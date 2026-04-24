// ======================================================================
// GARDEN — Soft pastels, organic. Cream background, sage primary.
// Novel UX: Photos as a "year-radius bloom" — concentric year rings with
// photo clusters blooming outward.
// ======================================================================

const GD = {
  bg:       "#faf6ee",
  surface:  "#fffcf5",
  sunk:     "#f2ecdf",
  ink:      "#1f241a",
  ink2:     "#5a5f50",
  ink3:     "#8f9284",
  rule:     "#e7dfce",
  ruleStr:  "#d3c9b2",
  accent:   "#6b8c5a",   // sage
  accentW:  "#e5ead9",
  sans:     "'Inter', system-ui, sans-serif",
  serif:    "'Fraunces', 'Newsreader', serif",
  mono:     "'JetBrains Mono', monospace",
  titleSerif: true,
  titleWeight: 400,
  titleLetter: "-0.02em",
  radius:   14,
  bubbleMe:  "#6b8c5a",
  bubbleThem:"#fffcf5",
  chipActive: "#6b8c5a",
  chipActiveFg: "#fffcf5",
  chipFg: "#5a5f50",
};

const GardenChrome = ({ children }) => (
  <div style={{
    background: GD.bg, color: GD.ink, height: "100%",
    fontFamily: GD.sans, display: "flex", flexDirection: "column",
  }}>
    <div style={{
      height: 46, display: "flex", alignItems: "center", padding: "0 18px",
      background: GD.bg, borderBottom: `1px solid ${GD.rule}`, flexShrink: 0,
    }}>
      <div className="tl"><span className="r"/><span className="y"/><span className="g"/></div>
      <div style={{ marginLeft: 18, fontSize: 14, fontFamily: GD.serif, fontWeight: 500, letterSpacing: "-0.01em" }}>
        OpenExtract
      </div>
      <span style={{ width: 4, height: 4, borderRadius: 99, background: GD.accent, margin: "0 12px" }}/>
      <span style={{ fontSize: 12, color: GD.ink2, fontFamily: GD.serif, fontStyle: "italic" }}>
        Mom's iPhone, summer of '23
      </span>
      <div style={{ flex: 1 }}/>
      <span style={{ fontSize: 11, color: GD.ink3, fontFamily: GD.mono, letterSpacing: "0.06em" }}>LOCAL</span>
    </div>
    {children}
  </div>
);

const GardenSidebar = ({ active }) => {
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
      width: 216, flexShrink: 0, padding: "18px 12px",
      borderRight: `1px solid ${GD.rule}`, background: GD.bg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ fontSize: 10.5, color: GD.ink3, letterSpacing: "0.12em",
                    textTransform: "uppercase", padding: "4px 10px 10px", fontWeight: 600 }}>The garden</div>
      {items.map(it => {
        const on = it.id === active;
        const I = it.I;
        return (
          <div key={it.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 12px", borderRadius: 99, cursor: "pointer",
            color: on ? GD.ink : GD.ink2,
            background: on ? GD.accentW : "transparent",
            marginBottom: 2,
          }}>
            <I size={15} strokeWidth={1.5} stroke={on ? GD.accent : GD.ink2}/>
            <span style={{ fontSize: 13, fontWeight: on ? 500 : 400, letterSpacing: "-0.005em" }}>{it.label}</span>
          </div>
        );
      })}
      <div style={{ flex: 1 }}/>
      <div style={{
        padding: "14px 12px 6px", fontSize: 11.5, color: GD.ink2,
        borderTop: `1px solid ${GD.rule}`, marginTop: 14, fontFamily: GD.serif, fontStyle: "italic",
        lineHeight: 1.5,
      }}>
        "Like pressing flowers — but for a whole life."
      </div>
    </nav>
  );
};

// --- Backup: pastel "seed packet" cards ---
const GardenBackup = () => {
  const backups = window.OE_DATA.backups;
  const Icons = window.OEIcons;
  const hues = [110, 40, 340];

  return (
    <div style={{ flex: 1, overflow: "auto", background: GD.bg }}>
      <div style={{ padding: "54px 56px 20px" }}>
        <div style={{
          fontSize: 10.5, color: GD.ink3, letterSpacing: "0.14em",
          textTransform: "uppercase", fontWeight: 600,
        }}>Choose a backup to begin</div>
        <h1 style={{
          margin: "12px 0 8px", fontFamily: GD.serif, fontWeight: 400,
          fontSize: 52, letterSpacing: "-0.025em", lineHeight: 1.02,
        }}>
          <span style={{ fontStyle: "italic" }}>Three</span> gardens, grown on three phones.
        </h1>
        <p style={{ maxWidth: 580, fontSize: 14.5, lineHeight: 1.65, color: GD.ink2, margin: "8px 0 0" }}>
          Each backup is a season of life — pick one to wander through. No uploads, no accounts, no hurry.
        </p>
      </div>

      <div style={{ padding: "28px 56px 56px", display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)", gap: 22 }}>
        {backups.map((b, i) => (
          <div key={b.id} style={{
            background: GD.surface, border: `1px solid ${GD.rule}`, borderRadius: 22,
            padding: "26px 24px 22px", position: "relative", overflow: "hidden",
          }}>
            {/* decorative "seed" badge */}
            <div style={{
              position: "absolute", top: -40, right: -40, width: 160, height: 160,
              borderRadius: "50%",
              background: `radial-gradient(circle, oklch(88% 0.08 ${hues[i]}) 0%, transparent 70%)`,
              opacity: 0.85,
            }}/>
            <div style={{
              fontFamily: GD.serif, fontStyle: "italic", fontSize: 12.5, color: GD.ink3,
            }}>№ {i + 1} — {b.relative}</div>
            <h3 style={{
              margin: "8px 0 2px", fontFamily: GD.serif, fontWeight: 500,
              fontSize: 28, letterSpacing: "-0.02em",
            }}>{b.device}</h3>
            <div style={{ fontSize: 13, color: GD.ink2, marginBottom: 18 }}>{b.owner}</div>

            {/* stats in a soft grid */}
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px",
              padding: "14px 0", borderTop: `1px solid ${GD.rule}`, borderBottom: `1px solid ${GD.rule}`,
              marginBottom: 16,
            }}>
              {[
                ["Photos",     b.photos.toLocaleString()],
                ["Messages",   b.messages.toLocaleString()],
                ["Calls",      b.calls.toLocaleString()],
                ["Voicemails", b.voicemails],
                ["Period",     `${b.years[0]}–${b.years[b.years.length-1]}`],
                ["Size",       b.size],
              ].map(([k, v]) => (
                <div key={k}>
                  <div style={{ fontSize: 10, color: GD.ink3, letterSpacing: "0.08em",
                                textTransform: "uppercase", fontWeight: 600 }}>{k}</div>
                  <div style={{ fontSize: 13.5, color: GD.ink, fontFamily: GD.mono, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>

            <button style={{
              width: "100%", padding: "10px 14px",
              background: i === 0 ? GD.accent : "transparent",
              color: i === 0 ? "#fff" : GD.ink,
              border: `1px solid ${i === 0 ? GD.accent : GD.ruleStr}`,
              borderRadius: 99, fontSize: 13, fontWeight: 500,
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
              fontFamily: GD.sans,
            }}>
              {i === 0 ? "Open this backup" : "Open"} <Icons.ArrowRight size={12} strokeWidth={2}/>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- Messages with pastel wave scrubber ---
const GardenMessages = () => {
  const { conversations, activeThread } = window.OE_DATA;
  const Icons = window.OEIcons;

  return (
    <div style={{ flex: 1, display: "flex", background: GD.bg, minWidth: 0 }}>
      <aside style={{
        width: 288, flexShrink: 0, borderRight: `1px solid ${GD.rule}`,
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "18px 18px 10px" }}>
          <h2 style={{ margin: 0, fontFamily: GD.serif, fontWeight: 500,
                       fontSize: 22, letterSpacing: "-0.01em" }}>Messages</h2>
          <div style={{ fontSize: 11.5, color: GD.ink3, marginTop: 2, fontFamily: GD.serif, fontStyle: "italic" }}>
            214 threads, pressed between pages
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginTop: 10,
            background: GD.surface, border: `1px solid ${GD.rule}`, borderRadius: 99,
            padding: "7px 12px",
          }}>
            <Icons.Search size={12} strokeWidth={1.5} stroke={GD.ink3}/>
            <span style={{ fontSize: 12, color: GD.ink3 }}>Search threads</span>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "6px 8px 16px" }}>
          {conversations.map(c => {
            const on = c.id === activeThread.contactId;
            return (
              <div key={c.id} style={{
                display: "flex", gap: 10, padding: "9px 10px",
                borderRadius: 14, cursor: "pointer",
                background: on ? GD.accentW : "transparent",
                marginBottom: 2,
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                  background: `oklch(86% 0.06 ${c.avatarHue})`,
                  border: `1px solid ${GD.rule}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, color: GD.ink, fontWeight: 500, fontFamily: GD.serif,
                }}>{c.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, color: GD.ink, fontWeight: on ? 600 : 500 }}>{c.name}</span>
                    <span style={{ fontSize: 10, color: GD.ink3, fontFamily: GD.mono }}>{c.time}</span>
                  </div>
                  <div style={{
                    fontSize: 12, color: GD.ink2, marginTop: 2,
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
          padding: "14px 26px", borderBottom: `1px solid ${GD.rule}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: "50%",
            background: "oklch(86% 0.06 14)", border: `1px solid ${GD.rule}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: GD.serif, fontSize: 15, fontWeight: 500,
          }}>E</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: GD.serif, fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}>Emma</div>
            <div style={{ fontSize: 11.5, color: GD.ink3, fontStyle: "italic", fontFamily: GD.serif }}>
              daughter · 847 messages over seven years
            </div>
          </div>
          <button style={{
            background: GD.accent, color: "#fff", border: 0,
            padding: "7px 14px", borderRadius: 99, fontSize: 12, fontWeight: 500,
            display: "inline-flex", gap: 5, alignItems: "center",
          }}>
            <Icons.Export size={12} strokeWidth={1.8}/> Export thread
          </button>
        </div>

        {/* scrubber: pastel wave */}
        <div style={{ padding: "12px 28px 10px", borderBottom: `1px solid ${GD.rule}`, background: GD.bg }}>
          <svg viewBox="0 0 600 42" width="100%" height={42} style={{ display: "block", overflow: "visible" }}>
            <defs>
              <linearGradient id="gd-wave" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0"   stopColor="oklch(82% 0.07 340)"/>
                <stop offset=".33" stopColor="oklch(82% 0.07 60)"/>
                <stop offset=".66" stopColor="oklch(82% 0.07 180)"/>
                <stop offset="1"   stopColor="oklch(60% 0.11 140)"/>
              </linearGradient>
            </defs>
            {/* wave shape for each year */}
            {[2016,2017,2018,2019,2020,2021,2022,2023].map((y, i, arr) => {
              const x = (i / (arr.length - 1)) * 560 + 20;
              const amp = 8 + Math.abs(Math.sin(i * 0.8)) * 10 + (y === 2023 ? 8 : 0);
              return (
                <g key={y}>
                  <ellipse cx={x} cy={26} rx={26} ry={amp}
                           fill="url(#gd-wave)" opacity={y === 2023 ? 0.95 : 0.6}/>
                  <text x={x} y={8} fontSize="9.5" fontFamily={GD.mono}
                        fill={y === 2023 ? GD.accent : GD.ink3} textAnchor="middle"
                        fontWeight={y === 2023 ? 600 : 400}>{y}</text>
                </g>
              );
            })}
            <circle cx={580} cy={26} r={5} fill={GD.accent} stroke="#fff" strokeWidth={2}/>
          </svg>
          <div style={{ display: "flex", justifyContent: "space-between",
                         fontSize: 11, color: GD.ink3, marginTop: 2, fontFamily: GD.serif, fontStyle: "italic" }}>
            <span>beginning</span><span>Aug 2023 · now</span>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "24px 36px" }}>
          <div style={{
            textAlign: "center", fontSize: 11.5, color: GD.ink3, fontFamily: GD.serif,
            fontStyle: "italic", marginBottom: 14,
          }}>Monday · August 14, 2023</div>
          {activeThread.messages.map(m => {
            const mine = m.from === "me";
            return (
              <div key={m.id} style={{
                display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 7,
              }}>
                <div style={{
                  maxWidth: "62%",
                  background: mine ? GD.bubbleMe : GD.bubbleThem,
                  color: mine ? "#fff" : GD.ink,
                  padding: m.kind === "photo" ? 4 : "10px 15px",
                  borderRadius: 18,
                  border: mine ? "none" : `1px solid ${GD.rule}`,
                  fontSize: 14, lineHeight: 1.45,
                }}>
                  {m.kind === "photo" ? (
                    <div style={{
                      width: 230, height: 170, borderRadius: 14, overflow: "hidden",
                      background: `
                        linear-gradient(135deg, oklch(80% 0.08 80) 0%, oklch(65% 0.12 45) 100%)
                      `, position: "relative",
                    }}>
                      <div style={{
                        position: "absolute", left: 10, bottom: 8, right: 10,
                        fontSize: 10.5, color: "#fff", fontFamily: GD.serif, fontStyle: "italic",
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

// --- Novel PHOTOS view: concentric year rings, photos bloom outward ---
const GardenPhotosBloom = () => {
  const Icons = window.OEIcons;
  const photos = window.OE_DATA.photos;
  const years = [2017, 2018, 2019, 2020, 2021, 2022, 2023];

  // Assign each photo to a year ring (by date approx) and a radial angle
  const byYear = {
    2023: photos.slice(0, 3),
    2022: photos.slice(3, 5),
    2021: photos.slice(5, 7),
    2020: photos.slice(7, 9),
    2019: photos.slice(9, 11),
    2018: [photos[11]],
    2017: [photos[0]], // just for visual bloom
  };

  const cx = 480, cy = 360;
  const ringRadii = { 2023: 70, 2022: 130, 2021: 190, 2020: 250, 2019: 310, 2018: 360, 2017: 400 };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: GD.bg, minWidth: 0 }}>
      <div style={{
        padding: "20px 28px 14px", borderBottom: `1px solid ${GD.rule}`,
        display: "flex", alignItems: "flex-end", gap: 16, flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10.5, color: GD.ink3, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>
            Photos · 12,847 · bloom view
          </div>
          <h1 style={{ margin: "6px 0 0", fontFamily: GD.serif, fontWeight: 400, fontSize: 32, letterSpacing: "-0.02em" }}>
            Seven years, in rings.
          </h1>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={{ fontSize: 12, padding: "6px 12px", borderRadius: 99,
                           background: GD.accent, color: "#fff", border: 0 }}>Bloom</button>
          <button style={{ fontSize: 12, padding: "6px 12px", borderRadius: 99,
                           background: "transparent", color: GD.ink2, border: `1px solid ${GD.ruleStr}` }}>Grid</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "10px 28px 28px",
                     display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
        <svg viewBox="0 0 960 720" width="100%" height="640" style={{ maxWidth: 960 }}>
          {/* rings */}
          {years.map(y => (
            <circle key={y} cx={cx} cy={cy} r={ringRadii[y]}
                    fill="none" stroke={GD.ruleStr} strokeDasharray="1 5" strokeWidth={1}/>
          ))}
          {/* year labels on rings */}
          {years.map(y => (
            <text key={y} x={cx} y={cy - ringRadii[y] - 6} fontSize="11"
                  fontFamily={GD.mono} fill={y === 2023 ? GD.accent : GD.ink3}
                  textAnchor="middle" fontWeight={y === 2023 ? 600 : 400}>{y}</text>
          ))}
          {/* center bud */}
          <circle cx={cx} cy={cy} r={22} fill={GD.accent}/>
          <text x={cx} y={cy + 4} fontSize="10" fontFamily={GD.sans} fill="#fff"
                textAnchor="middle" fontWeight={600}>NOW</text>

          {/* photo blooms */}
          {years.map((y) => {
            const ring = byYear[y] ?? [];
            const r = ringRadii[y];
            return ring.map((p, i) => {
              const angle = (i / Math.max(ring.length, 1)) * Math.PI * 1.6 - Math.PI * 0.3 + (y * 0.3);
              const x = cx + Math.cos(angle) * r;
              const py = cy + Math.sin(angle) * r;
              const size = 28 + Math.min(p.count / 3, 28);
              return (
                <g key={`${y}-${i}`}>
                  <circle cx={x} cy={py} r={size} fill={`oklch(78% 0.09 ${p.hue})`} opacity={0.95}/>
                  <circle cx={x} cy={py} r={size - 2} fill={`oklch(78% 0.09 ${p.hue})`}
                          stroke="#fff" strokeWidth={2}/>
                  <text x={x} y={py + 3} fontSize="10" fontFamily={GD.sans} fill={GD.ink}
                        textAnchor="middle" fontWeight={500}>{p.count}</text>
                  <text x={x} y={py + size + 14} fontSize="10" fontFamily={GD.serif}
                        fontStyle="italic" fill={GD.ink2} textAnchor="middle">
                    {p.album.length > 16 ? p.album.slice(0, 16) + "…" : p.album}
                  </text>
                </g>
              );
            });
          })}
        </svg>
      </div>
    </div>
  );
};

window.GardenRoot = ({ screen }) => {
  const overrides = {
    backup:   <GardenBackup/>,
    messages: <GardenMessages/>,
    photos:   <GardenPhotosBloom/>,
  };
  const custom = overrides[screen];
  if (custom) {
    return (
      <GardenChrome>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {screen !== "backup" && <GardenSidebar active={screen}/>}
          {custom}
        </div>
      </GardenChrome>
    );
  }
  return window.SharedScreens.render({
    screen, tokens: GD, Sidebar: GardenSidebar, Chrome: GardenChrome,
    backupComponent: GardenBackup, messagesComponent: GardenMessages,
  });
};
