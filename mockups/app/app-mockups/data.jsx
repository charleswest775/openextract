// Shared sample data for all four variants.
// Warm/personal memory-recovery tone.

window.OE_DATA = {
  backups: [
    {
      id: "iphone-13-pro",
      device: "iPhone 13 Pro",
      owner: "Mom's phone",
      ios: "iOS 17.6.1",
      color: "Sierra Blue",
      lastBackup: "Aug 14, 2023",
      relative: "2 years ago",
      size: "84.2 GB",
      encrypted: true,
      photos: 12847,
      messages: 48213,
      contacts: 612,
      voicemails: 24,
      calls: 4281,
      notes: 189,
      years: [2019, 2020, 2021, 2022, 2023],
      activity: [3,5,6,8,10,14,18,22,19,16,12,8, 6,7,9,11,14,18,24,26,23,19,14,10, 8,9,11,14,17,22,28,30,27,22,16,11],
    },
    {
      id: "iphone-xs",
      device: "iPhone XS",
      owner: "Dad — old phone",
      ios: "iOS 15.7",
      color: "Space Gray",
      lastBackup: "Mar 02, 2021",
      relative: "4 years ago",
      size: "52.1 GB",
      encrypted: false,
      photos: 6012,
      messages: 22104,
      contacts: 438,
      voicemails: 9,
      calls: 2140,
      notes: 67,
      years: [2017, 2018, 2019, 2020, 2021],
      activity: [2,3,4,5,7,9,12,14,12,10,8,6, 5,6,8,10,13,16,19,20,17,13,9,6, 4,5,7,9,11,13,15,16,13,10,7,5],
    },
    {
      id: "iphone-7",
      device: "iPhone 7",
      owner: "My old phone",
      ios: "iOS 14.8",
      color: "Rose Gold",
      lastBackup: "Dec 22, 2019",
      relative: "6 years ago",
      size: "28.7 GB",
      encrypted: true,
      photos: 3298,
      messages: 9847,
      contacts: 221,
      voicemails: 3,
      calls: 812,
      notes: 42,
      years: [2016, 2017, 2018, 2019],
      activity: [1,2,3,4,6,8,10,11,9,7,5,3, 3,4,5,7,9,11,13,14,11,8,6,4, 2,3,4,5,7,9,11,12,10,7,5,3],
    },
  ],

  // Messages — mom's phone conversation list
  conversations: [
    { id: "emma",   name: "Emma",           preview: "sent a photo",                     time: "2:14 PM", unread: false, avatarHue: 14,  role: "daughter" },
    { id: "sarah",  name: "Sarah Whitfield", preview: "ok love you — see you Sunday 💐", time: "11:42 AM", unread: false, avatarHue: 340, role: "sister" },
    { id: "dad",    name: "Dad ❤",           preview: "the dock is finally finished",    time: "Mon",      unread: false, avatarHue: 200, role: "husband" },
    { id: "book",   name: "Book Club",       preview: "Marjorie: chapter 12 kills me",   time: "Sun",      unread: false, avatarHue: 120, role: "group" },
    { id: "linda",  name: "Linda Park",      preview: "happy birthday!!",                 time: "Aug 4",    unread: false, avatarHue: 45, role: "friend" },
    { id: "ethan",  name: "Ethan",           preview: "landed. calling now",              time: "Jul 28",   unread: false, avatarHue: 260, role: "son" },
    { id: "carol",  name: "Carol Whitfield", preview: "the tomatoes came in",             time: "Jul 15",   unread: false, avatarHue: 80,  role: "mother" },
    { id: "vet",    name: "Elmwood Vet",     preview: "Biscuit is ready for pickup",      time: "Jun 30",   unread: false, avatarHue: 180, role: "service" },
  ],

  // Active conversation (Emma) — a warm exchange from a summer afternoon
  activeThread: {
    contactId: "emma",
    name: "Emma",
    subtitle: "Daughter · 847 messages · 2016–2023",
    messages: [
      { id: 1, from: "them", text: "look what I found in the attic!!", time: "2:02 PM", date: "Aug 14, 2023" },
      { id: 2, from: "them", kind: "photo", caption: "attic find — old polaroids", time: "2:02 PM" },
      { id: 3, from: "me",   text: "oh my god. is that grandma's sewing box??", time: "2:06 PM" },
      { id: 4, from: "them", text: "yep. full of buttons, threads, everything", time: "2:08 PM" },
      { id: 5, from: "them", text: "I want to keep it", time: "2:08 PM" },
      { id: 6, from: "me",   text: "of course. she would love that ❤", time: "2:10 PM" },
      { id: 7, from: "them", text: "also found a stack of letters. dad 1987 — so young", time: "2:12 PM" },
      { id: 8, from: "them", kind: "photo", caption: "letters — 1987", time: "2:13 PM" },
      { id: 9, from: "me",   text: "bring them to sunday dinner, we'll read together", time: "2:14 PM" },
    ]
  },

  // Helpful context snippets (used in margin rails for Almanac, etc.)
  marginalia: [
    { anchorId: 2, label: "Aug 2023", note: "12,847 photos recovered from this backup" },
    { anchorId: 5, label: "Emma, 17", note: "attic cleanout, Whitfield house" },
    { anchorId: 8, label: "1987",     note: "23 letters attached — could export as PDF" },
  ],

  // --- Timeline events (newest first) ---
  timeline: [
    { type: "photo",    date: "Aug 14, 2023", time: "2:13 PM", title: "12 photos from the attic", meta: "Emma · iCloud Photo Library", hue: 14 },
    { type: "message",  date: "Aug 14, 2023", time: "2:14 PM", title: "Emma", meta: "“bring them to sunday dinner”", hue: 14 },
    { type: "call",     date: "Aug 13, 2023", time: "6:42 PM", title: "Dad ❤", meta: "Outgoing · 14m 22s", hue: 200 },
    { type: "voicemail",date: "Aug 11, 2023", time: "9:18 AM", title: "Dr. Okafor — Elmwood Vet", meta: "0:48 · Biscuit is ready", hue: 180 },
    { type: "note",     date: "Aug 09, 2023", time: "7:02 AM", title: "Grocery list", meta: "bread, peaches, vanilla…", hue: 80 },
    { type: "photo",    date: "Aug 04, 2023", time: "5:30 PM", title: "Linda's birthday dinner — 38 photos", meta: "Garden, Whitfield house", hue: 45 },
    { type: "message",  date: "Jul 28, 2023", time: "11:02 PM", title: "Ethan", meta: "“landed. calling now”", hue: 260 },
    { type: "call",     date: "Jul 28, 2023", time: "11:03 PM", title: "Ethan", meta: "Incoming · 8m 09s", hue: 260 },
    { type: "photo",    date: "Jul 15, 2023", time: "10:14 AM", title: "First tomatoes", meta: "Garden · 4 photos", hue: 80 },
    { type: "message",  date: "Jun 30, 2023", time: "3:48 PM", title: "Elmwood Vet", meta: "“Biscuit is ready for pickup”", hue: 180 },
  ],

  // --- Photos (gallery sample) ---
  photos: [
    { id: "p01", album: "Attic find",          date: "Aug 14", count: 12,  hue: 32,  big: true  },
    { id: "p02", album: "Linda's birthday",    date: "Aug 04", count: 38,  hue: 45,  big: false },
    { id: "p03", album: "Garden, July",        date: "Jul 15", count: 24,  hue: 80,  big: false },
    { id: "p04", album: "Ethan home",          date: "Jul 28", count: 17,  hue: 260, big: true  },
    { id: "p05", album: "Dock is finished",    date: "Jul 03", count: 9,   hue: 200, big: false },
    { id: "p06", album: "Farmers market",      date: "Jun 18", count: 31,  hue: 14,  big: false },
    { id: "p07", album: "Biscuit",             date: "Jun 11", count: 22,  hue: 180, big: false },
    { id: "p08", album: "Book club, Sunday",   date: "May 21", count: 8,   hue: 120, big: false },
    { id: "p09", album: "Coast trip",          date: "Apr 30", count: 64,  hue: 210, big: true  },
    { id: "p10", album: "Roses",               date: "Apr 12", count: 11,  hue: 340, big: false },
    { id: "p11", album: "Grandkids",           date: "Mar 26", count: 53,  hue: 35,  big: false },
    { id: "p12", album: "Spring cleaning",     date: "Mar 08", count: 19,  hue: 90,  big: false },
  ],

  // --- Voicemails ---
  voicemails: [
    { id: "v1", from: "Dr. Okafor — Elmwood Vet", date: "Aug 11, 2023", time: "9:18 AM", duration: "0:48", transcript: "Hi Mrs. Whitfield — Biscuit is all set, ready for pickup any time after noon. He did great.", unread: false },
    { id: "v2", from: "Sarah Whitfield",          date: "Jul 22, 2023", time: "4:02 PM", duration: "1:24", transcript: "Hey it's me — just calling to say the casserole dish is at Mom's if you're looking for it. Love you.", unread: false },
    { id: "v3", from: "Unknown",                  date: "Jul 10, 2023", time: "11:55 AM", duration: "0:12", transcript: "[silence]", unread: false },
    { id: "v4", from: "Dad ❤",                    date: "Jun 24, 2023", time: "8:41 PM", duration: "2:03", transcript: "Hi honey — the dock is finally done. Came out beautiful. Come see it this weekend if you can.", unread: false },
    { id: "v5", from: "Linda Park",               date: "Jun 02, 2023", time: "5:28 PM", duration: "0:52", transcript: "Hi Marie! Just confirming dinner on the 4th — 7 PM, bring that peach thing you make.", unread: false },
    { id: "v6", from: "Ethan",                    date: "May 19, 2023", time: "1:17 PM", duration: "0:34", transcript: "Mom, ignore what I said about the flight — moved it to Friday. Talk soon.", unread: false },
  ],

  // --- Calls (recent) ---
  calls: [
    { dir: "out",     who: "Dad ❤",              date: "Aug 13 · 6:42 PM", dur: "14m 22s", svc: "FaceTime" },
    { dir: "in",      who: "Emma",               date: "Aug 13 · 2:06 PM", dur: "3m 01s",  svc: "Phone"    },
    { dir: "missed",  who: "Unknown (local)",    date: "Aug 12 · 9:04 AM", dur: "—",       svc: "Phone"    },
    { dir: "in",      who: "Sarah Whitfield",    date: "Aug 11 · 11:42 AM",dur: "22m 44s", svc: "Phone"    },
    { dir: "out",     who: "Elmwood Vet",        date: "Aug 11 · 8:58 AM", dur: "1m 12s",  svc: "Phone"    },
    { dir: "in",      who: "Linda Park",         date: "Aug 04 · 7:14 PM", dur: "5m 30s",  svc: "Phone"    },
    { dir: "out",     who: "Ethan",              date: "Jul 28 · 11:03 PM",dur: "8m 09s",  svc: "FaceTime" },
    { dir: "missed",  who: "Spam Likely",        date: "Jul 27 · 3:01 PM", dur: "—",       svc: "Phone"    },
    { dir: "out",     who: "Carol Whitfield",    date: "Jul 15 · 9:28 AM", dur: "47m 12s", svc: "Phone"    },
    { dir: "in",      who: "Book Club",          date: "Jul 09 · 4:00 PM", dur: "1h 12m",  svc: "Phone"    },
  ],

  // --- Contacts (richer) ---
  contacts: [
    { name: "Emma Whitfield",    role: "Daughter",   phone: "555-0141", email: "emma@whitfield.fam",  hue: 14,  freq: 847 },
    { name: "Dad ❤",             role: "Husband",    phone: "555-0102", email: "j.whitfield@me.com",  hue: 200, freq: 612 },
    { name: "Ethan Whitfield",   role: "Son",        phone: "555-0187", email: "ethan@whitfield.fam", hue: 260, freq: 428 },
    { name: "Sarah Whitfield",   role: "Sister",     phone: "555-0199", email: "sarah.w@gmail.com",   hue: 340, freq: 401 },
    { name: "Linda Park",        role: "Best friend",phone: "555-0123", email: "lindap@me.com",       hue: 45,  freq: 312 },
    { name: "Carol Whitfield",   role: "Mother",     phone: "555-0166", email: null,                   hue: 80,  freq: 289 },
    { name: "Dr. R. Okafor",     role: "Vet",        phone: "555-0190", email: "care@elmwoodvet.com", hue: 180, freq: 42  },
    { name: "Book Club",         role: "Group",      phone: "—",        email: null,                   hue: 120, freq: 88  },
    { name: "Marjorie Finch",    role: "Book club",  phone: "555-0117", email: "marj@gmail.com",      hue: 300, freq: 64  },
    { name: "Pastor Lee",        role: "Community",  phone: "555-0143", email: null,                   hue: 220, freq: 31  },
    { name: "Paul the plumber",  role: "Service",    phone: "555-0175", email: null,                   hue: 30,  freq: 9   },
    { name: "Pharmacy",          role: "Service",    phone: "555-0188", email: null,                   hue: 150, freq: 22  },
  ],

  // --- Notes ---
  notes: [
    { id: "n1", title: "Grandkids' sizes",          date: "Aug 10, 2023", preview: "Emma: medium, navy preferred. Nora: 6X, avoid pink if possible. Ethan: large…", pinned: true  },
    { id: "n2", title: "Grocery list",              date: "Aug 09, 2023", preview: "bread, peaches, vanilla, olive oil, that cheese Dad likes", pinned: false },
    { id: "n3", title: "Mom's peach cobbler",       date: "Jul 30, 2023", preview: "6 peaches, 1c flour, 1c sugar, 1 stick butter, 1c milk, tsp baking powder…", pinned: true  },
    { id: "n4", title: "Books to read next",        date: "Jul 14, 2023", preview: "Demon Copperhead (Marjorie rec), Tom Lake, Trust (Hernan Diaz)", pinned: false },
    { id: "n5", title: "Passwords (old router)",    date: "Mar 02, 2023", preview: "not storing any here anymore — use the little book", pinned: false },
    { id: "n6", title: "Letters in attic (1987)",   date: "Aug 14, 2023", preview: "23 letters, Dad to Mom. Postmarks: Ann Arbor, Boulder, Charleston.", pinned: false },
    { id: "n7", title: "Biscuit vet notes",         date: "Jun 11, 2023", preview: "senior food, half scoop breakfast, no table scraps per Dr. Okafor", pinned: false },
  ],
};
