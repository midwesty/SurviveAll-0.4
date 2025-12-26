/* ============================================================================
  RV ROVER (v0.2.6) — game.js
  Single-file MVP engine + UI (HTML/CSS coming next), data-driven via JSON.
  - Loads data from /data/*.json (config/items/recipes/stations/jobs/biomes/npcs/animals)
  - Falls back to embedded starter data if JSON files aren’t present yet
  - Manual location update (GPS -> geohash tileId)
  - Weighted + neighbor-influenced biome generation
  - Tutorial overlay on the player’s first real tile (NPC recruit included)
  - Offline progression (real-time elapsed), job queues, crafting queues
  - Hunger/thirst/morale, moodlets, sickness, injuries, tool durability
  - Manual save slots + hidden safety snapshot
  - Admin panel toggle with ~ (backtick) for time fast-forward + debug tools

  NOTE:
  - This file builds the entire UI dynamically so it can run even before
    index.html/style.css exist. When we create HTML/CSS, we can either keep
    this auto-UI or switch to binding to your markup.
============================================================================ */

(() => {
  "use strict";

  // Build marker (helps confirm which file the browser is actually running)
  window.RVROVER_BUILD = "v0.3.0";
  console.log("[RV ROVER] Loaded", window.RVROVER_BUILD);

  /* =========================
     Constants / Storage Keys
  ========================= */
  const APP_ID = "rv_rover_v01";
  const LS_SAVES_KEY = `${APP_ID}__saves`;
  const LS_SNAPSHOT_KEY = `${APP_ID}__snapshot`;
  const LS_LAST_ACTIVE_SAVE_KEY = `${APP_ID}__lastActiveSaveId`;
  const LS_ADMIN_UNLOCK_KEY = `${APP_ID}__adminUnlocked`;

  // Storage wrapper: falls back to in-memory storage if localStorage is blocked
  const __memStore = Object.create(null);
  const store = {
    getItem(key) {
      try { return window.localStorage.getItem(key); } catch { return __memStore[key] ?? null; }
    },
    setItem(key, val) {
      try { window.localStorage.setItem(key, String(val)); } catch { __memStore[key] = String(val); }
    },
    removeItem(key) {
      try { window.localStorage.removeItem(key); } catch { delete __memStore[key]; }
    }
  };


  /* =========================
     Utilities
  ========================= */
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const nowReal = () => Date.now();

  function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  function uid(prefix = "id") {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${ss}s`;
    return `${ss}s`;
  }

  function fmtStamp(ts) {
    const d = new Date(ts);
    return d.toLocaleString();
  }

  function hashStringToUint(str) {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    // Deterministic RNG from seed (uint32)
    return function () {
      let t = (seed += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, min, max) {
    // Inclusive integer in [min, max]. Accepts an RNG function (0..1).
    const a = Number.isFinite(min) ? min : 0;
    const b = Number.isFinite(max) ? max : a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const r = (typeof rng === "function") ? rng() : Math.random();
    return lo + Math.floor(r * (hi - lo + 1));
  }


  function normalizePortraitPath(p) {
    if (typeof p !== "string") return "";
    let s = p.trim();
    if (!s) return "";
    // Allow absolute URLs if user ever supplies them (still works on GH Pages)
    if (/^(https?:)?\/\//i.test(s)) return s;
    // Normalize leading ./ or /
    if (s.startsWith("./")) s = s.slice(2);
    if (s.startsWith("/")) s = s.slice(1);
    // If it's just a filename, assume it's in images/portraits/
    if (!s.includes("/")) return `images/portraits/${s}`;
    return s;
  }

  function initialsFromName(name) {
    const s = String(name || "").trim();
    if (!s) return "?";
    const parts = s.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? "?";
    const b = (parts.length > 1 ? parts[parts.length - 1]?.[0] : parts[0]?.[1]) ?? "";
    return (a + b).toUpperCase();
  }


  function weightedPick(rng, entries /* [{id, w}] */) {
    const total = entries.reduce((a, e) => a + Math.max(0, e.w), 0);
    if (total <= 0) return entries[0]?.id ?? null;
    let roll = rng() * total;
    for (const e of entries) {
      roll -= Math.max(0, e.w);
      if (roll <= 0) return e.id;
    }
    return entries[entries.length - 1].id;
  }

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, k);
      else if (v !== false && v != null) n.setAttribute(k, String(v));
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === "string") n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    }
    return n;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function toast(msg, ms = 2000) {
    const t = el("div", { class: "toast" }, [msg]);
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, ms);
  }

  function confirmModal(title, bodyHtml, okText = "OK", cancelText = "Cancel") {
    return new Promise((resolve) => {
      const overlay = el("div", { class: "modalOverlay" });
      const modal = el("div", { class: "modal" });
      modal.appendChild(el("div", { class: "modalTitle" }, [title]));
      modal.appendChild(el("div", { class: "modalBody", html: bodyHtml }));
      const row = el("div", { class: "modalRow" });
      const btnCancel = el("button", { class: "btn ghost", onclick: () => { overlay.remove(); resolve(false); } }, [cancelText]);
      const btnOk = el("button", { class: "btn", onclick: () => { overlay.remove(); resolve(true); } }, [okText]);
      row.append(btnCancel, btnOk);
      modal.appendChild(row);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    });
  }

  function inputModal(title, label, placeholder = "", defaultValue = "") {
    return new Promise((resolve) => {
      const overlay = el("div", { class: "modalOverlay" });
      const modal = el("div", { class: "modal" });
      modal.appendChild(el("div", { class: "modalTitle" }, [title]));
      const body = el("div", { class: "modalBody" });
      body.appendChild(el("div", { class: "smallLabel" }, [label]));
      const inp = el("input", { class: "input", placeholder, value: defaultValue });
      body.appendChild(inp);
      modal.appendChild(body);
      const row = el("div", { class: "modalRow" });
      const btnCancel = el("button", { class: "btn ghost", onclick: () => { overlay.remove(); resolve(null); } }, ["Cancel"]);
      const btnOk = el("button", { class: "btn", onclick: () => { overlay.remove(); resolve(inp.value.trim()); } }, ["OK"]);
      row.append(btnCancel, btnOk);
      modal.appendChild(row);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      inp.focus();
      inp.select();
    });
  }

  function chooseModal(title, subtitle, options, cancelText = "Cancel") {
    // options: [{ id, label, hint? }]
    return new Promise((resolve) => {
      const overlay = el("div", { class: "modalOverlay" });
      const modal = el("div", { class: "modal" });
      modal.appendChild(el("div", { class: "modalTitle" }, [title]));
      const body = el("div", { class: "modalBody" });
      if (subtitle) body.appendChild(el("div", { class: "hint" }, [subtitle]));
      const list = el("div", { class: "panelStack" });
      for (const opt of options) {
        const card = el("div", { class: "card" });
        card.appendChild(el("div", { class: "cardTitle" }, [opt.label]));
        if (opt.hint) card.appendChild(el("div", { class: "hint" }, [opt.hint]));
        const btn = el("button", { class: "btn", onclick: () => { overlay.remove(); resolve(opt.id); } }, ["Select"]);
        card.appendChild(btn);
        list.appendChild(card);
      }
      body.appendChild(list);
      modal.appendChild(body);

      const row = el("div", { class: "modalRow" });
      const btnCancel = el("button", {
        class: "btn ghost",
        onclick: () => { overlay.remove(); resolve(null); }
      }, [cancelText]);
      row.appendChild(btnCancel);
      modal.appendChild(row);

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    });
  }


  /* =========================
     Geohash (encode + neighbors)
     (No external libs)
  ========================= */
  const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  const GEOHASH_BITS = [16, 8, 4, 2, 1];

  function geohashEncode(lat, lon, precision = 7) {
    let idx = 0;
    let bit = 0;
    let evenBit = true;
    let geohash = "";

    let latMin = -90, latMax = 90;
    let lonMin = -180, lonMax = 180;

    while (geohash.length < precision) {
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2;
        if (lon >= mid) { idx = idx * 2 + 1; lonMin = mid; }
        else { idx = idx * 2; lonMax = mid; }
      } else {
        const mid = (latMin + latMax) / 2;
        if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; }
        else { idx = idx * 2; latMax = mid; }
      }

      evenBit = !evenBit;

      if (++bit === 5) {
        geohash += GEOHASH_BASE32.charAt(idx);
        bit = 0;
        idx = 0;
      }
    }
    return geohash;
  }

  // Neighbor lookup tables for geohash (classic approach)
  const NEIGHBORS = {
    right:  { even: "bc01fg45238967deuvhjyznpkmstqrwx" , odd: "p0r21436x8zb9dcf5h7kjnmqesgutwvy" },
    left:   { even: "238967debc01fg45kmstqrwxuvhjyznp" , odd: "14365h7k9dcfesgujnmqp0r2twvyx8zb" },
    top:    { even: "p0r21436x8zb9dcf5h7kjnmqesgutwvy" , odd: "bc01fg45238967deuvhjyznpkmstqrwx" },
    bottom: { even: "14365h7k9dcfesgujnmqp0r2twvyx8zb" , odd: "238967debc01fg45kmstqrwxuvhjyznp" }
  };
  const BORDERS = {
    right:  { even: "bcfguvyz", odd: "prxz" },
    left:   { even: "0145hjnp", odd: "028b" },
    top:    { even: "prxz", odd: "bcfguvyz" },
    bottom: { even: "028b", odd: "0145hjnp" }
  };

  function geohashAdjacent(hash, dir) {
    hash = hash.toLowerCase();
    const last = hash.slice(-1);
    const type = (hash.length % 2) ? "odd" : "even";
    const base = hash.slice(0, -1);

    if (BORDERS[dir][type].includes(last) && base.length > 0) {
      const baseAdj = geohashAdjacent(base, dir);
      return baseAdj + GEOHASH_BASE32.charAt(NEIGHBORS[dir][type].indexOf(last));
    } else {
      return base + GEOHASH_BASE32.charAt(NEIGHBORS[dir][type].indexOf(last));
    }
  }

  function geohashNeighbors(hash) {
    const n = geohashAdjacent(hash, "top");
    const s = geohashAdjacent(hash, "bottom");
    const e = geohashAdjacent(hash, "right");
    const w = geohashAdjacent(hash, "left");
    return { n, s, e, w, ne: geohashAdjacent(n, "right"), nw: geohashAdjacent(n, "left"), se: geohashAdjacent(s, "right"), sw: geohashAdjacent(s, "left") };
  }

  

  // Convert geohash string to stable grid coordinates (integer indices) and back.
  // This gives us a lightweight "map coordinate system" without storing explicit coords per tile.
  function geohashToGridCoords(gh) {
    gh = String(gh || "");
    const precision = gh.length;
    const totalBits = precision * 5;
    const lonBits = Math.ceil(totalBits / 2);
    const latBits = Math.floor(totalBits / 2);

    let x = 0;
    let y = 0;
    let isLon = true; // geohash starts with lon bit

    for (let i = 0; i < precision; i++) {
      const ch = gh[i];
      const v = GEOHASH_BASE32.indexOf(ch);
      if (v < 0) continue;
      for (let b = 0; b < 5; b++) {
        const mask = GEOHASH_BITS[b];
        const bit = (v & mask) ? 1 : 0;
        if (isLon) x = (x << 1) | bit;
        else y = (y << 1) | bit;
        isLon = !isLon;
      }
    }

    return { x, y, lonBits, latBits, precision };
  }

  function gridCoordsToGeohash(x, y, precision) {
    precision = Math.max(1, Math.floor(precision || 1));
    const totalBits = precision * 5;
    const lonBits = Math.ceil(totalBits / 2);
    const latBits = Math.floor(totalBits / 2);

    x = Math.max(0, Math.floor(x || 0));
    y = Math.max(0, Math.floor(y || 0));

    // clamp to range (note: for very high precisions, bit ops overflow; v0.4 uses config.tilePrecision ~7)
    const xMax = (1 << lonBits) - 1;
    const yMax = (1 << latBits) - 1;
    x = Math.min(x, xMax);
    y = Math.min(y, yMax);

    let out = "";
    let bit = 0;
    let ch = 0;

    let xi = lonBits - 1;
    let yi = latBits - 1;
    let isLon = true;

    for (let i = 0; i < totalBits; i++) {
      const v = isLon ? ((x >> xi) & 1) : ((y >> yi) & 1);
      if (isLon) xi--;
      else yi--;
      isLon = !isLon;

      ch = (ch << 1) | v;
      bit++;
      if (bit === 5) {
        out += GEOHASH_BASE32[ch];
        bit = 0;
        ch = 0;
      }
    }
    return out;
  }

  function geohashGridDistance(a, b) {
    a = String(a || "");
    b = String(b || "");
    if (!a || !b) return 0;
    const precision = Math.min(a.length, b.length);
    const ga = geohashToGridCoords(a.slice(0, precision));
    const gb = geohashToGridCoords(b.slice(0, precision));
    return Math.abs(ga.x - gb.x) + Math.abs(ga.y - gb.y);
  }

  function geohashMoveByGrid(tileId, dx, dy, precision = null) {
    tileId = String(tileId || "");
    precision = precision || tileId.length || 7;
    const g = geohashToGridCoords(tileId.slice(0, precision));
    const nx = g.x + Math.floor(dx || 0);
    const ny = g.y + Math.floor(dy || 0);
    return gridCoordsToGeohash(nx, ny, precision);
  }

/* =========================
     Embedded fallback data
     (Used until you add JSON files)
  ========================= */
  const FALLBACK_DATA = {
    config: {
      version: "0.1",
      worldSeed: "WORLD_V01",
      tilePrecision: 7,
      maxLogEntries: 600,
      safetySnapshotEnabled: true,
      // drain rates are per minute in real-time
      drains: {
        hungerPerMin: 0.25,
        thirstPerMin: 0.35,
        moraleRecoverPerMinRest: 0.10
      },
      jobStrenuousDrainMultiplier: 2.0,
      autoConsumeThreshold: 50,
      autoConsumeAmountTarget: 70,
      idleMaxCyclesPerSim: 20,
      adminPassphrase: "ROVER",
      dayNight: {
        dayStartHour: 6,
        nightStartHour: 18
      }
    },

    biomes: [
      { id: "wild_forest", name: "Wild Forest Edge", weight: 22, tags: ["wild"], bg: "bg_forest" },
      { id: "riverbed", name: "Riverbed Flats", weight: 12, tags: ["wet"], bg: "bg_river" },
      { id: "overgrown_suburb", name: "Overgrown Suburb", weight: 20, tags: ["ruins","wild"], bg: "bg_suburb" },
      { id: "collapsed_downtown", name: "Collapsed Downtown", weight: 14, tags: ["ruins","danger"], bg: "bg_downtown" },
      { id: "industrial_scrap", name: "Industrial Scrapfields", weight: 16, tags: ["ruins","industrial"], bg: "bg_industrial" },
      { id: "desert_highway", name: "Desert Highway Cut", weight: 16, tags: ["dry"], bg: "bg_desert" }
    ],

    items: [
      // basics
      { id: "stick", name: "Stick", category: "resource", stackSize: 50, sources: [{ biomes: ["*"], methods: ["forage"] }] },
      { id: "stone", name: "Stone", category: "resource", stackSize: 50, sources: [{ biomes: ["*"], methods: ["forage"] }] },
      { id: "fiber", name: "Fiber/Reeds", category: "resource", stackSize: 50, sources: [{ biomes: ["*"], methods: ["forage"] }, { biomes: ["riverbed","wild_forest"], methods: ["forage"] }] },
      { id: "scrap_metal", name: "Scrap Metal", category: "resource", stackSize: 50, sources: [{ biomes: ["overgrown_suburb","collapsed_downtown","industrial_scrap"], methods: ["scavenge"] }] },
      { id: "wiring", name: "Wiring Bundle", category: "resource", stackSize: 50, sources: [{ biomes: ["overgrown_suburb","collapsed_downtown","industrial_scrap"], methods: ["scavenge"] }] },

      // food/water
      { id: "ration_basic", name: "Basic Ration Pack", category: "food", stackSize: 20, food: { hunger: 10, morale: -2, quality: "low" } },
      { id: "water_clean", name: "Clean Water", category: "water", stackSize: 20, water: { thirst: 18, morale: 0 } },
      { id: "water_dirty", name: "Dirty Water", category: "water", stackSize: 20, water: { thirst: 12, morale: -2, dirty: true } },
      { id: "meat_raw", name: "Raw Meat", category: "food", stackSize: 20, food: { hunger: 8, morale: -1, quality: "low", raw: true } },
      { id: "fish_raw", name: "Raw Fish", category: "food", stackSize: 20, food: { hunger: 7, morale: -1, quality: "low", raw: true } },
      { id: "meal_hearty", name: "Hearty Meal", category: "food", stackSize: 10, food: { hunger: 28, morale: +10, quality: "high" } },

      // consumables/medical
      { id: "bandage", name: "Bandage", category: "medical", stackSize: 10, med: { minorInjuryReduceMins: 90 } },
      { id: "antidote", name: "Antidote", category: "medical", stackSize: 5, med: { cureSickness: true }, rarity: "rare" },
      { id: "revive_serum", name: "Revive Serum", category: "medical", stackSize: 3, med: { revive: true }, rarity: "rare" },

      // tools & weapons (individual items)
      { id: "knife_pocket", name: "Pocket Knife", category: "tool", stackSize: 1, equipSlot: "mainHand", tool: { tag: "cutting", tier: 0, durabilityMax: 60, power: 1 } },
      { id: "spear_fishing", name: "Fishing Spear", category: "tool", stackSize: 1, equipSlot: "mainHand", tool: { tag: "fishing", tier: 1, durabilityMax: 70, power: 2 } },
      { id: "trap_simple", name: "Simple Trap", category: "tool", stackSize: 1, equipSlot: "utility", tool: { tag: "trap", tier: 1, durabilityMax: 40, power: 1 } },
      { id: "hatchet_stone", name: "Stone Hatchet", category: "tool", stackSize: 1, equipSlot: "mainHand", tool: { tag: "chopping", tier: 1, durabilityMax: 55, power: 2 } },

      // armor (individual)
      { id: "clothes_basic", name: "Basic Clothes", category: "armor", stackSize: 1, equipSlot: "body", armor: { tier: 0, durabilityMax: 80, protection: 0.05 } },
      { id: "boots_scrap", name: "Scrap Boots", category: "armor", stackSize: 1, equipSlot: "legs", armor: { tier: 1, durabilityMax: 90, protection: 0.08 } }
    ],

    stations: [
      {
        id: "storage",
        name: "Storage",
        desc: "Shared RV storage holds your supplies.",
        levels: [
          { level: 0, cost: [], effects: [{ type: "storageCap", value: 60 }] },
          { level: 1, cost: [{ id: "scrap_metal", qty: 10 }, { id: "wiring", qty: 3 }], effects: [{ type: "storageCap", value: 90 }] },
          { level: 2, cost: [{ id: "scrap_metal", qty: 25 }, { id: "wiring", qty: 10 }], effects: [{ type: "storageCap", value: 130 }] }
        ]
      },
      {
        id: "bunks",
        name: "Bunks",
        desc: "More bunks let you recruit more crew.",
        levels: [
          { level: 0, cost: [], effects: [{ type: "crewCap", value: 2 }] },
          { level: 1, cost: [{ id: "fiber", qty: 12 }, { id: "scrap_metal", qty: 8 }], effects: [{ type: "crewCap", value: 3 }] },
          { level: 2, cost: [{ id: "fiber", qty: 25 }, { id: "scrap_metal", qty: 18 }, { id: "wiring", qty: 5 }], effects: [{ type: "crewCap", value: 4 }] }
        ]
      },
      {
        id: "workbench",
        name: "Workbench",
        desc: "Craft tools, repair gear, process basics.",
        levels: [
          { level: 0, cost: [], effects: [{ type: "stationLevel", station: "workbench", value: 0 }] },
          { level: 1, cost: [{ id: "scrap_metal", qty: 12 }], effects: [{ type: "stationLevel", station: "workbench", value: 1 }] },
          { level: 2, cost: [{ id: "scrap_metal", qty: 28 }, { id: "wiring", qty: 8 }], effects: [{ type: "stationLevel", station: "workbench", value: 2 }] }
        ]
      },
      {
        id: "stove",
        name: "Camp Stove",
        desc: "Cook food and boil water.",
        levels: [
          { level: 0, cost: [], effects: [{ type: "stationLevel", station: "stove", value: 0 }] },
          { level: 1, cost: [{ id: "scrap_metal", qty: 10 }], effects: [{ type: "stationLevel", station: "stove", value: 1 }] }
        ]
      },
      {
        id: "purifier",
        name: "Water Purifier",
        desc: "Purify dirty water more efficiently.",
        levels: [
          { level: 0, cost: [], effects: [{ type: "purifierEnabled", value: false }] },
          { level: 1, cost: [{ id: "wiring", qty: 6 }, { id: "scrap_metal", qty: 12 }], effects: [{ type: "purifierEnabled", value: true }] }
        ]
      },
      {
        id: "recycler",
        name: "Recycler",
        desc: "Break down salvage into parts.",
        levels: [
          { level: 0, cost: [], effects: [{ type: "recyclerEnabled", value: false }] },
          { level: 1, cost: [{ id: "scrap_metal", qty: 18 }, { id: "wiring", qty: 7 }], effects: [{ type: "recyclerEnabled", value: true }] }
        ]
      }
    ],

    recipes: [
      // Workbench
      { id: "cordage", name: "Cordage", category: "materials", station: "workbench", stationLevel: 0, timeSec: 60, inputs: [{ id: "fiber", qty: 3 }], outputs: [{ id: "fiber", qty: 0 }], // outputs handled as special below
        special: { makeItem: { id: "cordage_item", name: "Cordage", category: "material", stackSize: 30, sources: [] }, qty: 1 }
      },
      { id: "spear_fishing", name: "Fishing Spear", category: "tools", station: "workbench", stationLevel: 0, timeSec: 180,
        inputs: [{ id: "stick", qty: 3 }, { id: "stone", qty: 2 }, { id: "fiber", qty: 2 }],
        outputs: [{ id: "spear_fishing", qty: 1 }]
      },
      { id: "trap_simple", name: "Simple Trap", category: "tools", station: "workbench", stationLevel: 0, timeSec: 150,
        inputs: [{ id: "stick", qty: 2 }, { id: "fiber", qty: 3 }],
        outputs: [{ id: "trap_simple", qty: 1 }]
      },
      { id: "hatchet_stone", name: "Stone Hatchet", category: "tools", station: "workbench", stationLevel: 0, timeSec: 210,
        inputs: [{ id: "stick", qty: 2 }, { id: "stone", qty: 3 }, { id: "fiber", qty: 2 }],
        outputs: [{ id: "hatchet_stone", qty: 1 }]
      },
      { id: "bandage", name: "Bandage", category: "medical", station: "workbench", stationLevel: 0, timeSec: 120,
        inputs: [{ id: "fiber", qty: 4 }],
        outputs: [{ id: "bandage", qty: 1 }]
      },

      // Stove
      { id: "cook_meat", name: "Cook Meat", category: "food", station: "stove", stationLevel: 0, timeSec: 180,
        inputs: [{ id: "meat_raw", qty: 1 }],
        outputs: [{ id: "ration_basic", qty: 1 }]
      },
      { id: "cook_fish", name: "Cook Fish", category: "food", station: "stove", stationLevel: 0, timeSec: 150,
        inputs: [{ id: "fish_raw", qty: 1 }],
        outputs: [{ id: "ration_basic", qty: 1 }]
      },
      { id: "boil_water", name: "Boil Dirty Water", category: "water", station: "stove", stationLevel: 0, timeSec: 120,
        inputs: [{ id: "water_dirty", qty: 1 }],
        outputs: [{ id: "water_clean", qty: 1 }]
      },
      { id: "meal_hearty", name: "Hearty Meal", category: "food", station: "stove", stationLevel: 1, timeSec: 600,
        inputs: [{ id: "ration_basic", qty: 2 }, { id: "fiber", qty: 1 }],
        outputs: [{ id: "meal_hearty", qty: 1 }]
      }
    ],

    jobs: [
      { id: "forage", name: "Forage", alwaysAvailable: true, baseSec: 600, strenuous: false, toolTag: "cutting",
        yields: [{ id: "stick", min: 2, max: 6 }, { id: "stone", min: 1, max: 4 }, { id: "fiber", min: 0, max: 4 }],
        risk: { minorInjury: 0.03, majorInjury: 0.005, toolWear: 0.12, sickness: 0.00 },
        xpSkill: "Wilderness"
      },
      { id: "fish", name: "Fish", alwaysAvailable: true, baseSec: 900, strenuous: false, toolTag: "fishing",
        yields: [{ id: "fish_raw", min: 1, max: 3 }, { id: "water_dirty", min: 0, max: 1 }],
        risk: { minorInjury: 0.02, majorInjury: 0.004, toolWear: 0.10, sickness: 0.00 },
        xpSkill: "Wilderness"
      },
      { id: "hunt", name: "Hunt", alwaysAvailable: true, baseSec: 1200, strenuous: true, toolTag: "cutting",
        yields: [{ id: "meat_raw", min: 1, max: 3 }],
        risk: { minorInjury: 0.06, majorInjury: 0.01, toolWear: 0.15, sickness: 0.00 },
        xpSkill: "Wilderness"
      },
      { id: "trap", name: "Set Traps", alwaysAvailable: true, baseSec: 1800, strenuous: false, toolTag: "trap",
        yields: [{ id: "meat_raw", min: 0, max: 3 }],
        risk: { minorInjury: 0.04, majorInjury: 0.007, toolWear: 0.10, sickness: 0.00 },
        requiresItem: "trap_simple",
        xpSkill: "Wilderness"
      },
      { id: "scavenge", name: "Scavenge Ruins", alwaysAvailable: false, biomeTags: ["ruins"], baseSec: 1500, strenuous: true, toolTag: "chopping",
        yields: [{ id: "scrap_metal", min: 2, max: 7 }, { id: "wiring", min: 0, max: 2 }],
        risk: { minorInjury: 0.09, majorInjury: 0.02, toolWear: 0.20, sickness: 0.03 },
        xpSkill: "Scavenge"
      }
    ],

    npcs: [
      {
        id: "npc_scavenger",
        name: "Zig",
        archetype: "Lone Scavenger",
        perk: { id: "perk_scrounger", name: "Scrounger", desc: "+10% salvage yield." },
        quirk: { id: "quirk_picky", name: "Picky Eater", desc: "Hates low-tier rations." },
        stats: { Wilderness: 2, Scavenge: 5, Mechanics: 2, Cooking: 1, Medical: 1, Grit: 4 }
      },
      {
        id: "npc_medic",
        name: "Dot",
        archetype: "Road Medic",
        perk: { id: "perk_fieldmed", name: "Field Medic", desc: "Reduces injury downtime." },
        quirk: { id: "quirk_germaphobe", name: "Germaphobe", desc: "Hates dirty water (morale hit)." },
        stats: { Wilderness: 2, Scavenge: 2, Mechanics: 1, Cooking: 2, Medical: 6, Grit: 3 }
      }
    ],

    animals: [
      { id: "rabbit", name: "Rabbit", biomes: ["wild_forest","riverbed","overgrown_suburb"], drops: [{ id: "meat_raw", min: 1, max: 2 }] },
      { id: "raccoon", name: "Raccoon", biomes: ["overgrown_suburb","collapsed_downtown"], drops: [{ id: "meat_raw", min: 1, max: 2 }, { id: "scrap_metal", min: 0, max: 1 }] }
    ],

    portraits: [],

    structures: []
  
    ,
    maps: {
      // v0.4 map tuning (minimal + expandable)
      view: { size: 5, minSize: 5, maxSize: 15 },
      travel: { baseMinutesPerTile: 60 },
      biomes: {
        // If a biomeId is present here, it overrides tile defaults on first discovery.
      },
      defaults: { danger: 1, travelTimeMod: 1.0 }
    }

  };

  /* =========================
     Data Loader
  ========================= */
  async function fetchJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return await res.json();
  }

  async function loadData() {
    const data = {
      config: null,
      items: null,
      recipes: null,
      stations: null,
      jobs: null,
      biomes: null,
      npcs: null,
      animals: null,
      portraits: null,
      structures: null,
      maps: null
    };

    const base = "data";
    const targets = [
      ["config", `${base}/config.json`],
      ["items", `${base}/items.json`],
      ["recipes", `${base}/recipes.json`],
      ["stations", `${base}/stations.json`],
      ["jobs", `${base}/jobs.json`],
      ["biomes", `${base}/biomes.json`],
      ["npcs", `${base}/npcs.json`],
      ["animals", `${base}/animals.json`],
      ["portraits", `${base}/portraits.json`],
      ["structures", `${base}/structures.json`],
      ["maps", `${base}/maps.json`]
    ];

    let usedFallback = false;
    for (const [key, path] of targets) {
      try {
        data[key] = await fetchJson(path);
      } catch (e) {
        usedFallback = true;
        data[key] = deepCopy(FALLBACK_DATA[key]);
      }
    }

    // Normalize portraits list to an array of paths (supports array or {paths:[...]})
    let __portraitPaths = [];
    if (Array.isArray(data.portraits)) __portraitPaths = data.portraits;
    else if (data.portraits && Array.isArray(data.portraits.paths)) __portraitPaths = data.portraits.paths;
    data.portraits = (__portraitPaths || [])
      .filter(p => typeof p === "string" && p.trim())
      .map(normalizePortraitPath);

    // Normalize structures list (array expected)
    if (!Array.isArray(data.structures)) data.structures = [];

    // Normalize: build item index, recipe index, etc.
    const idx = {
      itemsById: new Map(),
      recipesById: new Map(),
      stationsById: new Map(),
      jobsById: new Map(),
      biomesById: new Map(),
      npcsById: new Map(),
      animalsById: new Map(),
      structuresById: new Map()
    };

    // Some fallback recipes create "special" item; register it if present
    for (const it of data.items) idx.itemsById.set(it.id, it);
    for (const r of data.recipes) {
      idx.recipesById.set(r.id, r);
      if (r.special?.makeItem && !idx.itemsById.has(r.special.makeItem.id)) {
        const specialItem = deepCopy(r.special.makeItem);
        data.items.push(specialItem);
        idx.itemsById.set(specialItem.id, specialItem);
      }
    }
    for (const s of data.stations) idx.stationsById.set(s.id, s);
    for (const j of data.jobs) idx.jobsById.set(j.id, j);
    // v0.2 core injections (so you can update JSON later without breaking saves)
    function __injectItem(item) {
      if (!idx.itemsById.has(item.id)) {
        data.items.push(item);
        idx.itemsById.set(item.id, item);
      }
    }
    function __injectJob(job) {
      if (!idx.jobsById.has(job.id)) {
        data.jobs.push(job);
        idx.jobsById.set(job.id, job);
      }
    }

    // Water containers (used by Gather Water)
    __injectItem({
      id: "bottle_empty",
      name: "Empty Bottle",
      category: "container",
      stackSize: 20,
      desc: "A small container that can hold water.",
      container: { waterUnits: 1, gatherSeconds: 30 }
    });
    __injectItem({
      id: "milk_jug_empty",
      name: "Empty Milk Jug",
      category: "container",
      stackSize: 10,
      desc: "A larger container.",
      container: { waterUnits: 5, gatherSeconds: 60 }
    });
    __injectItem({
      id: "bucket_empty",
      name: "Empty Bucket",
      category: "container",
      stackSize: 5,
      desc: "A big bucket (awkward but efficient).",
      container: { waterUnits: 10, gatherSeconds: 120 }
    });

    // Basic water item (dirty)
    __injectItem({
      id: "water_dirty",
      name: "Dirty Water",
      category: "water",
      stackSize: 99,
      desc: "Drinkable in a pinch. Risk of sickness.",
      water: { thirst: 25, dirty: true }
    });

    // Special jobs
    __injectJob({
      id: "gather_water",
      name: "Gather Water",
      alwaysAvailable: true,
      baseMinutes: 1,
      desc: "Fill a container with water (you choose the container).",
      safe: true,
      xpSkill: "Wilderness",
      variant: "gather_water",
      yields: []
    });

    __injectJob({
      id: "explore",
      name: "Explore Nearby Tile",
      alwaysAvailable: true,
      baseMinutes: 25,
      desc: "Send a crew member to scout a nearby tile and return with loot (requires rations in pockets).",
      safe: false,
      xpSkill: "Wilderness",
      variant: "explore",
      yields: []
    });

    for (const b of data.biomes) idx.biomesById.set(b.id, b);
    for (const n of data.npcs) idx.npcsById.set(n.id, n);
    for (const a of data.animals) idx.animalsById.set(a.id, a);
    for (const s of data.structures) idx.structuresById.set(s.id, s);

    return { data, idx, usedFallback };
  }

  /* =========================
     Game State Model
  ========================= */
  function defaultNewGameState(loadedData) {
    const { data } = loadedData;
    const ts = nowReal();

    // Base RV modules: levels (stationId -> level)
    const rvStations = {};
    for (const st of data.stations) rvStations[st.id] = 0;

    const player = makeCharacter({
      name: "Rover",
      isPlayer: true,
      baseStats: { Wilderness: 2, Scavenge: 1, Mechanics: 1, Cooking: 1, Medical: 1, Grit: 2 },
      startingGear: [
        // Equip pocket knife + basic clothes
        { itemId: "knife_pocket", equip: true },
        { itemId: "clothes_basic", equip: true }
      ],
      startingPockets: [],
      idleBehavior: "rest"
    }, loadedData);

    const state = {
      meta: {
        version: data.config.version || "0.1",
        createdAt: ts,
        lastSimAt: ts,
        timeOffsetMs: 0,
        useSimTimeForDayNight: false,
        tutorialDone: false,
        firstTileId: null,
        lastKnownLat: null,
        lastKnownLon: null,
        lastTileId: null
      },

      world: {
        discoveredTiles: {
          // tileId: { biomeId, createdAt, poiIds: [], tutorialOverlay: bool }
        },
        travel: {
          active: false,
          fromTileId: null,
          toTileId: null,
          startAt: 0,
          endAt: 0,
          nextEventAt: 0,
          seed: 0
        },
        shipments: []
      },

      rv: {
        name: "Rusty Rambler",
        stations: rvStations,
        // shared storage: stacks + individual instances
        storage: {
          capacity: 0, // computed from station effects
          rationPrefs: {}, // itemId -> boolean (persist rations even when stacks hit 0)
          stacks: [
            // { itemId, qty, isRationAllowed? } (only for food)
          ],
          instances: [
            // { uid, itemId, durability, equippedTo? }
          ]
        }
      },

      crew: {
        members: [player],
        // recruitable NPCs can appear on tile overlays
        maxCrew: 2
      },

      queues: {
        // per character id: jobQueue[]
        jobsByCharId: {},
        // per station id: craftQueue[]
        craftsByStationId: {}
      },

      log: [] // {ts, text, type, actorId?}
    };

    // Initialize per-station craft queues
    for (const st of data.stations) {
      state.queues.craftsByStationId[st.id] = [];
    }
    // Initialize per-char job queues
    for (const c of state.crew.members) {
      state.queues.jobsByCharId[c.id] = [];
    }

    // Starter supplies in RV storage
    addItemToStorage(state, loadedData, "ration_basic", 4, { rationAllowed: true });
    addItemToStorage(state, loadedData, "water_clean", 4);
    addItemToStorage(state, loadedData, "water_dirty", 1);

    // v0.2: start with a basic container so Gather Water is immediately usable
    addItemToStorage(state, loadedData, "bottle_empty", 1);

    recomputeDerivedStats(state, loadedData);
    pushLog(state, "Welcome aboard the Rusty Rambler.", "system");

    return state;
  }

  function makeCharacter({ name, isPlayer, baseStats, startingGear = [], startingPockets = [], idleBehavior = "rest" }, loadedData) {
    const { idx } = loadedData;
    const char = {
      id: uid(isPlayer ? "player" : "npc"),
      name,
      isPlayer: !!isPlayer,
      stats: deepCopy(baseStats),
      xp: { Wilderness: 0, Scavenge: 0, Mechanics: 0, Cooking: 0, Medical: 0, Grit: 0 },
      needs: {
        hunger: 80,
        thirst: 80,
        morale: 70,
        health: 100
      },
      moodlets: [
        // { id, name, endsAt, moraleDelta, note }
      ],
      conditions: {
        sickness: null, // { id, name, endsAt, severity }
        injury: null,   // { id, name, endsAt, severity: "minor"|"major" }
        downed: false
      },
      idleBehavior, // "rest" or jobId like "forage"
      pockets: {
        capacity: 6,
        stacks: deepCopy(startingPockets),
        instances: []
      },
      equipment: {
        mainHand: null,
        offHand: null,
        body: null,
        legs: null,
        utility: null
      }
    };

    // Apply starting gear as instances; store on character, not RV
    for (const g of startingGear) {
      const itemDef = idx.itemsById.get(g.itemId);
      if (!itemDef) continue;
      if (itemDef.stackSize !== 1) continue;
      const inst = makeInstance(itemDef);
      char.pockets.instances.push(inst);
      if (g.equip && itemDef.equipSlot) {
        equipInstanceOnChar(char, inst.uid, loadedData);
      }
    }

    return char;
  }

  function makeInstance(itemDef) {
    const inst = {
      uid: uid("inst"),
      itemId: itemDef.id,
      durability: null
    };
    if (itemDef.tool?.durabilityMax) inst.durability = itemDef.tool.durabilityMax;
    if (itemDef.armor?.durabilityMax) inst.durability = itemDef.armor.durabilityMax;
    return inst;
  }

  /* =========================
     Derived Stats / Effects
  ========================= */
  function recomputeDerivedStats(state, loadedData) {
    // Storage capacity, crew cap, station levels, etc.
    const { data } = loadedData;

    // Apply station effects
    let storageCap = 40; // base if no station data
    let crewCap = 1;

    for (const st of data.stations) {
      const level = state.rv.stations[st.id] ?? 0;
      const lvlDef = st.levels.find(x => x.level === level) || st.levels[0];
      if (!lvlDef) continue;

      for (const eff of (lvlDef.effects || [])) {
        if (eff.type === "storageCap") storageCap = eff.value;
        if (eff.type === "crewCap") crewCap = eff.value;
      }
    }

    state.rv.storage.capacity = storageCap;
    state.crew.maxCrew = crewCap;

    // Ensure queues for each member exist
    for (const m of state.crew.members) {
      if (!state.queues.jobsByCharId[m.id]) state.queues.jobsByCharId[m.id] = [];
    }
  }

  /* =========================
     Storage & Inventory
  ========================= */

  function makeEmptyStorage(capacity = 0) {
    return { capacity: Number.isFinite(capacity) ? capacity : 0, stacks: [], instances: [] };
  }

  function countStorageUsedObj(storageObj) {
    if (!storageObj) return 0;
    const stacks = Array.isArray(storageObj.stacks) ? storageObj.stacks : [];
    const inst = Array.isArray(storageObj.instances) ? storageObj.instances : [];
    const stackUnits = stacks.reduce((a, s) => a + (Number(s?.qty) || 0), 0);
    const instUnits = inst.length;
    return stackUnits + instUnits;
  }

  function ensureStorageShape(storageObj) {
    if (!storageObj || typeof storageObj !== "object") return makeEmptyStorage(0);
    if (!Array.isArray(storageObj.stacks)) storageObj.stacks = [];
    if (!Array.isArray(storageObj.instances)) storageObj.instances = [];
    if (!Number.isFinite(storageObj.capacity)) storageObj.capacity = 0;
    return storageObj;
  }

  function storageHasSpace(storageObj, addUnits) {
    storageObj = ensureStorageShape(storageObj);
    const cap = Number(storageObj.capacity) || 0;
    if (cap <= 0) return true; // 0/neg => unlimited (used for "ground pile")
    return (countStorageUsedObj(storageObj) + (addUnits || 0)) <= cap;
  }

  function addStackToStorageObj(storageObj, loadedData, itemId, qty, opts = {}) {
    const { idx } = loadedData;
    storageObj = ensureStorageShape(storageObj);

    qty = Math.max(0, Math.floor(qty || 0));
    if (!qty) return { ok: true };

    const it = idx.itemsById.get(itemId);
    if (!it) return { ok: false, reason: "unknown item" };

    // Capacity model: qty counts as units
    if (!storageHasSpace(storageObj, qty)) return { ok: false, reason: "Storage full" };

    const stackSize = Math.max(1, Math.floor(it.stackSize || 99));

    // Find existing stacks
    while (qty > 0) {
      let s = storageObj.stacks.find(x => x.itemId === itemId && (x.qty || 0) < stackSize);
      if (!s) {
        s = { itemId, qty: 0 };
        storageObj.stacks.push(s);
      }
      const can = Math.min(qty, stackSize - (s.qty || 0));
      s.qty = (s.qty || 0) + can;
      qty -= can;
    }
    return { ok: true };
  }

  function removeStackFromStorageObj(storageObj, loadedData, itemId, qty) {
    storageObj = ensureStorageShape(storageObj);

    qty = Math.max(0, Math.floor(qty || 0));
    if (!qty) return true;

    // total available
    let have = 0;
    for (const s of storageObj.stacks) if (s.itemId === itemId) have += (s.qty || 0);
    if (have < qty) return false;

    // remove from stacks
    for (let i = 0; i < storageObj.stacks.length && qty > 0; i++) {
      const s = storageObj.stacks[i];
      if (s.itemId !== itemId) continue;
      const take = Math.min(qty, s.qty || 0);
      s.qty = (s.qty || 0) - take;
      qty -= take;
    }

    // prune empties
    storageObj.stacks = storageObj.stacks.filter(s => (s.qty || 0) > 0);

    return true;
  }

  function getActiveTileId(state, loadedData) {
    const prec = loadedData?.data?.config?.tilePrecision || 7;
    const tileId = state?.meta?.lastTileId || geohashEncode(0, 0, prec);
    if (!state.meta.lastTileId) state.meta.lastTileId = tileId;
    return tileId;
  }

  function ensureSettlementForTile(state, loadedData, tileId) {
    const tile = getOrCreateTile(state, loadedData, tileId);
    if (!tile.settlement || typeof tile.settlement !== "object") {
      tile.settlement = {
        createdAt: gameNow(state),
        lastTickAt: gameNow(state),
        stats: { hunger: 100, thirst: 100, morale: 100 },
        citizens: [],
        structures: {},
        ground: makeEmptyStorage(0) // unlimited overflow / "ground pile"
      };
    }

    // Back-compat / shape safety
    if (!tile.settlement.stats) tile.settlement.stats = { hunger: 100, thirst: 100, morale: 100 };
    if (!Array.isArray(tile.settlement.citizens)) tile.settlement.citizens = [];
    if (!tile.settlement.structures || typeof tile.settlement.structures !== "object") tile.settlement.structures = {};
    if (!tile.settlement.ground) tile.settlement.ground = makeEmptyStorage(0);

    // Ensure instances exist for all known structure defs
    const defs = Array.isArray(loadedData?.data?.structures) ? loadedData.data.structures : [];
    for (const def of defs) {
      if (!def || !def.id) continue;
      let inst = tile.settlement.structures[def.id];
      if (!inst || typeof inst !== "object") {
        inst = tile.settlement.structures[def.id] = {
          id: def.id,
          level: 0,
          workers: [],
          storage: makeEmptyStorage(0),
          meta: {}
        };
      }
      if (!Array.isArray(inst.workers)) inst.workers = [];
      if (!inst.meta || typeof inst.meta !== "object") inst.meta = {};
      inst.storage = ensureStorageShape(inst.storage);

      // Keep storage cap in sync with current level definition (if provided)
      const lvlDef = (def.levels || []).find(x => x.level === inst.level);
      const cap = lvlDef?.storageCap;
      if (Number.isFinite(cap)) inst.storage.capacity = cap;
    }

    return tile.settlement;
  }

  function listAreaStorages(state, loadedData, opts = {}) {
    const tileId = opts.tileId || getActiveTileId(state, loadedData);
    const settlement = ensureSettlementForTile(state, loadedData, tileId);
    const defsById = loadedData?.idx?.structuresById || new Map();

    const out = [];

    // RV first (preserves existing mental model)
    if (opts.includeRv !== false) out.push({
      key: "rv",
      label: "Caravan (RV)",
      kind: "rv",
      storage: state.rv.storage,
      accept: null
    });

    // Settlement ground pile (unlimited)
    out.push({
      key: `tile:${tileId}:ground`,
      label: "Settlement: Ground Pile",
      kind: "ground",
      storage: settlement.ground,
      accept: null,
      tileId
    });

    // Built structures with storage
    for (const [sid, inst] of Object.entries(settlement.structures || {})) {
      const def = defsById.get(sid);
      if (!def) continue;
      if ((inst?.level || 0) <= 0) continue; // not built yet
      const label = `Settlement: ${def.name}${inst.level > 0 ? ` (Lv ${inst.level})` : ""}`;

      let accept = null;
      if (sid === "water_reservoir") {
        accept = (itemId, loadedData2) => {
          const it = loadedData2?.idx?.itemsById?.get(itemId);
          return it?.category === "water";
        };
      }

      out.push({
        key: `tile:${tileId}:struct:${sid}`,
        label,
        kind: "structure",
        storage: inst.storage,
        accept,
        tileId,
        structureId: sid
      });
    }

    return out;
  }

  function getStorageEntryByKey(state, loadedData, key, opts = {}) {
    const entries = listAreaStorages(state, loadedData, opts);
    return entries.find(e => e.key === key) || null;
  }

  function hasItemInStorages(entries, loadedData, itemId, qty) {
    qty = Math.max(0, Math.floor(qty || 0));
    if (!qty) return true;
    let have = 0;
    for (const e of entries) {
      const st = ensureStorageShape(e.storage);
      for (const s of st.stacks) {
        if (s.itemId === itemId) have += (s.qty || 0);
        if (have >= qty) return true;
      }
      // Instances (count as 1 unit each if itemId matches)
      for (const inst of (st.instances || [])) {
        if (inst?.itemId === itemId) have += 1;
        if (have >= qty) return true;
      }
    }
    return have >= qty;
  }

  function hasItemInAreaStorages(state, loadedData, itemId, qty = 1, opts = {}) {
    const entries = listAreaStorages(state, loadedData, opts);
    return hasItemInStorages(entries, loadedData, itemId, qty);
  }

  function removeItemFromAreaStorages(state, loadedData, itemId, qty = 1, opts = {}) {
    // Remove from RV first, then any other local storages. This preserves old behavior when possible.
    qty = Math.max(0, Math.floor(qty || 0));
    if (!qty) return true;

    const entries = listAreaStorages(state, loadedData, opts);
    const rv = entries.find(e => e.key === "rv");
    const rest = entries.filter(e => e.key !== "rv");

    // Quick verify
    if (!hasItemInStorages(entries, loadedData, itemId, qty)) return false;

    function takeFromEntry(entry) {
      const st = ensureStorageShape(entry.storage);

      // Try stacks first
      for (let i = 0; i < st.stacks.length && qty > 0; i++) {
        const s = st.stacks[i];
        if (s.itemId !== itemId) continue;
        const take = Math.min(qty, s.qty || 0);
        s.qty = (s.qty || 0) - take;
        qty -= take;
      }

      // Then instances
      if (qty > 0 && Array.isArray(st.instances)) {
        for (let i = st.instances.length - 1; i >= 0 && qty > 0; i--) {
          const inst = st.instances[i];
          if (inst?.itemId !== itemId) continue;
          st.instances.splice(i, 1);
          qty -= 1;
        }
      }

      st.stacks = st.stacks.filter(s => (s.qty || 0) > 0);
    }

    if (rv) takeFromEntry(rv);
    for (const e of rest) if (qty > 0) takeFromEntry(e);

    return qty <= 0;
  }

  function canAcceptIntoEntry(entry, itemId, loadedData) {
    if (!entry) return false;
    if (typeof entry.accept === "function") return !!entry.accept(itemId, loadedData);
    return true;
  }

  function addItemIntoEntry(state, loadedData, entry, itemId, qty, opts = {}) {
    if (!canAcceptIntoEntry(entry, itemId, loadedData)) {
      return { ok: false, reason: "That storage only accepts certain item types." };
    }
    return addStackToStorageObj(entry.storage, loadedData, itemId, qty, opts);
  }

  function transferStackBetweenEntries(state, loadedData, fromEntry, toEntry, itemId, qty) {
    qty = Math.max(0, Math.floor(qty || 0));
    if (!qty) return { ok: true };

    if (!canAcceptIntoEntry(toEntry, itemId, loadedData)) return { ok: false, reason: "Destination can't accept that item." };

    // Ensure source has it
    const src = ensureStorageShape(fromEntry.storage);
    let have = 0;
    for (const s of src.stacks) if (s.itemId === itemId) have += (s.qty || 0);
    if (have < qty) return { ok: false, reason: "Not enough in source." };

    // Capacity on destination
    if (!storageHasSpace(toEntry.storage, qty)) return { ok: false, reason: "Destination is full." };

    // Remove from source
    const ok = removeStackFromStorageObj(fromEntry.storage, loadedData, itemId, qty);
    if (!ok) return { ok: false, reason: "Not enough in source." };

    // Add to destination
    const add = addStackToStorageObj(toEntry.storage, loadedData, itemId, qty);
    if (!add.ok) {
      // Refund to source if add fails (should be rare due to capacity check)
      addStackToStorageObj(fromEntry.storage, loadedData, itemId, qty);
      return add;
    }
    return { ok: true };
  }

  function transferInstanceBetweenEntries(state, loadedData, fromEntry, toEntry, instanceId) {
    const src = ensureStorageShape(fromEntry.storage);
    const dst = ensureStorageShape(toEntry.storage);

    const idxInst = src.instances.findIndex(x => x && ((x.id || x.uid) === instanceId));
    if (idxInst < 0) return { ok: false, reason: "Instance not found." };

    const inst = src.instances[idxInst];
    if (!canAcceptIntoEntry(toEntry, inst.itemId, loadedData)) return { ok: false, reason: "Destination can't accept that item." };
    if (!storageHasSpace(dst, 1)) return { ok: false, reason: "Destination is full." };

    src.instances.splice(idxInst, 1);
    dst.instances.push(inst);
    return { ok: true };
  }

  function countStorageUsed(state, loadedData) {
    // Count total units stored (stacks qty + instances count) as MVP capacity model
    const stackUnits = state.rv.storage.stacks.reduce((a, s) => a + (s.qty || 0), 0);
    const instUnits = state.rv.storage.instances.length;
    return stackUnits + instUnits;
  }

  function getStack(state, storageObj, itemId) {
    return storageObj.stacks.find(s => s.itemId === itemId) || null;
  }

  function addItemToStorage(state, loadedData, itemId, qty = 1, opts = {}) {
    const { idx } = loadedData;
    const def = idx.itemsById.get(itemId);
    if (!def) return { ok: false, reason: "unknown item" };

    // Capacity check
    const used = countStorageUsed(state, loadedData);
    const cap = state.rv.storage.capacity || 0;
    const unitNeed = def.stackSize === 1 ? qty : qty;
    if (used + unitNeed > cap) {
      return { ok: false, reason: "storage full" };
    }

    if (def.stackSize === 1) {
      for (let i = 0; i < qty; i++) {
        state.rv.storage.instances.push(makeInstance(def));
      }
      return { ok: true };
    } else {
      let st = getStack(state, state.rv.storage, itemId);
      if (!st) {
        st = { itemId, qty: 0 };
        // Rations toggle only relevant for food category
        if (def.category === "food") {
          state.rv.storage.rationPrefs = state.rv.storage.rationPrefs || {};
          const pref = state.rv.storage.rationPrefs[itemId];
          st.isRationAllowed = opts.rationAllowed != null ? !!opts.rationAllowed : !!pref;
          // If caller explicitly set it, persist the preference immediately
          if (opts.rationAllowed != null) state.rv.storage.rationPrefs[itemId] = !!opts.rationAllowed;
        }
        state.rv.storage.stacks.push(st);
      }
      st.qty += qty;

      // Persist ration preference when explicitly provided
      if (def.category === "food" && opts.rationAllowed != null) {
        st.isRationAllowed = !!opts.rationAllowed;
        state.rv.storage.rationPrefs = state.rv.storage.rationPrefs || {};
        state.rv.storage.rationPrefs[itemId] = !!opts.rationAllowed;
      }

      return { ok: true };
    }
  }

  function removeItemFromStorage(state, loadedData, itemId, qty = 1) {
    const { idx } = loadedData;
    const def = idx.itemsById.get(itemId);
    if (!def) return false;

    if (def.stackSize === 1) {
      let removed = 0;
      for (let i = state.rv.storage.instances.length - 1; i >= 0 && removed < qty; i--) {
        if (state.rv.storage.instances[i].itemId === itemId) {
          state.rv.storage.instances.splice(i, 1);
          removed++;
        }
      }
      return removed === qty;
    } else {
      const st = getStack(state, state.rv.storage, itemId);
      if (!st || st.qty < qty) return false;
      st.qty -= qty;
      if (st.qty <= 0) {
        state.rv.storage.stacks = state.rv.storage.stacks.filter(x => x.qty > 0);
      }
      return true;
    }
  }

  /* =========================
     Pockets + Transfers (v0.2)
     - Move stacks/instances between RV storage and crew pockets
     - Enables equipping crafted gear, feeding from storage, and sending NPCs exploring
  ========================= */

  function countPocketsUsed(char) {
    const stackUnits = (char.pockets?.stacks || []).reduce((a, s) => a + (s.qty || 0), 0);
    const instUnits = (char.pockets?.instances || []).length || 0;
    return stackUnits + instUnits;
  }

  function getPocketStack(char, itemId) {
    return (char.pockets?.stacks || []).find(s => s.itemId === itemId) || null;
  }

  function addItemToPockets(state, loadedData, char, itemId, qty = 1) {
    const { idx } = loadedData;
    const def = idx.itemsById.get(itemId);
    if (!def) return { ok: false, reason: "unknown item" };
    if (!char?.pockets) return { ok: false, reason: "no pockets" };

    // Capacity check (same unit model as RV storage in v0.1)
    const used = countPocketsUsed(char);
    const cap = char.pockets.capacity ?? 0;
    if (cap > 0 && used + qty > cap) return { ok: false, reason: "pockets full" };

    if (def.stackSize === 1) {
      for (let i = 0; i < qty; i++) {
        const inst = makeInstance(def);
        char.pockets.instances.push(inst);
      }
      return { ok: true };
    } else {
      let st = getPocketStack(char, itemId);
      if (!st) {
        st = { itemId, qty: 0 };
        char.pockets.stacks.push(st);
      }
      st.qty += qty;
      return { ok: true };
    }
  }

  function removeItemFromPockets(state, loadedData, char, itemId, qty = 1) {
    const { idx } = loadedData;
    const def = idx.itemsById.get(itemId);
    if (!def) return false;
    if (!char?.pockets) return false;

    if (def.stackSize === 1) {
      let removed = 0;
      for (let i = char.pockets.instances.length - 1; i >= 0 && removed < qty; i--) {
        if (char.pockets.instances[i].itemId === itemId) {
          char.pockets.instances.splice(i, 1);
          removed++;
        }
      }
      return removed === qty;
    } else {
      const st = getPocketStack(char, itemId);
      if (!st || st.qty < qty) return false;
      st.qty -= qty;
      if (st.qty <= 0) char.pockets.stacks = char.pockets.stacks.filter(x => x.qty > 0);
      return true;
    }
  }

  function removeInstanceByUid(arr, uid) {
    const i = arr.findIndex(x => x.uid === uid);
    if (i >= 0) return arr.splice(i, 1)[0];
    return null;
  }

  function transferStackRvToChar(state, loadedData, charId, itemId, qty = 1) {
    const char = state.crew.members.find(m => m.id === charId);
    if (!char) return { ok: false, reason: "bad char" };

    // capacity pre-check
    const used = countPocketsUsed(char);
    const cap = char.pockets.capacity ?? 0;
    if (cap > 0 && used + qty > cap) return { ok: false, reason: "pockets full" };

    if (!hasItemInStorage(state, loadedData, itemId, qty)) return { ok: false, reason: "not in storage" };
    const remOk = removeItemFromStorage(state, loadedData, itemId, qty);
    if (!remOk) return { ok: false, reason: "remove failed" };

    const add = addItemToPockets(state, loadedData, char, itemId, qty);
    if (!add.ok) {
      // rollback
      addItemToStorage(state, loadedData, itemId, qty);
      return add;
    }
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function transferStackCharToRv(state, loadedData, charId, itemId, qty = 1) {
    const char = state.crew.members.find(m => m.id === charId);
    if (!char) return { ok: false, reason: "bad char" };

    if (!removeItemFromPockets(state, loadedData, char, itemId, qty)) return { ok: false, reason: "not in pockets" };
    const add = addItemToStorage(state, loadedData, itemId, qty);
    if (!add.ok) {
      // rollback
      addItemToPockets(state, loadedData, char, itemId, qty);
      return add;
    }
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function transferInstanceRvToChar(state, loadedData, charId, instUid) {
    const char = state.crew.members.find(m => m.id === charId);
    if (!char) return { ok: false, reason: "bad char" };

    const used = countPocketsUsed(char);
    const cap = char.pockets.capacity ?? 0;
    if (cap > 0 && used + 1 > cap) return { ok: false, reason: "pockets full" };

    const inst = removeInstanceByUid(state.rv.storage.instances, instUid);
    if (!inst) return { ok: false, reason: "not in storage" };

    char.pockets.instances.push(inst);
    safetySnapshot(state, loadedData);
    return { ok: true, inst };
  }

  function transferInstanceCharToRv(state, loadedData, charId, instUid) {
    const char = state.crew.members.find(m => m.id === charId);
    if (!char) return { ok: false, reason: "bad char" };

    const inst = removeInstanceByUid(char.pockets.instances, instUid);
    if (!inst) return { ok: false, reason: "not in pockets" };

    // Capacity check
    const used = countStorageUsed(state, loadedData);
    const cap = state.rv.storage.capacity || 0;
    if (cap > 0 && used + 1 > cap) {
      char.pockets.instances.push(inst);
      return { ok: false, reason: "storage full" };
    }

    state.rv.storage.instances.push(inst);

    // If it was equipped, unequip
    for (const slot of Object.keys(char.equipment)) {
      if (char.equipment[slot] === instUid) char.equipment[slot] = null;
    }

    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function dropFromRvStorage(state, loadedData, itemId, qty = 1) {
    const ok = removeItemFromStorage(state, loadedData, itemId, qty);
    if (!ok) return { ok: false, reason: "not enough" };
    pushLog(state, `Dropped ${qty}× ${(loadedData.idx.itemsById.get(itemId)?.name ?? itemId)}.`, "info", null, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function dropInstanceFromRvStorage(state, loadedData, instUid) {
    const inst = removeInstanceByUid(state.rv.storage.instances, instUid);
    if (!inst) return { ok: false, reason: "not found" };
    pushLog(state, `Dropped ${(loadedData.idx.itemsById.get(inst.itemId)?.name ?? inst.itemId)}.`, "info", null, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }


  function hasItemInStorage(state, loadedData, itemId, qty = 1) {
    const { idx } = loadedData;
    const def = idx.itemsById.get(itemId);
    if (!def) return false;
    if (def.stackSize === 1) {
      const count = state.rv.storage.instances.filter(i => i.itemId === itemId).length;
      return count >= qty;
    }
    const st = getStack(state, state.rv.storage, itemId);
    return (st?.qty || 0) >= qty;
  }

  function equipInstanceOnChar(char, instanceUid, loadedData) {
    const { idx } = loadedData;
    const inst = char.pockets.instances.find(i => i.uid === instanceUid) || null;
    if (!inst) return false;
    const def = idx.itemsById.get(inst.itemId);
    if (!def || !def.equipSlot) return false;

    const slot = def.equipSlot;
    // Unequip current
    if (char.equipment[slot]) {
      // no special action needed; instance remains in pockets
      char.equipment[slot] = null;
    }
    char.equipment[slot] = inst.uid;
    return true;
  }

  function getEquippedToolDef(char, loadedData, toolTag) {
    const { idx } = loadedData;
    const uidTool = char.equipment.mainHand;
    if (!uidTool) return null;
    const inst = char.pockets.instances.find(i => i.uid === uidTool);
    if (!inst) return null;
    const def = idx.itemsById.get(inst.itemId);
    if (!def?.tool) return null;
    if (toolTag && def.tool.tag !== toolTag) return null;
    return { def, inst };
  }

  function getTotalProtection(char, loadedData) {
    const { idx } = loadedData;
    let p = 0;
    for (const slot of ["body", "legs"]) {
      const u = char.equipment[slot];
      if (!u) continue;
      const inst = char.pockets.instances.find(i => i.uid === u);
      if (!inst) continue;
      const def = idx.itemsById.get(inst.itemId);
      if (def?.armor?.protection) p += def.armor.protection;
    }
    return clamp(p, 0, 0.7);
  }

  /* =========================
     Log
  ========================= */
  function pushLog(state, text, type = "info", actorId = null, loadedData = null) {
    const max = loadedData?.data?.config?.maxLogEntries ?? 600;
    state.log.push({ ts: gameNow(state), text, type, actorId });
    if (state.log.length > max) state.log.splice(0, state.log.length - max);
  }

  /* =========================
     Time
  ========================= */
  function gameNow(state) {
    return nowReal() + (state.meta.timeOffsetMs || 0);
  }

  function resetSimTimeToReal(state) {
    state.meta.timeOffsetMs = 0;
  }

  function addSimTime(state, ms) {
    state.meta.timeOffsetMs = (state.meta.timeOffsetMs || 0) + ms;
  }

  function isNight(state, loadedData, lat = null, lon = null) {
    const cfg = loadedData.data.config.dayNight;
    const useSim = !!state.meta.useSimTimeForDayNight;
    const t = useSim ? gameNow(state) : nowReal();
    const d = new Date(t);
    const h = d.getHours();
    return (h < cfg.dayStartHour || h >= cfg.nightStartHour);
  }

  /* =========================
     Needs, Moodlets, Conditions
  ========================= */
  function applyContinuousDrains(state, loadedData, elapsedMs) {
    const { data } = loadedData;
    const mins = elapsedMs / 60000;
    if (mins <= 0) return;

    for (const c of state.crew.members) {
      if (c.conditions.downed) continue;

      // Base drain
      c.needs.hunger = clamp(c.needs.hunger - data.config.drains.hungerPerMin * mins, 0, 100);
      c.needs.thirst = clamp(c.needs.thirst - data.config.drains.thirstPerMin * mins, 0, 100);

      // If resting idle and not busy, mild morale recovery
      const q = state.queues.jobsByCharId[c.id] || [];
      const active = q[0] || null;
      const isIdleRest = (!active && c.idleBehavior === "rest");
      if (isIdleRest) {
        c.needs.morale = clamp(c.needs.morale + data.config.drains.moraleRecoverPerMinRest * mins, 0, 100);
      }

      // Update moodlets/sickness/injury expirations
      expireTimedEffects(state, loadedData, c);
    }
  }

  function expireTimedEffects(state, loadedData, char) {
    const t = gameNow(state);

    // moodlets
    char.moodlets = (char.moodlets || []).filter(m => m.endsAt > t);

    // sickness
    if (char.conditions.sickness && char.conditions.sickness.endsAt <= t) {
      pushLog(state, `${char.name} recovered from sickness.`, "good", char.id, loadedData);
      char.conditions.sickness = null;
    }

    // injury
    if (char.conditions.injury && char.conditions.injury.endsAt <= t) {
      pushLog(state, `${char.name} recovered from injury.`, "good", char.id, loadedData);
      char.conditions.injury = null;
    }

    // if downed: remains until revived
  }

  function applyMoodlet(char, moodlet) {
    // moodlet: { id, name, endsAt, moraleDelta, note }
    char.moodlets = char.moodlets || [];
    // Replace same id
    char.moodlets = char.moodlets.filter(m => m.id !== moodlet.id);
    char.moodlets.push(moodlet);
  }

  function currentMoraleModifier(char) {
    let d = 0;
    for (const m of (char.moodlets || [])) d += (m.moraleDelta || 0);
    if (char.conditions.sickness) d -= 10;
    if (char.conditions.injury?.severity === "minor") d -= 5;
    if (char.conditions.injury?.severity === "major") d -= 15;
    if (char.conditions.downed) d -= 50;
    return d;
  }

  function effectiveSkill(char, skillId) {
    const base = char.stats[skillId] ?? 0;
    // Small bonus from XP: every 100 xp -> +1
    const xp = char.xp[skillId] ?? 0;
    const bonus = Math.floor(xp / 100);
    return base + bonus;
  }

  /* =========================
     XP + Leveling (v0.2)
  ========================= */

  function xpToNext(level, base = 100, growth = 1.35) {
    // Level starts at 0 (untrained) or 1+; this function accepts current level and returns XP needed to gain +1.
    // A gentle curve that still makes early progress visible.
    const lv = Math.max(0, Number(level) || 0);
    return Math.round(base * Math.pow(growth, lv));
  }

  function processLevelUps(state, loadedData, char) {
    const cfg = loadedData?.data?.config || {};
    const base = cfg?.xp?.base ?? 100;
    const growth = cfg?.xp?.growth ?? 1.35;

    const leveled = [];
    for (const skill of Object.keys(char.xp || {})) {
      // ensure stat exists
      if (char.stats[skill] == null) char.stats[skill] = 0;

      let xp = char.xp[skill] || 0;
      let needed = xpToNext(char.stats[skill], base, growth);
      let ups = 0;

      while (xp >= needed && ups < 25) {
        xp -= needed;
        char.stats[skill] = (char.stats[skill] || 0) + 1;
        ups++;
        needed = xpToNext(char.stats[skill], base, growth);
      }

      if (ups > 0) {
        char.xp[skill] = xp;
        leveled.push({ skill, ups });
      }
    }

    if (leveled.length) {
      for (const it of leveled) {
        pushLog(state, `${char.name} leveled up: ${it.skill} +${it.ups}.`, "good", char.id, loadedData);
      }
      toast(`${char.name} leveled up!`);
    }

    return leveled;
  }

  function xpProgressLine(state, loadedData, char, skill) {
    const cfg = loadedData?.data?.config || {};
    const base = cfg?.xp?.base ?? 100;
    const growth = cfg?.xp?.growth ?? 1.35;

    const level = char.stats?.[skill] ?? 0;
    const xp = char.xp?.[skill] ?? 0;
    const need = xpToNext(level, base, growth);
    return `${skill}: L${level} — ${xp}/${need} XP`;
  }


  /* =========================
     Auto-consume (rations)
  ========================= */
  function maybeAutoConsume(state, loadedData, char) {
    const cfg = loadedData.data.config;
    if (char.conditions.downed) return;

    // Auto drink
    if (char.needs.thirst <= cfg.autoConsumeThreshold) {
      const drank = consumeBestWater(state, loadedData, char);
      if (!drank) {
        applyMoodlet(char, { id: "m_parched", name: "Parched", endsAt: gameNow(state) + 60 * 60 * 1000, moraleDelta: -8, note: "No water available." });
      }
    }

    // Auto eat (rations only)
    if (char.needs.hunger <= cfg.autoConsumeThreshold) {
      const ate = consumeRationFood(state, loadedData, char);
      if (!ate) {
        applyMoodlet(char, { id: "m_hungry", name: "Hungry", endsAt: gameNow(state) + 60 * 60 * 1000, moraleDelta: -10, note: "No rations available." });
      }
    }
  }

  function consumeBestWater(state, loadedData, char) {
    const { idx } = loadedData;
    // Prefer clean over dirty
    const options = ["water_clean", "water_dirty"].filter(id => hasItemInStorage(state, loadedData, id, 1));
    if (options.length === 0) return false;

    const pick = options[0];
    removeItemFromStorage(state, loadedData, pick, 1);
    const def = idx.itemsById.get(pick);
    const thirst = def?.water?.thirst ?? 10;
    char.needs.thirst = clamp(char.needs.thirst + thirst, 0, 100);

    // Dirty water sickness chance
    if (def?.water?.dirty) {
      // chance depends on grit & medical
      const grit = effectiveSkill(char, "Grit");
      const med = effectiveSkill(char, "Medical");
      const chance = clamp(0.18 - (grit * 0.01) - (med * 0.01), 0.04, 0.25);
      if (Math.random() < chance) {
        applySickness(state, loadedData, char, "Dirty Water Sickness", 3 * 60 * 60 * 1000);
      }
      applyMoodlet(char, { id: "m_grosswater", name: "Ugh. Dirty Water.", endsAt: gameNow(state) + 30 * 60 * 1000, moraleDelta: -3, note: "You drank questionable water." });
    }

    pushLog(state, `${char.name} drank water.`, "info", char.id, loadedData);
    return true;
  }

  function consumeRationFood(state, loadedData, char) {
    const { idx } = loadedData;
    // Find ration-allowed foods in storage
    const stacks = state.rv.storage.stacks
      .filter(s => s.qty > 0)
      .map(s => ({ s, def: idx.itemsById.get(s.itemId) }))
      .filter(x => x.def && x.def.category === "food" && x.s.isRationAllowed);

    if (stacks.length === 0) return false;

    // Eat the "worst" first (low-tier rations) to preserve fancy stuff if it accidentally is ration-allowed
    stacks.sort((a, b) => {
      const qa = a.def.food?.quality || "low";
      const qb = b.def.food?.quality || "low";
      const order = { low: 0, mid: 1, high: 2 };
      return (order[qa] ?? 0) - (order[qb] ?? 0);
    });

    const pick = stacks[0].s.itemId;
    const def = idx.itemsById.get(pick);

    removeItemFromStorage(state, loadedData, pick, 1);

    const hunger = def?.food?.hunger ?? 10;
    char.needs.hunger = clamp(char.needs.hunger + hunger, 0, 100);

    // Food morale effect
    const morale = def?.food?.morale ?? 0;
    char.needs.morale = clamp(char.needs.morale + morale, 0, 100);

    // Apply moodlets for quality
    const q = def?.food?.quality || "low";
    if (q === "low") applyMoodlet(char, { id: "m_slop", name: "Ate Slop", endsAt: gameNow(state) + 2 * 60 * 60 * 1000, moraleDelta: -6, note: "Barely edible." });
    if (q === "high") applyMoodlet(char, { id: "m_hearty", name: "Hearty Meal", endsAt: gameNow(state) + 4 * 60 * 60 * 1000, moraleDelta: +10, note: "Actually delicious." });

    // Raw food sickness chance
    if (def?.food?.raw) {
      const grit = effectiveSkill(char, "Grit");
      const chance = clamp(0.25 - (grit * 0.01), 0.06, 0.28);
      if (Math.random() < chance) {
        applySickness(state, loadedData, char, "Food Poisoning", 2 * 60 * 60 * 1000);
      }
    }

    pushLog(state, `${char.name} ate rations.`, "info", char.id, loadedData);
    return true;
  }

  function consumeFoodFromStorage(state, loadedData, char, itemId) {
    const { idx } = loadedData;
    if (!hasItemInStorage(state, loadedData, itemId, 1)) return { ok: false, reason: "not in storage" };
    const def = idx.itemsById.get(itemId);
    if (!def?.food) return { ok: false, reason: "not food" };

    removeItemFromStorage(state, loadedData, itemId, 1);

    const hunger = def.food.hunger ?? 10;
    char.needs.hunger = clamp(char.needs.hunger + hunger, 0, 100);

    const morale = def.food.morale ?? 0;
    char.needs.morale = clamp(char.needs.morale + morale, 0, 100);

    const q = def.food.quality || "low";
    if (q === "low") applyMoodlet(char, { id: "m_slop", name: "Ate Slop", endsAt: gameNow(state) + 2 * 60 * 60 * 1000, moraleDelta: -2, note: "Not your finest meal." });
    if (q === "mid") applyMoodlet(char, { id: "m_full", name: "Ate Okay", endsAt: gameNow(state) + 2 * 60 * 60 * 1000, moraleDelta: 0, note: "Good enough." });
    if (q === "high") applyMoodlet(char, { id: "m_tasty", name: "Ate Well", endsAt: gameNow(state) + 3 * 60 * 60 * 1000, moraleDelta: +2, note: "Actually delicious." });

    // Raw food sickness chance
    if (def.food.raw) {
      const grit = effectiveSkill(char, "Grit");
      const chance = clamp(0.25 - (grit * 0.01), 0.06, 0.28);
      if (Math.random() < chance) {
        applySickness(state, loadedData, char, "Food Poisoning", 2 * 60 * 60 * 1000);
      }
    }

    pushLog(state, `${char.name} ate ${def.name}.`, "info", char.id, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function consumeWaterFromStorage(state, loadedData, char, itemId) {
    const { idx } = loadedData;
    if (!hasItemInStorage(state, loadedData, itemId, 1)) return { ok: false, reason: "not in storage" };
    const def = idx.itemsById.get(itemId);
    if (!def?.water) return { ok: false, reason: "not water" };

    removeItemFromStorage(state, loadedData, itemId, 1);

    const thirst = def.water.thirst ?? 10;
    char.needs.thirst = clamp(char.needs.thirst + thirst, 0, 100);

    // Dirty water sickness chance
    if (def.water.dirty) {
      const grit = effectiveSkill(char, "Grit");
      const med = effectiveSkill(char, "Medical");
      const chance = clamp(0.18 - (grit * 0.01) - (med * 0.01), 0.04, 0.25);
      if (Math.random() < chance) {
        applySickness(state, loadedData, char, "Dirty Water Sickness", 3 * 60 * 60 * 1000);
      }
      applyMoodlet(char, { id: "m_grosswater", name: "Ugh. Dirty Water", endsAt: gameNow(state) + 30 * 60 * 1000, moraleDelta: -3, note: "You can taste the pond." });
    }

    pushLog(state, `${char.name} drank ${def.name}.`, "info", char.id, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }


  function applySickness(state, loadedData, char, name, durationMs) {
    const t = gameNow(state);
    char.conditions.sickness = { id: `s_${hashStringToUint(name)}`, name, endsAt: t + durationMs, severity: "normal" };
    pushLog(state, `${char.name} got sick: ${name}.`, "bad", char.id, loadedData);
  }

  function applyInjury(state, loadedData, char, severity, name, durationMs) {
    const t = gameNow(state);
    char.conditions.injury = { id: `i_${hashStringToUint(name)}`, name, endsAt: t + durationMs, severity };
    pushLog(state, `${char.name} suffered a ${severity} injury: ${name}.`, "bad", char.id, loadedData);
  }

  function downCharacter(state, loadedData, char) {
    char.conditions.downed = true;
    pushLog(state, `${char.name} is DOWNED!`, "bad", char.id, loadedData);

    // Auto-revive if serum available
    if (hasItemInStorage(state, loadedData, "revive_serum", 1)) {
      removeItemFromStorage(state, loadedData, "revive_serum", 1);
      char.conditions.downed = false;
      applyMoodlet(char, { id: "m_revived", name: "Revived", endsAt: gameNow(state) + 6 * 60 * 60 * 1000, moraleDelta: -12, note: "You cheated death. It feels weird." });
      char.needs.health = 60;
      pushLog(state, `Crew used a Revive Serum on ${char.name}.`, "good", char.id, loadedData);
    }
  }

  /* =========================
     Tile Generation
  ========================= */
  function getOrCreateTile(state, loadedData, tileId) {
    const { data } = loadedData;

    if (!state.world.discoveredTiles[tileId]) {
      const neighbors = geohashNeighbors(tileId);
      const neighborBiomes = [];
      for (const k of ["n","s","e","w"]) {
        const nt = neighbors[k];
        if (state.world.discoveredTiles[nt]?.biomeId) neighborBiomes.push(state.world.discoveredTiles[nt].biomeId);
      }

      const seed = hashStringToUint(`${data.config.worldSeed}::${tileId}`);
      const rng = mulberry32(seed);

      // Weighted + neighbor influence:
      const baseWeights = data.biomes.map(b => ({ id: b.id, w: b.weight || 1 }));
      const influence = new Map();
      for (const bio of neighborBiomes) {
        influence.set(bio, (influence.get(bio) || 0) + 12);
      }

      const picks = baseWeights.map(e => {
        const extra = influence.get(e.id) || 0;
        // also add some "related" biome soft influence by tags (MVP-lite)
        let tagExtra = 0;
        if (neighborBiomes.length > 0) {
          const nb = data.biomes.find(x => x.id === neighborBiomes[0]);
          const me = data.biomes.find(x => x.id === e.id);
          if (nb && me) {
            const shared = me.tags?.filter(t => (nb.tags || []).includes(t)).length || 0;
            tagExtra = shared * 3;
          }
        }
        return { id: e.id, w: e.w + extra + tagExtra };
      });

      const biomeId = weightedPick(rng, picks);

      // Map tuning (v0.4): lightweight tile data
      const mapCfg = data.maps || FALLBACK_DATA.maps || {};
      const bioCfg = (mapCfg.biomes && mapCfg.biomes[biomeId]) ? mapCfg.biomes[biomeId] : {};
      const danger = Number.isFinite(bioCfg.danger) ? bioCfg.danger : (Number.isFinite(mapCfg?.defaults?.danger) ? mapCfg.defaults.danger : 1);
      const travelTimeMod = Number.isFinite(bioCfg.travelTimeMod) ? bioCfg.travelTimeMod : (Number.isFinite(mapCfg?.defaults?.travelTimeMod) ? mapCfg.defaults.travelTimeMod : 1.0);
      const gxy = geohashToGridCoords(tileId);

      // POIs are MVP-light: store empty for now, expand later via biomes.json
      const tile = {
        tileId,
        biomeId,
        createdAt: gameNow(state),
        gridX: gxy.x,
        gridY: gxy.y,
        danger,
        travelTimeMod,
        discovered: true,
        poiIds: [],
        tutorialOverlay: false,
        encounter: null // e.g., recruit NPC
      };

      state.world.discoveredTiles[tileId] = tile;
    }

    // Tutorial overlay on first tile
    if (!state.meta.tutorialDone) {
      state.meta.firstTileId = state.meta.firstTileId || tileId;
      if (tileId === state.meta.firstTileId) {
        const tile = state.world.discoveredTiles[tileId];
        if (!tile.tutorialOverlay) {
          tile.tutorialOverlay = true;
          tile.encounter = {
            type: "recruitNpc",
            npcTemplateId: "npc_scavenger",
            // Tutorial recruit is free but can optionally ask for one ration
            requirement: { itemId: "ration_basic", qty: 1, optional: true }
          };
          pushLog(state, "Tutorial overlay activated on your current tile.", "system", null, loadedData);
        }
      }
    }

    return state.world.discoveredTiles[tileId];
  }

  function biomeForTile(loadedData, tile) {
    return loadedData.data.biomes.find(b => b.id === tile.biomeId) || loadedData.data.biomes[0];
  }

  /* =========================
     Jobs
  ========================= */
  function listAvailableJobsForTile(state, loadedData, tile) {
    const { data } = loadedData;
    const biome = biomeForTile(loadedData, tile);
    const biomeId = biome?.id;

    const jobs = [];
    for (const j of (data.jobs || [])) {
      // Back-compat: older job schemas may use "biomes" (biome IDs) instead of "biomeTags".
      const hasGate =
        !!j.alwaysAvailable ||
        (Array.isArray(j.biomeTags) && j.biomeTags.length) ||
        (Array.isArray(j.biomes) && j.biomes.length) ||
        (Array.isArray(j.biomeIds) && j.biomeIds.length);

      const ok =
        !!j.alwaysAvailable ||
        (Array.isArray(j.biomeTags) && j.biomeTags.some(t => (biome.tags || []).includes(t))) ||
        (Array.isArray(j.biomes) && biomeId && j.biomes.includes(biomeId)) ||
        (Array.isArray(j.biomeIds) && biomeId && j.biomeIds.includes(biomeId)) ||
        // If job has no gating fields at all, treat it as available (v0.1 behavior).
        !hasGate;

      if (ok) jobs.push(j);
    }
    return jobs;
  }

  function paceMultipliers(pace) {
    // pace influences duration, yield, and risk
    if (pace === "safe") return { dur: 1.1, yield: 0.9, risk: 0.75 };
    if (pace === "push") return { dur: 0.85, yield: 1.15, risk: 1.35 };
    return { dur: 1.0, yield: 1.0, risk: 1.0 };
  }

  function startJobForChar(state, loadedData, charId, jobId, pace = "normal", opts = null) {
    opts = opts || {};
    const { idx } = loadedData;
    const char = state.crew.members.find(m => m.id === charId);
    if (!char) return { ok: false, reason: "bad char" };
    if (char.conditions.downed) return { ok: false, reason: "downed" };

    const job = idx.jobsById.get(jobId);
    if (!job) return { ok: false, reason: "bad job" };

    // Requirements: tool tag or item in storage for trap
    if (job.requiresItem && !hasItemInStorage(state, loadedData, job.requiresItem, 1)) {
      return { ok: false, reason: `Requires item: ${job.requiresItem}` };
    }

    // Tool check: job.toolTag should be equipped in main hand OR we allow "unarmed" penalty
    let toolOk = true;
    if (job.toolTag) {
      const tool = getEquippedToolDef(char, loadedData, job.toolTag);
      toolOk = !!tool;
    }

    const mult = paceMultipliers(pace);
    const baseDurationMs = Math.round((job.baseSec || 600) * mult.dur) * 1000;
    const durationMs = (opts.durationMs != null) ? Math.max(1000, Math.round(opts.durationMs)) : baseDurationMs;

    const entry = {
      id: uid("job"),
      jobId,
      pace,
      createdAt: gameNow(state),
      startAt: null,
      durationMs,
      toolOk,
      tileId: (opts.tileId != null ? opts.tileId : state.meta.lastTileId),
      meta: opts.meta || null,
      completed: false
    };

    state.queues.jobsByCharId[charId] = state.queues.jobsByCharId[charId] || [];

    // If no active job, start immediately
    const q = state.queues.jobsByCharId[charId];
    if (q.length === 0) {
      entry.startAt = gameNow(state);
    }
    q.push(entry);

    pushLog(state, `${char.name} queued: ${job.name} (${pace}).`, "info", char.id, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function cancelQueuedJob(state, loadedData, charId, jobEntryId) {
    const q = state.queues.jobsByCharId[charId] || [];
    const idx = q.findIndex(j => j.id === jobEntryId);
    if (idx < 0) return { ok: false, reason: "not found" };

    const [removed] = q.splice(idx, 1);

    // If we cancelled the currently running job (idx === 0), allow the next one to start immediately
    if (idx === 0 && q[0] && q[0].startAt == null) q[0].startAt = gameNow(state);

    // Restore reserved rations for exploration if the task was cancelled
    const char = state.crew.members.find(m => m.id === charId);
    if (char && removed?.meta?.rationsConsumed?.length) {
      for (const rc of removed.meta.rationsConsumed) {
        addItemToPockets(state, loadedData, char, rc.itemId, rc.qty || 1);
      }
      removed.meta.rationsConsumed = [];
    }

    const name = loadedData.idx.jobsById.get(removed.jobId)?.name ?? removed.jobId;
    pushLog(state, `Cancelled ${name} for ${char?.name ?? "crew"}.`, "info", charId, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function clearJobQueue(state, loadedData, charId) {
    const q = state.queues.jobsByCharId[charId] || [];
    if (!q.length) return { ok: false, reason: "empty" };
    state.queues.jobsByCharId[charId] = [];
    pushLog(state, `Cleared job queue for ${state.crew.members.find(m => m.id === charId)?.name ?? "crew"}.`, "info", charId, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }


  function tickJobQueues(state, loadedData) {
    const { idx, data } = loadedData;
    const t = gameNow(state);

    // Ensure idle behavior doesn't explode: only loop up to N cycles per sim tick
    let idleCycles = 0;

    for (const char of state.crew.members) {
      if (char.conditions.downed) continue;

      let q = state.queues.jobsByCharId[char.id] || [];
      if (q.length === 0) {
        // Schedule idle behavior
        if (char.idleBehavior && char.idleBehavior !== "none") {
          if (char.idleBehavior === "rest") {
            // no job needed
          } else if (idleCycles < data.config.idleMaxCyclesPerSim) {
            // Add a single idle job if none queued
            startJobForChar(state, loadedData, char.id, char.idleBehavior, "safe");
            idleCycles++;
            q = state.queues.jobsByCharId[char.id] || [];
          }
        }
      }

      // If there is a queue and first entry has no startAt, start it
      if (q.length > 0 && q[0].startAt == null) q[0].startAt = t;

      // Complete jobs that finished
      while (q.length > 0) {
        const jEntry = q[0];
        if (jEntry.startAt == null) break;
        const endsAt = jEntry.startAt + jEntry.durationMs;
        if (endsAt > t) break;

        // Complete
        const job = idx.jobsById.get(jEntry.jobId);
        try {
          resolveJobCompletion(state, loadedData, char, job, jEntry);
        } catch (e) {
          console.error(e);
          pushLog(state, `ERROR: Job completion failed for ${char.name} (${job?.name ?? jEntry.jobId}). See console.`, "warn", char.id, loadedData);
        }

        q.shift();

        // Start next immediately if exists
        if (q.length > 0) q[0].startAt = endsAt;

        safetySnapshot(state, loadedData);
      }
    }
  }

  function resolveJobCompletion(state, loadedData, char, job, jEntry) {
    const { idx, data } = loadedData;

    const charId = char.id;

    // Ensure we have a valid current tile for biome/yields and seeded RNG.
    // (The game remains playable even if the player never granted location permission.)
    const prec = data.config.tilePrecision || 7;
    const tileId = state.meta.lastTileId || geohashEncode(0, 0, prec);
    if (!state.meta.lastTileId) state.meta.lastTileId = tileId;
    const tile = getOrCreateTile(state, loadedData, tileId);

    // Track items gained during this job (used for logging + morale)
    const got = [];
    // Deterministic-ish RNG seed: use sim time if available, otherwise fall back to real time.
    const __seedTime = Math.floor(((state.meta.lastSimAt || gameNow(state)) || nowReal()) / 1000);
    const rng = mulberry32(hashStringToUint(`${state.rngSeed}|${__seedTime}|${jEntry.id}`));

    // Needs drain boost for strenuous jobs
    const strain = job.strenuous ? data.config.jobStrenuousDrainMultiplier : 1.0;

    // Apply per-job drains (MVP)
    const mins = jEntry.durationMs / 60000;
    char.needs.hunger = clamp(char.needs.hunger - (data.config.drains.hungerPerMin * mins * (strain - 0.2)), 0, 100);
    char.needs.thirst = clamp(char.needs.thirst - (data.config.drains.thirstPerMin * mins * (strain - 0.2)), 0, 100);

    // Auto-consume if needed
    maybeAutoConsume(state, loadedData, char);

    // Compute success/yield/risk adjustments
    const mult = paceMultipliers(jEntry.pace);

    const skill = effectiveSkill(char, job.xpSkill || "Wilderness");
    const moraleMod = currentMoraleModifier(char);
    const moralePenalty = moraleMod < 0 ? Math.abs(moraleMod) * 0.002 : 0;

    // Tool & armor impact
    const toolInfo = job.toolTag ? getEquippedToolDef(char, loadedData, job.toolTag) : null;
    const toolTier = toolInfo?.def?.tool?.tier ?? (jEntry.toolOk ? 1 : 0);
    const toolPower = toolInfo?.def?.tool?.power ?? 0;
    const protection = getTotalProtection(char, loadedData);

    // Final yield multiplier
    const yieldMult =
      mult.yield *
      (1 + skill * 0.04) *
      (1 + toolTier * 0.05) *
      (1 - moralePenalty);

    // Risk multiplier
    const riskMult =
      mult.risk *
      (1 - protection * 0.6) *
      (1 - toolTier * 0.06) *
      (1 + (char.conditions.sickness ? 0.2 : 0)) *
      (1 + (char.conditions.injury?.severity === "minor" ? 0.15 : 0)) *
      (1 + (char.conditions.injury?.severity === "major" ? 0.35 : 0));

    // Roll yields
    // v0.2 special jobs
    if (jEntry.meta?.special === "gather_water") {
      const waterId = jEntry.meta.waterItemId || "water_dirty";
      const qty = Math.max(0, Math.floor(Number(jEntry.meta.waterQty || 0)));
      if (qty > 0) {
        const ok = addItemToStorage(state, loadedData, waterId, qty);
        if (ok.ok) pushLog(state, `${char.name} gathered ${qty}× ${(loadedData.idx.itemsById.get(waterId)?.name ?? waterId)}.`, "good", charId, loadedData);
        else pushLog(state, `Storage full — couldn't store gathered water.`, "warn", charId, loadedData);
      }
    } else if (jEntry.meta?.special === "explore") {
      const actionJobId = jEntry.meta.actionJobId;
      const actionJob = actionJobId ? loadedData.idx.jobsById.get(actionJobId) : null;

      const toolTier = getToolTierForJob(state, loadedData, char, actionJob || job);
      const wild = effectiveSkill(char, "Wilderness");
      const wits = effectiveSkill(char, "Wits");
      const grit = effectiveSkill(char, "Grit");

      const successChance = clamp(0.55 + (wild * 0.02) + (wits * 0.01) + (toolTier * 0.04), 0.25, 0.95);
      const success = (rng() < successChance);

      if (success && actionJob?.yields?.length) {
        const biome = loadedData.idx.biomesById.get(tile.biomeId);
        const yieldMult = clamp(1 + (toolTier * 0.15) + (wild * 0.02), 0.5, 3.5) * (1.10 + grit * 0.01);

        for (const y of actionJob.yields) {
          if ((y.chance ?? 1) < 1 && rng() > y.chance) continue;
          let qty = randInt(rng, y.min ?? 1, y.max ?? (y.min ?? 1));
          if (biome?.yieldMult?.[y.id]) qty = Math.ceil(qty * biome.yieldMult[y.id]);
          qty = Math.max(0, Math.floor(qty * yieldMult));
          if (qty > 0) {
            const ok = addItemToStorage(state, loadedData, y.id, qty);
            if (!ok.ok) { pushLog(state, "Storage full — exploration loot was lost.", "warn", charId, loadedData); break; }
          }
        }
        pushLog(state, `${char.name} explored and returned with loot.`, "good", charId, loadedData);
      } else {
        pushLog(state, `${char.name} explored but found nothing useful.`, "info", charId, loadedData);
      }

      // extra injury chance when exploring
      const extra = clamp(0.10 - (grit * 0.01), 0.02, 0.12);
      if (rng() < extra) applyInjury(state, loadedData, char, "minor");
    } else {
      const biome = loadedData.idx.biomesById.get(tile.biomeId);

      // Determine tool tier from equipment (if job wants it)
      const toolTier = getToolTierForJob(state, loadedData, char, job);

      // Yield multiplier based on skill and tool
      const skill = job.xpSkill ? effectiveSkill(char, job.xpSkill) : 0;
      const yieldMult = clamp(1 + (toolTier * 0.15) + (skill * 0.02), 0.5, 3.5);

      const yields = job.yields || [];
      // got[] is declared above so it can be used for all job types

      for (const y of yields) {
        if ((y.chance ?? 1) < 1 && rng() > y.chance) continue;
        let qty = randInt(rng, y.min ?? 1, y.max ?? (y.min ?? 1));
        if (biome?.yieldMult?.[y.id]) qty = Math.ceil(qty * biome.yieldMult[y.id]);
        qty = Math.max(0, Math.floor(qty * yieldMult));
        if (qty > 0) {
          const ok = addItemToStorage(state, loadedData, y.id, qty);
          if (ok.ok) got.push(`${qty}× ${loadedData.idx.itemsById.get(y.id)?.name ?? y.id}`);
          else { pushLog(state, "Storage full — couldn't store yields.", "warn", charId, loadedData); break; }
        }
      }

      if (got.length) pushLog(state, `${char.name} gained: ${got.join(", ")}.`, "good", charId, loadedData);
    }

    // Risk outcomes
    const r = job.risk || { minorInjury: 0, majorInjury: 0, toolWear: 0, sickness: 0 };
    const minorChance = clamp((r.minorInjury || 0) * riskMult, 0, 0.6);
    const majorChance = clamp((r.majorInjury || 0) * riskMult, 0, 0.35);
    const sickChance = clamp((r.sickness || 0) * riskMult, 0, 0.35);
    const wearChance = clamp((r.toolWear || 0) * riskMult, 0, 0.95);

    if (!char.conditions.injury && rng() < majorChance) {
      applyInjury(state, loadedData, char, "major", "Broken Leg", 8 * 60 * 60 * 1000);
    } else if (!char.conditions.injury && rng() < minorChance) {
      applyInjury(state, loadedData, char, "minor", "Sprained Ankle", 2 * 60 * 60 * 1000);
    }

    if (!char.conditions.sickness && rng() < sickChance) {
      applySickness(state, loadedData, char, "Ruin Dust Fever", 3 * 60 * 60 * 1000);
    }

    // Tool wear & break
    if (toolInfo && rng() < wearChance) {
      const inst = toolInfo.inst;
      const wear = Math.max(1, Math.round((2 + toolPower) * mult.risk));
      inst.durability = Math.max(0, (inst.durability ?? 0) - wear);
      if (inst.durability <= 0) {
        pushLog(state, `${char.name}'s ${toolInfo.def.name} broke!`, "bad", char.id, loadedData);
        // Broken tool stays equipped but with 0 durability (MVP); repairs later can restore
        applyMoodlet(char, { id: "m_brokentool", name: "Broken Gear", endsAt: gameNow(state) + 60 * 60 * 1000, moraleDelta: -6, note: "Your tool fell apart." });
      }
    }

    // XP
    if (job.xpSkill) {
      const xpGain = Math.round(10 + mins * 2 + (toolTier * 2));
      char.xp[job.xpSkill] = (char.xp[job.xpSkill] || 0) + xpGain;
      pushLog(state, `${char.name} gained ${xpGain} XP in ${job.xpSkill}.`, "info", char.id, loadedData);
      processLevelUps(state, loadedData, char);
    }

    // Morale adjustments from outcomes
    if (got.length > 0) char.needs.morale = clamp(char.needs.morale + 1, 0, 100);

    // Death/downed check (MVP): if health is too low due to compounded penalties
    // We don't track detailed combat; downed can occur if major injury + starving + unlucky.
    const dangerScore = (char.needs.hunger < 10 ? 1 : 0) + (char.needs.thirst < 10 ? 1 : 0) + (char.conditions.injury?.severity === "major" ? 2 : 0) + (char.conditions.sickness ? 1 : 0);
    if (!char.conditions.downed && dangerScore >= 4 && rng() < 0.15) {
      downCharacter(state, loadedData, char);
    }

    // Log completion summary
    const gainedText = got.length ? got.map(g => `${g.qty}× ${idx.itemsById.get(g.id)?.name ?? g.id}`).join(", ") : "nothing";
    pushLog(state, `${char.name} finished ${job.name}: got ${gainedText}.`, "good", char.id, loadedData);

    // Tutorial completion check
    if (!state.meta.tutorialDone) {
      // If they crafted spear or trap or hatchet, they’ve basically learned
      const hasSpear = char.pockets.instances.some(i => i.itemId === "spear_fishing") || hasItemInStorage(state, loadedData, "spear_fishing", 1);
      const hasTrap = char.pockets.instances.some(i => i.itemId === "trap_simple") || hasItemInStorage(state, loadedData, "trap_simple", 1);
      const hasHatchet = char.pockets.instances.some(i => i.itemId === "hatchet_stone") || hasItemInStorage(state, loadedData, "hatchet_stone", 1);
      if (hasSpear && hasTrap && hasHatchet) {
        state.meta.tutorialDone = true;
        pushLog(state, "Tutorial complete. You're on your own now (mostly).", "system", null, loadedData);
      }
    }
  }

  /* =========================
     Crafting
  ========================= */

  // Returns an integer tool tier (0 = no appropriate tool equipped).
  // Used by job completion/scouting to scale yields/success.
  function getToolTierForJob(state, loadedData, char, jobOrDef) {
    const job = jobOrDef || null;
    const toolTag = (typeof job === "string") ? job : (job && job.toolTag ? job.toolTag : null);
    if (!toolTag) return 0;
    const toolInfo = getEquippedToolDef(char, loadedData, toolTag);
    const tier = toolInfo?.def?.tool?.tier;
    return (typeof tier === "number" && isFinite(tier)) ? Math.max(0, Math.floor(tier)) : 0;
  }

  function canCraftRecipe(state, loadedData, recipe) {
    const { idx } = loadedData;

    // Station installed and level sufficient
    const stationLevel = getStationLevel(state, recipe.station);
    if (stationLevel < (recipe.stationLevel || 0)) return { ok: false, reason: `Requires ${recipe.station} level ${recipe.stationLevel}` };

    // Inputs present
    for (const inp of (recipe.inputs || [])) {
      if (!hasItemInAreaStorages(state, loadedData, inp.id, inp.qty)) {
        const name = idx.itemsById.get(inp.id)?.name ?? inp.id;
        return { ok: false, reason: `Missing: ${name}` };
      }
    }

    // Capacity check (rough)
    // We remove inputs at start, so capacity shouldn't be a blocker unless outputs exceed.
    return { ok: true };
  }

  function getStationLevel(state, stationId) {
    // Some stations represent modules with levels; others are “capabilities”
    // For MVP we treat stationId matching stations list: rv.stations[stationId]
    return state.rv.stations[stationId] ?? 0;
  }

  function startCraft(state, loadedData, recipeId) {
    const { idx } = loadedData;
    const recipe = idx.recipesById.get(recipeId);
    if (!recipe) return { ok: false, reason: "bad recipe" };

    const can = canCraftRecipe(state, loadedData, recipe);
    if (!can.ok) return can;

    // Remove inputs immediately
    for (const inp of (recipe.inputs || [])) {
      removeItemFromAreaStorages(state, loadedData, inp.id, inp.qty);
    }

    const entry = {
      id: uid("craft"),
      recipeId,
      createdAt: gameNow(state),
      startAt: null,
      durationMs: (recipe.timeSec || 60) * 1000,
      completed: false,
      // Store a copy of consumed inputs so we can refund if the player removes this craft from the queue.
      inputs: (recipe.inputs || []).map(i => ({ id: i.id, qty: i.qty }))
    };

    const q = state.queues.craftsByStationId[recipe.station] || (state.queues.craftsByStationId[recipe.station] = []);
    if (q.length === 0) entry.startAt = gameNow(state);
    q.push(entry);

    pushLog(state, `Crafting started: ${recipe.name}.`, "info", null, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  
  function cancelCraftEntry(state, loadedData, stationId, entryId) {
    const { idx } = loadedData;
    const q = state.queues.craftsByStationId?.[stationId];
    if (!q || q.length === 0) return { ok: false, reason: "Queue is empty." };

    const i = q.findIndex(e => e.id === entryId);
    if (i < 0) return { ok: false, reason: "Craft entry not found." };

    const entry = q[i];
    const recipe = idx.recipesById.get(entry.recipeId);

    // Refund inputs (best-effort). Inputs were consumed at enqueue time in startCraft().
    const inputs = entry.inputs || recipe?.inputs || [];
    for (const inp of inputs) {
      if (!inp?.id || !inp?.qty) continue;
      const res = addItemToStorage(state, loadedData, inp.id, inp.qty);
      if (!res?.ok) {
        pushLog(
          state,
          `Storage full — couldn't refund ${inp.qty}× ${(idx.itemsById.get(inp.id)?.name ?? inp.id)}.`,
          "warn",
          null,
          loadedData
        );
      }
    }

    // Remove the entry
    q.splice(i, 1);

    // If we removed the currently-active craft, start the next one immediately.
    if (i === 0 && q[0] && q[0].startAt == null) q[0].startAt = gameNow(state);

    pushLog(state, `Cancelled craft: ${recipe?.name ?? entry.recipeId}.`, "info", null, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

function tickCraftQueues(state, loadedData) {
    const { idx } = loadedData;
    const t = gameNow(state);

    for (const [stationId, q] of Object.entries(state.queues.craftsByStationId)) {
      if (!q || q.length === 0) continue;

      // If the head craft hasn't started yet, start it now.
      if (q[0].startAt == null) q[0].startAt = t;

      // Complete as many crafts as are due. Always advance the queue, even if a craft errors.
      while (q.length > 0) {
        const cEntry = q[0];

        // Defensive: ensure we have a start time.
        if (cEntry.startAt == null) cEntry.startAt = t;

        const recipe = idx.recipesById.get(cEntry.recipeId);
        const durMs = Number.isFinite(cEntry.durationMs) ? cEntry.durationMs : ((recipe?.timeSec || 60) * 1000);
        const endsAt = cEntry.startAt + durMs;

        if (endsAt > t) break;

        try {
          if (!recipe) throw new Error(`Unknown recipeId: ${cEntry.recipeId}`);
          resolveCraftCompletion(state, loadedData, recipe);
        } catch (err) {
          console.error(err);
          pushLog(
            state,
            `ERROR: crafting failed for ${recipe?.name ?? cEntry.recipeId}. See console.`,
            "warn",
            null,
            loadedData
          );
        } finally {
          // Always advance, so we never "re-complete" the same craft endlessly.
          q.shift();
          if (q.length > 0 && q[0].startAt == null) q[0].startAt = endsAt;
          safetySnapshot(state, loadedData);
        }
      }
    }
  }

  function resolveCraftCompletion(state, loadedData, recipe) {
    const { idx } = loadedData;

    if (recipe.special?.makeItem) {
      // Special: create/ensure special item exists and add it
      const it = recipe.special.makeItem;
      if (!idx.itemsById.has(it.id)) {
        // (Should already be normalized on load)
      }
      addItemToStorage(state, loadedData, it.id, recipe.special.qty || 1);
      pushLog(state, `Crafted: ${it.name}.`, "good", null, loadedData);
      return;
    }

    const gained = [];
    for (const out of (recipe.outputs || [])) {
      if (!out.qty || out.qty <= 0) continue;
      const ok = addItemToStorage(state, loadedData, out.id, out.qty);
      if (ok.ok) gained.push({ id: out.id, qty: out.qty });
      else pushLog(state, `Storage full. Couldn't store crafted item: ${idx.itemsById.get(out.id)?.name ?? out.id}.`, "bad", null, loadedData);
    }

    const txt = gained.length ? gained.map(g => `${g.qty}× ${idx.itemsById.get(g.id)?.name ?? g.id}`).join(", ") : "nothing";
    pushLog(state, `Craft complete: ${recipe.name} -> ${txt}.`, "good", null, loadedData);
  }

  /* =========================
     Stations Upgrades
  ========================= */
  function upgradeStation(state, loadedData, stationId) {
    const { data, idx } = loadedData;
    const st = idx.stationsById.get(stationId);
    if (!st) return { ok: false, reason: "unknown station" };

    const cur = state.rv.stations[stationId] ?? 0;
    const next = st.levels.find(x => x.level === cur + 1);
    if (!next) return { ok: false, reason: "maxed" };

    // Check costs
    for (const c of (next.cost || [])) {
      if (!hasItemInAreaStorages(state, loadedData, c.id, c.qty)) {
        const nm = idx.itemsById.get(c.id)?.name ?? c.id;
        return { ok: false, reason: `Missing: ${nm} (${c.qty})` };
      }
    }

    // Pay
    for (const c of (next.cost || [])) removeItemFromAreaStorages(state, loadedData, c.id, c.qty);

    state.rv.stations[stationId] = cur + 1;
    recomputeDerivedStats(state, loadedData);
    pushLog(state, `${st.name} upgraded to level ${cur + 1}.`, "good", null, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  /* =========================
     NPC Recruitment (Tutorial Encounter)
  ========================= */
  function canRecruit(state, loadedData) {
    return state.crew.members.length < state.crew.maxCrew;
  }

  function ensureCrewPortraitAssigned(member, state, loadedData) {
    if (!member || typeof member !== "object") return;
    if (member.portraitPath) return;

    const paths = loadedData?.data?.portraits;
    if (Array.isArray(paths) && paths.length) {
      const pick = paths[randInt(Math.random, 0, paths.length - 1)];
      member.portraitPath = normalizePortraitPath(pick);
    } else {
      member.portraitPath = ""; // placeholder
    }
  }

  function recruitNpcFromTemplate(state, loadedData, npcTemplateId) {
    const t = loadedData.idx.npcsById.get(npcTemplateId);
    if (!t) return { ok: false, reason: "unknown NPC" };
    if (!canRecruit(state, loadedData)) return { ok: false, reason: "No bunks available" };

    const npc = makeCharacter({
      name: t.name,
      isPlayer: false,
      baseStats: t.stats,
      startingGear: [{ itemId: "knife_pocket", equip: true }], // NPC arrives with a knife (MVP)
      startingPockets: [],
      idleBehavior: "rest"
    }, loadedData);

    // Attach perk/quirk as metadata (MVP)
    npc.perk = t.perk;
    npc.quirk = t.quirk;
    npc.needs.hunger = 70;
    npc.needs.thirst = 70;
    npc.needs.morale = 65;

    ensureCrewPortraitAssigned(npc, state, loadedData);

    state.crew.members.push(npc);
    state.queues.jobsByCharId[npc.id] = [];

    pushLog(state, `${npc.name} joined your caravan.`, "good", npc.id, loadedData);
    safetySnapshot(state, loadedData);
    return { ok: true, npc };
  }

  /* =========================
     Saves (manual slots + safety snapshot)
  ========================= */
  function normalizeSaveList(raw) {
    // Back-compat: older versions may have stored saves as an object map or wrapped structure.
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object") {
      if (Array.isArray(raw.saves)) return raw.saves;
      // object map: {id:{...slot}, ...}
      const vals = Object.values(raw);
      // keep only plausible slot objects
      return vals.filter(v => v && typeof v === "object" && ("state" in v || "name" in v || "id" in v));
    }
    return [];
  }

  function sanitizeSaveSlot(slot) {
    if (!slot || typeof slot !== "object") return null;
    const id = String(slot.id || uid("slot"));
    const name = String(slot.name || "Untitled Save");
    const ts = Number.isFinite(slot.ts) ? slot.ts : nowReal();
    const state = slot.state || slot.payload || slot.data || slot.gameState || null;
    return { id, name, ts, state };
  }

  function loadAllSaves() {
    const raw = safeJsonParse(store.getItem(LS_SAVES_KEY), []);
    const list = normalizeSaveList(raw).map(sanitizeSaveSlot).filter(Boolean);
    return list;
  }

  function saveAllSaves(list) {
    const arr = (Array.isArray(list) ? list : []).map(sanitizeSaveSlot).filter(Boolean);
    store.setItem(LS_SAVES_KEY, JSON.stringify(arr));
  }

  function safetySnapshot(state, loadedData) {
    const enabled = (loadedData?.data?.config?.safetySnapshotEnabled !== false);
    if (!enabled) return;

    // Save snapshot not as a slot; used for recovery
    const snap = {
      ts: nowReal(),
      state
    };
    store.setItem(LS_SNAPSHOT_KEY, JSON.stringify(snap));
  }

  function createSaveSlot(name, state) {
    const _saves = loadAllSaves();
    const saves = Array.isArray(_saves) ? _saves : [];
    const id = uid("save");
    saves.push({ id, name: name || "Unnamed Save", ts: nowReal(), state });
    saveAllSaves(saves);
    store.setItem(LS_LAST_ACTIVE_SAVE_KEY, id);
    return id;
  }

  function updateSaveSlot(saveId, state) {
    const _saves = loadAllSaves();
    const saves = Array.isArray(_saves) ? _saves : [];
    const s = saves.find(x => x.id === saveId);
    if (!s) return false;
    s.ts = nowReal();
    s.state = state;
    saveAllSaves(saves);
    store.setItem(LS_LAST_ACTIVE_SAVE_KEY, saveId);
    return true;
  }

  function deleteSaveSlot(saveId) {
    let saves = loadAllSaves();
    saves = saves.filter(x => x.id !== saveId);
    saveAllSaves(saves);
    const last = store.getItem(LS_LAST_ACTIVE_SAVE_KEY);
    if (last === saveId) store.removeItem(LS_LAST_ACTIVE_SAVE_KEY);
  }

  function getSaveSlot(saveId) {
    const _saves = loadAllSaves();
    const saves = Array.isArray(_saves) ? _saves : [];
    return saves.find(x => x.id === saveId) || null;
  }

  function getSnapshot() {
    return safeJsonParse(store.getItem(LS_SNAPSHOT_KEY), null);
  }

  /* =========================
     Simulation Step
  ========================= */
  function simulateToNow(state, loadedData) {
    const tNow = gameNow(state);
    const last = state.meta.lastSimAt || tNow;
    const elapsed = tNow - last;
    if (elapsed <= 0) return;

    applyContinuousDrains(state, loadedData, elapsed);

    // tick queues (completions)
    tickCraftQueues(state, loadedData);
    tickJobQueues(state, loadedData);

    // settlement background systems
    simulateSettlementsToNow(state, loadedData, tNow);

    // caravan travel + shipments (v0.4)
    simulateTravelAndShipmentsToNow(state, loadedData, tNow);

    // post-tick auto-consume
    for (const c of state.crew.members) maybeAutoConsume(state, loadedData, c);

    state.meta.lastSimAt = tNow;
  }

  /* =========================
     GPS Location
  ========================= */
  function getGpsPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos),
        (err) => reject(err),
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 }
      );
    });
  }

  /* =========================
     UI (built dynamically)
  ========================= */
  const UI = {
    root: null,
    windshield: null,
    windshieldTitle: null,
    rvView: null,
    npcStrip: null,
    npcGrid: null,

    // HUD stats
    statFuel: null,
    statStorage: null,
    statCrew: null,
    statHunger: null,
    statThirst: null,
    statMorale: null,
    statDayNight: null,

    btnCheckLocation: null,
    btnActions: null,
    btnCrafting: null,
    btnCrew: null,
    btnStorage: null,
    btnStations: null,
    btnSaves: null,
    btnSettlement: null,
    btnMap: null,
    btnAdmin: null,

    panel: null,
    panelTitle: null,
    panelBody: null,
    panelClose: null,

    logBox: null,

    adminOverlay: null,
    settlementOverlay: null,
    mapOverlay: null
  };

  function buildUiShell() {
    // Basic CSS-less structure; style.css will make it nice later.
    UI.root = el("div", { class: "appRoot" });

    // Windshield view
    UI.windshield = el("div", { class: "windshield" });
    UI.windshieldTitle = el("div", { class: "tileCard" }, ["Tile: —"]);
    UI.rvView = el("div", { class: "rvView" }, [
      el("div", { class: "rvPlaceholder" }, ["[ RV ]"])
    ]);
    UI.windshield.append(UI.windshieldTitle, UI.rvView);

    // NPC portrait strip (mounted from index.html #npcStripMount if present)
    const npcMount = document.getElementById("npcStripMount");
    UI.npcStrip = npcMount ? npcMount : el("div", { class: "npcStrip", id: "npcStrip" });
    if (npcMount) {
      npcMount.id = "npcStrip";
      npcMount.className = "npcStrip";
      clearNode(npcMount);
    }
    UI.npcGrid = el("div", { class: "npcGrid" });
    UI.npcStrip.appendChild(UI.npcGrid);

    // Dashboard HUD
    const hud = el("div", { class: "hud" });

    const gauges = el("div", { class: "gauges" });
    UI.statFuel = makeGauge("Fuel", "—");
    UI.statStorage = makeGauge("Storage", "—");
    UI.statCrew = makeGauge("Crew", "—");
    UI.statHunger = makeGauge("Hunger", "—");
    UI.statThirst = makeGauge("Thirst", "—");
    UI.statMorale = makeGauge("Morale", "—");
    UI.statDayNight = makeGauge("Time", "—");
    gauges.append(
      UI.statFuel.wrap,
      UI.statStorage.wrap,
      UI.statCrew.wrap,
      UI.statHunger.wrap,
      UI.statThirst.wrap,
      UI.statMorale.wrap,
      UI.statDayNight.wrap
    );

    const buttons = el("div", { class: "hudButtons" });
    UI.btnCheckLocation = el("button", { class: "btn", id: "btnCheckLocation" }, ["Check Location"]);
    UI.btnActions = el("button", { class: "btn", id: "btnActions" }, ["Actions"]);
    UI.btnCrafting = el("button", { class: "btn", id: "btnCrafting" }, ["Crafting"]);
    UI.btnCrew = el("button", { class: "btn", id: "btnCrew" }, ["Crew"]);
    UI.btnStorage = el("button", { class: "btn", id: "btnStorage" }, ["Storage"]);
    UI.btnStations = el("button", { class: "btn", id: "btnStations" }, ["Stations"]);
    UI.btnSaves = el("button", { class: "btn ghost", id: "btnSaves" }, ["Saves"]);
    UI.btnSettlement = el("button", { class: "btn ghost", id: "btnSettlement" }, ["Settlement"]);
    UI.btnMap = el("button", { class: "btn ghost", id: "btnMap" }, ["Map"]);
    UI.btnAdmin = el("button", { class: "btn ghost", id: "btnAdmin" }, ["Admin"]);

    buttons.append(UI.btnCheckLocation, UI.btnActions, UI.btnCrafting, UI.btnCrew, UI.btnStorage, UI.btnStations, UI.btnSaves, UI.btnSettlement, UI.btnMap, UI.btnAdmin);

    // Log box
    UI.logBox = el("div", { class: "logBox" }, [
      el("div", { class: "logTitle" }, ["Activity Log"]),
      el("div", { class: "logList" })
    ]);

    hud.append(gauges, buttons, UI.logBox);

    // Side panel
    UI.panel = el("div", { class: "panel hidden" });
    UI.panelTitle = el("div", { class: "panelTitle" }, ["—"]);
    UI.panelClose = el("button", { class: "btn ghost small", onclick: () => hidePanel() }, ["Close"]);
    const titleRow = el("div", { class: "panelTitleRow" }, [UI.panelTitle, UI.panelClose]);
    UI.panelBody = el("div", { class: "panelBody" }, []);
    UI.panel.append(titleRow, UI.panelBody);

    UI.root.append(UI.windshield, UI.npcStrip, hud, UI.panel);
    document.body.appendChild(UI.root);
  }

  function makeGauge(label, valueText) {
    const value = el("div", { class: "gValue" }, [valueText]);
    const wrap = el("div", { class: "gauge" }, [
      el("div", { class: "gLabel" }, [label]),
      value
    ]);
    return { wrap, value };
  }

  function showPanel(title, bodyNode) {
    UI.panelTitle.textContent = title;
    clearNode(UI.panelBody);
    UI.panelBody.appendChild(bodyNode);
    UI.panel.classList.remove("hidden");
  }

  function hidePanel() {
    UI.panel.classList.add("hidden");
  }

  function renderLog(state) {
    const list = UI.logBox.querySelector(".logList");
    if (!list) return;
    clearNode(list);

    // newest last, but show last 80 for UI
    const view = state.log.slice(-80);
    for (const e of view) {
      const row = el("div", { class: `logRow ${e.type || "info"}` }, [
        el("span", { class: "logTime" }, [new Date(e.ts).toLocaleTimeString()]),
        " ",
        el("span", { class: "logText" }, [e.text])
      ]);
      list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
  }

  function renderWindshield(state, loadedData) {
    const tileId = state.meta.lastTileId;
    if (!tileId) {
      UI.windshieldTitle.textContent = "Tile: — (tap Check Location)";
      UI.windshield.dataset.bg = "bg_unknown";
      return;
    }
    const tile = state.world.discoveredTiles[tileId];
    const biome = biomeForTile(loadedData, tile);
    UI.windshieldTitle.textContent = `Tile: ${tileId} — ${biome.name}${tile.tutorialOverlay ? " (Tutorial)" : ""}`;
    UI.windshield.dataset.bg = biome.bg || "bg_unknown";

    // RV placeholder can be enhanced later by showing modules based on station levels
    const rvText = `[ RV | Storage L${state.rv.stations.storage ?? 0} | Bunks L${state.rv.stations.bunks ?? 0} ]`;
    const rv = UI.rvView.querySelector(".rvPlaceholder");
    if (rv) rv.textContent = rvText;
  }
function updateNpcCardOverlays(card, c) {
  if (!card || !c) return;

  // Badges (always present, just hide if none)
  const cond = c.conditions || {};
  let badgeWrap = card.querySelector(".npcBadges");
  if (!badgeWrap) {
    badgeWrap = el("div", { class: "npcBadges" }, []);
    card.appendChild(badgeWrap);
  }
  clearNode(badgeWrap);

  if (cond.downed) badgeWrap.appendChild(el("span", { class: "npcBadge downed" }, ["Downed"]));
  if (cond.sickness) badgeWrap.appendChild(el("span", { class: "npcBadge sick" }, ["Sick"]));
  if (cond.injury) badgeWrap.appendChild(el("span", { class: "npcBadge injured" }, ["Injured"]));
  badgeWrap.style.display = badgeWrap.childNodes.length ? "" : "none";

  // Bars: update widths in-place
  const needs = c.needs || {};
  const defs = [
    ["Hunger", needs.hunger, "hunger"],
    ["Thirst", needs.thirst, "thirst"],
    ["Morale", needs.morale, "morale"],
    ["Health", needs.health, "health"]
  ];

  for (const [label, val, cls] of defs) {
    const pct = clamp(Number.isFinite(val) ? val : 0, 0, 100);
    const bar = card.querySelector(`.npcBar.${cls}`);
    const fill = bar ? bar.querySelector(".npcBarFill") : null;
    if (bar) bar.title = `${label}: ${Math.round(pct)}`;
    if (fill) fill.style.width = `${pct}%`;
  }
}

function renderNpcStrip(state, loadedData) {
  if (!UI.npcStrip || !UI.npcGrid) return;

  const crew = Array.isArray(state?.crew?.members) ? state.crew.members : [];

  // Include whole crew, with Rover forced to be first
  const rover = crew.find(c => c && c.isPlayer) || null;
  const others = rover ? crew.filter(c => c && c !== rover) : crew.filter(c => c);
  const members = rover ? [rover, ...others] : others;

  if (!members.length) {
    UI.npcStrip.style.display = "none";
    clearNode(UI.npcGrid);
    UI.npcGrid.dataset.key = "";
    return;
  }

  UI.npcStrip.style.display = "";

  // Ensure portraits assigned BEFORE we build the key
  for (const c of members) {
    ensureCrewPortraitAssigned(c, state, loadedData);
  }

  // Key based on stable identity + portrait
  const key = members.map(c => {
    const id = (c.id || c.uid || c.key || c.name || "");
    const p = (c.portraitPath || "");
    return `${id}|${p}`;
  }).join("||");

  // If nothing changed, DO NOT rebuild DOM (prevents mobile flashing)
  if (UI.npcGrid.dataset.key === key && UI.npcGrid.children.length === members.length) {
    for (let i = 0; i < members.length; i++) {
      updateNpcCardOverlays(UI.npcGrid.children[i], members[i]);
    }
    return;
  }

  UI.npcGrid.dataset.key = key;

  // Rebuild only when roster/portrait set changes
  clearNode(UI.npcGrid);

  for (const c of members) {
    const name = String(c.name || "Crew");
    const card = el("div", { class: "npcCard", title: name });

    if (c.portraitPath) {
      const img = el("img", { class: "npcImg", alt: name, loading: "lazy" });
      img.src = c.portraitPath;
      img.addEventListener("error", () => {
        try { img.remove(); } catch (_) {}
        card.classList.add("noImg");
        card.insertBefore(el("div", { class: "npcPlaceholder" }, [initialsFromName(name)]), card.firstChild);
      }, { once: true });
      card.appendChild(img);
    } else {
      card.classList.add("noImg");
      card.appendChild(el("div", { class: "npcPlaceholder" }, [initialsFromName(name)]));
    }

    // Build overlays once (badge wrap + bars)
    const badgeWrap = el("div", { class: "npcBadges" }, []);
    card.appendChild(badgeWrap);

    const bars = el("div", { class: "npcBars" }, []);
    const needs = c.needs || {};
    const defs = [
      ["Hunger", needs.hunger, "hunger"],
      ["Thirst", needs.thirst, "thirst"],
      ["Morale", needs.morale, "morale"],
      ["Health", needs.health, "health"]
    ];

    for (const [label, val, cls] of defs) {
      const pct = clamp(Number.isFinite(val) ? val : 0, 0, 100);
      const bar = el("div", { class: `npcBar ${cls}`, title: `${label}: ${Math.round(pct)}` }, []);
      const fill = el("div", { class: "npcBarFill" }, []);
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      bars.appendChild(bar);
    }

    card.appendChild(bars);

    // Ensure correct badges + bar widths right now
    updateNpcCardOverlays(card, c);

    UI.npcGrid.appendChild(card);
  }
}

  function renderHudStats(state, loadedData) {
    // Fuel is not implemented as a resource yet; show placeholder
    UI.statFuel.value.textContent = "—";

    const used = countStorageUsed(state, loadedData);
    const cap = state.rv.storage.capacity || 0;
    UI.statStorage.value.textContent = `${used}/${cap}`;

    UI.statCrew.value.textContent = `${state.crew.members.length}/${state.crew.maxCrew}`;

    // show player needs in HUD
    const player = state.crew.members.find(m => m.isPlayer) || state.crew.members[0];
    UI.statHunger.value.textContent = `${Math.round(player.needs.hunger)}`;
    UI.statThirst.value.textContent = `${Math.round(player.needs.thirst)}`;
    UI.statMorale.value.textContent = `${Math.round(clamp(player.needs.morale + currentMoraleModifier(player), 0, 100))}`;

    const night = isNight(state, loadedData, state.meta.lastKnownLat, state.meta.lastKnownLon);
    UI.statDayNight.value.textContent = night ? "Night" : "Day";
  }

  function renderAll(state, loadedData) {
    renderHudStats(state, loadedData);
    renderWindshield(state, loadedData);
    renderNpcStrip(state, loadedData);
    renderLog(state);
  }

  /* =========================
     Panels
  ========================= */
  function panelActions(state, loadedData) {
    const wrap = el("div", { class: "panelStack" });

    let tileId = state.meta.lastTileId;
    if (!tileId) {
      const prec = loadedData.data.config.tilePrecision || 7;
      tileId = geohashEncode(0, 0, prec);
      state.meta.lastTileId = tileId;
      const tile = getOrCreateTile(state, loadedData, tileId);
      const biome = biomeForTile(loadedData, tile);
      wrap.appendChild(el("div", { class: "hint" }, ["Location not set — using a default tile. You can still tap Check Location later."]));
      pushLog(state, `Using default tile ${tileId} (${biome.name}).`, "info", null, loadedData);
      safetySnapshot(state, loadedData);
    }

    const tile = getOrCreateTile(state, loadedData, tileId);
    const jobs = listAvailableJobsForTile(state, loadedData, tile);

    // Tutorial encounter block
    if (tile.tutorialOverlay && tile.encounter?.type === "recruitNpc") {
      const npcTemplateId = tile.encounter.npcTemplateId;
      const tmpl = loadedData.idx.npcsById.get(npcTemplateId);
      const req = tile.encounter.requirement;

      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, ["Encounter: Campfire Signal"]));
      card.appendChild(el("div", { class: "cardBody" }, [
        el("div", { class: "hint" }, [`A survivor waves you over. It's ${tmpl?.name ?? "someone"} (${tmpl?.archetype ?? "Unknown"}).`]),
        el("div", { class: "hint" }, [`Perk: ${tmpl?.perk?.name ?? "—"} — ${tmpl?.perk?.desc ?? ""}`]),
        el("div", { class: "hint" }, [`Quirk: ${tmpl?.quirk?.name ?? "—"} — ${tmpl?.quirk?.desc ?? ""}`])
      ]));

      const can = canRecruit(state, loadedData);
      let reqText = "No requirement.";
      if (req?.itemId) {
        const nm = loadedData.idx.itemsById.get(req.itemId)?.name ?? req.itemId;
        reqText = req.optional ? `Optional: offer ${req.qty}× ${nm}` : `Requires: ${req.qty}× ${nm}`;
      }
      card.appendChild(el("div", { class: "hint" }, [reqText]));

      const btn = el("button", {
        class: `btn ${can ? "" : "disabled"}`,
        onclick: async () => {
          if (!can) {
            toast("No bunks available. Upgrade Bunks to recruit more crew.");
            return;
          }
          if (req?.itemId && !req.optional && !hasItemInStorage(state, loadedData, req.itemId, req.qty)) {
            toast("You don't have what they need yet.");
            return;
          }

          // Optional offering
          if (req?.itemId && req.optional && hasItemInStorage(state, loadedData, req.itemId, req.qty)) {
            const nm = loadedData.idx.itemsById.get(req.itemId)?.name ?? req.itemId;
            const ok = await confirmModal("Offer Supplies?", `Offer ${req.qty}× ${nm} to help them settle in?`, "Offer", "Skip");
            if (ok) removeItemFromStorage(state, loadedData, req.itemId, req.qty);
          }

          const res = recruitNpcFromTemplate(state, loadedData, npcTemplateId);
          if (res.ok) {
            tile.encounter = null; // one-time
            pushLog(state, "Recruitment tutorial complete.", "system", null, loadedData);
            safetySnapshot(state, loadedData);
            renderAll(state, loadedData);
            showPanel("Actions", panelActions(state, loadedData));
          } else {
            toast(res.reason);
          }
        }
      }, [can ? "Recruit" : "Recruit (Needs Bunks)"]);
      card.appendChild(btn);

      wrap.appendChild(card);
    }

    // Job list
    wrap.appendChild(el("div", { class: "hint" }, ["Choose a job and assign it to yourself or a crew member. Jobs run in real time even when you close the tab."]));

    for (const j of jobs) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, [j.name]));
      const reqs = [];
      if (j.toolTag) reqs.push(`Tool: ${j.toolTag}`);
      if (j.requiresItem) reqs.push(`Requires item in storage: ${loadedData.idx.itemsById.get(j.requiresItem)?.name ?? j.requiresItem}`);
      card.appendChild(el("div", { class: "cardBody" }, [
        el("div", { class: "smallLabel" }, [`Duration: ~${fmtTime((j.baseSec || 600) * 1000)}`]),
        el("div", { class: "smallLabel" }, [reqs.length ? reqs.join(" • ") : "No special requirements."])
      ]));

      const assignRow = el("div", { class: "row" });

      const sel = el("select", { class: "select" });
      for (const c of state.crew.members) {
        sel.appendChild(el("option", { value: c.id }, [`${c.name}${c.isPlayer ? " (You)" : ""}`]));
      }

      const paceSel = el("select", { class: "select" });
      paceSel.appendChild(el("option", { value: "safe" }, ["Safe"]));
      paceSel.appendChild(el("option", { value: "normal", selected: true }, ["Normal"]));
      paceSel.appendChild(el("option", { value: "push" }, ["Push"]));

      const btn = el("button", {
        class: "btn",
        onclick: async () => {
          const charId = sel.value;
          const pace = paceSel.value;

          // v0.2 special job flows
          if (j.variant === "gather_water" || j.id === "gather_water") {
            const containers = (state.rv.storage.stacks || [])
              .map(s => ({ s, def: loadedData.idx.itemsById.get(s.itemId) }))
              .filter(x => x.def?.category === "container" && x.s.qty > 0);

            if (!containers.length) return toast("No containers in storage. Find or craft an Empty Bottle / Jug / Bucket.");

            const options = containers.map(x => {
              const units = x.def.container?.waterUnits ?? 1;
              const secs = x.def.container?.gatherSeconds ?? 30;
              return {
                id: x.def.id,
                label: `${x.def.name} (x${x.s.qty})`,
                hint: `Carries ${units} water • ${secs}s`
              };
            });

            const containerId = await chooseModal("Gather Water", "Choose a container from RV storage:", options);
            if (!containerId) return;

            const def = loadedData.idx.itemsById.get(containerId);
            const units = def?.container?.waterUnits ?? 1;
            const secs = def?.container?.gatherSeconds ?? 30;

            const res = startJobForChar(state, loadedData, charId, j.id, pace, {
              durationMs: secs * 1000,
              meta: { special: "gather_water", containerItemId: containerId, waterItemId: "water_dirty", waterQty: units }
            });

            if (!res.ok) toast(res.reason);
            else {
              renderAll(state, loadedData);
              showPanel("Actions", panelActions(state, loadedData));
            }
            return;
          }

          if (j.variant === "explore" || j.id === "explore") {
            const char = state.crew.members.find(c => c.id === charId);
            if (!char) return toast("Crew member not found.");

            // Require rations in pockets (1 food + 1 water)
            const pocketFood = (char.pockets.stacks || []).find(st => loadedData.idx.itemsById.get(st.itemId)?.category === "food" && st.qty > 0);
            const pocketWater = (char.pockets.stacks || []).find(st => loadedData.idx.itemsById.get(st.itemId)?.category === "water" && st.qty > 0);

            if (!pocketFood || !pocketWater) return toast("Exploration requires 1 food + 1 water in pockets. Transfer supplies to pockets first.");

            // Choose exploration action (reuses yields from an existing job if available)
            const pickJobId = (key) => {
              // Prefer direct ID match.
              if (loadedData.idx.jobsById.has(key)) return key;

              const lowerKey = String(key).toLowerCase();

              // Heuristics: look for matching job by explicit fields, skill, or name.
              let best = null;
              for (const j of (loadedData.data.jobs || [])) {
                const jid = j.id;
                if (!jid) continue;

                const name = String(j.name || "").toLowerCase();
                const xpSkill = String(j.xpSkill || "").toLowerCase();
                const tags = Array.isArray(j.tags) ? j.tags.map(t => String(t).toLowerCase()) : [];

                // direct-ish matches
                if (String(j.action || "").toLowerCase() === lowerKey) return jid;
                if (String(j.actionKey || "").toLowerCase() === lowerKey) return jid;
                if (tags.includes(lowerKey)) return jid;

                // skill-based + name-based fallbacks
                if (lowerKey === "scavenge" && (xpSkill === "scavenge" || name.includes("scavenge"))) best ||= jid;
                if (lowerKey === "forage" && (name.includes("forage") || xpSkill === "wilderness")) best ||= jid;
                if (lowerKey === "hunt" && (name.includes("hunt") || name.includes("hunting"))) best ||= jid;
                if (lowerKey === "fish" && (name.includes("fish") || name.includes("fishing"))) best ||= jid;
              }
              return best;
            };

            const desired = ["forage", "scavenge", "hunt", "fish", "search_live_fish", "gather_car_parts"];
            const actionCandidates = desired.map(pickJobId).filter(Boolean);

            const actOptions = (actionCandidates.length ? actionCandidates : ["forage"]).map(id => ({
              id,
              label: loadedData.idx.jobsById.get(id)?.name ?? id,
              hint: loadedData.idx.jobsById.get(id)?.desc ?? ""
            }));

            const actionJobId = await chooseModal("Explore", "What should they do while exploring?", actOptions);
            if (!actionJobId) return;

            const dirOptions = [
              { id: "N", label: "North", hint: "" },
              { id: "S", label: "South", hint: "" },
              { id: "E", label: "East", hint: "" },
              { id: "W", label: "West", hint: "" }
            ];
            const direction = await chooseModal("Explore", "Pick a direction to scout:", dirOptions);
            if (!direction) return;

            // Reserve rations (consume from pockets now; restored if the task is cancelled)
            const consumed = [];
            if (removeItemFromPockets(state, loadedData, char, pocketFood.itemId, 1)) consumed.push({ itemId: pocketFood.itemId, qty: 1 });
            if (removeItemFromPockets(state, loadedData, char, pocketWater.itemId, 1)) consumed.push({ itemId: pocketWater.itemId, qty: 1 });

            if (consumed.length < 2) {
              // rollback if something went weird
              for (const rc of consumed) addItemToPockets(state, loadedData, char, rc.itemId, rc.qty);
              return toast("Couldn't reserve rations. Try again.");
            }

            const res = startJobForChar(state, loadedData, charId, j.id, pace, {
              meta: { special: "explore", actionJobId, direction, rationsConsumed: consumed }
            });

            if (!res.ok) {
              // rollback rations if we failed to queue
              for (const rc of consumed) addItemToPockets(state, loadedData, char, rc.itemId, rc.qty);
              toast(res.reason);
            } else {
              renderAll(state, loadedData);
              showPanel("Actions", panelActions(state, loadedData));
            }
            return;
          }

          // normal job
          const res = startJobForChar(state, loadedData, charId, j.id, pace);
          if (!res.ok) toast(res.reason);
          else {
            renderAll(state, loadedData);
            showPanel("Actions", panelActions(state, loadedData));
          }
        }
      }, ["Queue Job"]);

      assignRow.append(sel, paceSel, btn);
      card.appendChild(assignRow);

      wrap.appendChild(card);
    }

    return wrap;
  }

  function panelCrafting(state, loadedData) {
    const { data, idx } = loadedData;
    const wrap = el("div", { class: "panelStack" });

    wrap.appendChild(el("div", { class: "hint" }, [
      "All recipes are visible. If you can’t craft something yet, the menu will show why (missing parts or station level)."
    ]));

    // Simple filters by station
    const stations = [...new Set(data.recipes.map(r => r.station))];
    const filterRow = el("div", { class: "row" });
    const stationSel = el("select", { class: "select" });
    stationSel.appendChild(el("option", { value: "all" }, ["All Stations"]));
    for (const s of stations) stationSel.appendChild(el("option", { value: s }, [s]));
    filterRow.appendChild(el("div", { class: "smallLabel" }, ["Station:"]));
    filterRow.appendChild(stationSel);
    wrap.appendChild(filterRow);

    const list = el("div", { class: "panelStack" });
    wrap.appendChild(list);

    function renderList() {
      clearNode(list);
      const chosen = stationSel.value;
      const recipes = data.recipes.filter(r => chosen === "all" ? true : r.station === chosen);

      for (const r of recipes) {
        const can = canCraftRecipe(state, loadedData, r);

        const card = el("div", { class: `card ${can.ok ? "" : "locked"}` });
        card.appendChild(el("div", { class: "cardTitle" }, [r.name]));
        const stationLevel = getStationLevel(state, r.station);
        const stationNeed = r.stationLevel || 0;

        const ing = (r.inputs || []).map(i => {
          const nm = idx.itemsById.get(i.id)?.name ?? i.id;
          const have = hasItemInStorage(state, loadedData, i.id, i.qty);
          return `${have ? "✓" : "✗"} ${i.qty}× ${nm}`;
        });

        // Simple biome hints: pull from item sources for missing ingredients
        const missing = (r.inputs || []).filter(i => !hasItemInStorage(state, loadedData, i.id, i.qty));
        const hints = new Set();
        for (const m of missing) {
          const idef = idx.itemsById.get(m.id);
          const sources = idef?.sources || [];
          for (const s of sources) {
            const biomes = s.biomes || [];
            for (const b of biomes) {
              if (b === "*") continue;
              const bn = loadedData.data.biomes.find(x => x.id === b)?.name;
              if (bn) hints.add(bn);
            }
          }
        }

        const hintText = hints.size ? `Found in: ${[...hints].slice(0, 4).join(", ")}${hints.size > 4 ? "…" : ""}` : "Found in: (varies)";

        card.appendChild(el("div", { class: "cardBody" }, [
          el("div", { class: "smallLabel" }, [`Station: ${r.station} (You: L${stationLevel} / Need: L${stationNeed})`]),
          el("div", { class: "smallLabel" }, [`Craft time: ${fmtTime((r.timeSec || 60) * 1000)}`]),
          el("div", { class: "smallLabel" }, ["Ingredients:"]),
          el("div", { class: "hint" }, [ing.join(" • ")]),
          el("div", { class: "hint" }, [hintText]),
          can.ok ? el("div", { class: "hint good" }, ["Ready to craft."]) : el("div", { class: "hint bad" }, [`Locked: ${can.reason}`])
        ]));

        const btnRow = el("div", { class: "row" });
        const btn = el("button", {
          class: `btn ${can.ok ? "" : "disabled"}`,
          onclick: () => {
            if (!can.ok) return;
            const res = startCraft(state, loadedData, r.id);
            if (!res.ok) toast(res.reason);
            renderAll(state, loadedData);
            renderList();
          }
        }, [can.ok ? "Craft" : "Can't craft"]);

        btnRow.appendChild(btn);
        card.appendChild(btnRow);

        list.appendChild(card);
      }
    }

    stationSel.addEventListener("change", renderList);
    renderList();

    // Craft queues overview
    wrap.appendChild(el("div", { class: "divider" }));
    wrap.appendChild(el("div", { class: "cardTitle" }, ["Crafting Queues"]));

    for (const [stationId, q] of Object.entries(state.queues.craftsByStationId)) {
      const stName = loadedData.idx.stationsById.get(stationId)?.name ?? stationId;
      const box = el("div", { class: "card" });
      box.appendChild(el("div", { class: "smallLabel" }, [stName]));
      const body = el("div", { class: "hint" });

      if (!q || q.length === 0) {
        body.textContent = "Empty.";
      } else {
        const t = gameNow(state);
        body.style.display = "flex";
        body.style.flexDirection = "column";
        body.style.gap = "6px";

        for (let i = 0; i < q.length; i++) {
          const c = q[i];
          const rec = loadedData.idx.recipesById.get(c.recipeId);
          const ends = (c.startAt == null ? t : c.startAt) + (c.durationMs || 0);
          const left = Math.max(0, ends - t);

          const label = `${i === 0 ? "▶" : "•"} ${rec?.name ?? c.recipeId} — ${fmtTime(left)} remaining`;

          const row = el("div", { class: "row" });
          row.appendChild(el("div", {
            class: "hint",
            style: "flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"
          }, [label]));

          const btn = el("button", {
            class: "btn ghost",
            onclick: () => {
              const res = cancelCraftEntry(state, loadedData, stationId, c.id);
              if (!res.ok) toast(res.reason || "Can't cancel.");
              renderAll(state, loadedData);
              showPanel("Crafting", panelCrafting(state, loadedData));
            }
          }, [i === 0 ? "Cancel" : "Remove"]);
          btn.style.padding = "4px 8px";
          btn.style.fontSize = "12px";

          row.appendChild(btn);
          body.appendChild(row);
        }
      }
      box.appendChild(body);
      wrap.appendChild(box);
    }

    return wrap;
  }

  function panelCrew(state, loadedData) {
    const wrap = el("div", { class: "panelStack" });
    wrap.appendChild(el("div", { class: "hint" }, [
      "Crew members auto-eat and drink from RV storage (rations only). You can now transfer items/gear between RV storage and pockets, feed/drink manually from Storage, and cancel queued tasks."
    ]));

    for (const c of state.crew.members) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, [`${c.name}${c.isPlayer ? " (You)" : ""}`]));

      const status = [];
      if (c.conditions.downed) status.push("DOWNED");
      if (c.conditions.injury) status.push(`${c.conditions.injury.severity.toUpperCase()} INJURY`);
      if (c.conditions.sickness) status.push("SICK");

      const morale = Math.round(clamp(c.needs.morale + currentMoraleModifier(c), 0, 100));

      card.appendChild(el("div", { class: "cardBody" }, [
        el("div", { class: "smallLabel" }, [`Hunger: ${Math.round(c.needs.hunger)} • Thirst: ${Math.round(c.needs.thirst)} • Morale: ${morale} • Health: ${Math.round(c.needs.health)}`]),
        el("div", { class: "smallLabel" }, [status.length ? `Status: ${status.join(", ")}` : "Status: OK"]),
        c.perk ? el("div", { class: "hint" }, [`Perk: ${c.perk.name} — ${c.perk.desc}`]) : el("div", { class: "hint" }, ["Perk: —"]),
        c.quirk ? el("div", { class: "hint" }, [`Quirk: ${c.quirk.name} — ${c.quirk.desc}`]) : el("div", { class: "hint" }, ["Quirk: —"])
      ]));

      // Stats view
      const statsLine = Object.keys(c.stats).map(k => `${k}: ${effectiveSkill(c, k)}`).join(" • ");
      card.appendChild(el("div", { class: "hint" }, [statsLine]));

      // XP view
      const xpLines = Object.keys(c.xp || {}).map(skill => xpProgressLine(state, loadedData, c, skill));
      if (xpLines.length) {
        const xpBox = el("div", { class: "hint" });
        xpBox.textContent = `XP:\n${xpLines.join("\n")}`;
        xpBox.style.whiteSpace = "pre-line";
        card.appendChild(xpBox);
      }

      // Idle behavior selector
      const idleRow = el("div", { class: "row" });
      const idleSel = el("select", { class: "select" });
      idleSel.appendChild(el("option", { value: "rest" }, ["Idle: Rest"]));
      idleSel.appendChild(el("option", { value: "forage" }, ["Idle: Forage (Safe)"]));
      idleSel.appendChild(el("option", { value: "fish" }, ["Idle: Fish (Safe)"]));
      idleSel.appendChild(el("option", { value: "none" }, ["Idle: Stand By"]));
      idleSel.value = c.idleBehavior === "none" ? "none" : (c.idleBehavior === "fish" ? "fish" : (c.idleBehavior === "forage" ? "forage" : "rest"));

      idleSel.addEventListener("change", () => {
        const v = idleSel.value;
        if (v === "forage") c.idleBehavior = "forage";
        else if (v === "fish") c.idleBehavior = "fish";
        else if (v === "none") c.idleBehavior = "none";
        else c.idleBehavior = "rest";
        safetySnapshot(state, loadedData);
        toast(`${c.name} idle set.`);
      });

      idleRow.appendChild(idleSel);

      // Equipment
      const eqBtn = el("button", {
        class: "btn",
        onclick: () => showPanel("Equipment", panelEquipment(state, loadedData, c.id))
      }, ["Equipment"]);
      idleRow.appendChild(eqBtn);

      card.appendChild(idleRow);

      // Job queue with cancel controls
      const q = state.queues.jobsByCharId[c.id] || [];
      const qWrap = el("div", { class: "panelStack" });

      const qHeader = el("div", { class: "row" });
      qHeader.appendChild(el("div", { class: "smallLabel" }, [`Queue: ${q.length ? q.length + " task(s)" : "empty"}`]));

      if (q.length) {
        const btnClear = el("button", {
          class: "btn ghost",
          onclick: async () => {
            const ok = await confirmModal("Clear Queue", `Clear all queued tasks for <b>${c.name}</b>?`, "Clear", "Cancel");
            if (!ok) return;
            clearJobQueue(state, loadedData, c.id);
            renderAll(state, loadedData);
            showPanel("Crew", panelCrew(state, loadedData));
          }
        }, ["Clear"]);
        qHeader.appendChild(btnClear);
      }
      qWrap.appendChild(qHeader);

      if (q.length) {
        const t = gameNow(state);
        for (let i = 0; i < q.length; i++) {
          const j = q[i];
          const def = loadedData.idx.jobsById.get(j.jobId);
          const ends = (j.startAt || t) + j.durationMs;
          const left = Math.max(0, ends - t);
          const isActive = (i === 0 && j.startAt != null);

          const row = el("div", { class: "card" });
          row.appendChild(el("div", { class: "cardTitle" }, [`${isActive ? "▶ " : ""}${def?.name ?? j.jobId}`]));
          row.appendChild(el("div", { class: "hint" }, [`${isActive ? "Running" : "Queued"} • ${fmtTime(left)} remaining`]));

          const btnRow = el("div", { class: "row" });

          const btnCancel = el("button", {
            class: "btn ghost",
            onclick: async () => {
              const ok = await confirmModal("Cancel Task", `Cancel <b>${def?.name ?? j.jobId}</b> for <b>${c.name}</b>?`, "Cancel Task", "Keep");
              if (!ok) return;
              cancelQueuedJob(state, loadedData, c.id, j.id);
              renderAll(state, loadedData);
              showPanel("Crew", panelCrew(state, loadedData));
            }
          }, ["Cancel"]);
          btnRow.appendChild(btnCancel);

          row.appendChild(btnRow);
          qWrap.appendChild(row);
        }
      }

      card.appendChild(qWrap);
      wrap.appendChild(card);
    }

    return wrap;
  }

  function panelEquipment(state, loadedData, charId) {
    const wrap = el("div", { class: "panelStack" });
    const char = state.crew.members.find(m => m.id === charId);
    if (!char) {
      wrap.appendChild(el("div", { class: "hint" }, ["Character not found."]));
      return wrap;
    }

    const used = countPocketsUsed(char);
    const cap = char.pockets.capacity ?? 0;
    wrap.appendChild(el("div", { class: "hint" }, [
      `Pockets: ${used}/${cap || "∞"} units. Equip tools/armor from pockets. Use Storage to transfer items/gear into pockets.`
    ]));

    // Equipped slots
    const slotCard = el("div", { class: "card" });
    slotCard.appendChild(el("div", { class: "cardTitle" }, ["Equipped"]));

    const slotList = el("div", { class: "panelStack" });
    for (const slot of Object.keys(char.equipment)) {
      const instUid = char.equipment[slot];
      const inst = instUid ? (char.pockets.instances.find(x => x.uid === instUid) || state.rv.storage.instances.find(x => x.uid === instUid) || null) : null;
      const def = inst ? loadedData.idx.itemsById.get(inst.itemId) : null;

      const row = el("div", { class: "row" });
      row.appendChild(el("div", { class: "smallLabel" }, [`${slot}: ${def?.name ?? "—"}`]));

      if (instUid) {
        const btn = el("button", {
          class: "btn ghost",
          onclick: () => {
            char.equipment[slot] = null;
            safetySnapshot(state, loadedData);
            toast("Unequipped.");
            renderAll(state, loadedData);
            showPanel("Equipment", panelEquipment(state, loadedData, charId));
          }
        }, ["Unequip"]);
        row.appendChild(btn);
      }
      slotList.appendChild(row);
    }
    slotCard.appendChild(slotList);
    wrap.appendChild(slotCard);

    // Pocket Instances (gear)
    const instCard = el("div", { class: "card" });
    instCard.appendChild(el("div", { class: "cardTitle" }, ["Pockets — Gear"]));

    const instList = el("div", { class: "panelStack" });
    const pocketInst = char.pockets.instances || [];
    if (!pocketInst.length) instList.appendChild(el("div", { class: "hint" }, ["No gear in pockets. Transfer gear from Storage."]));
    for (const inst of pocketInst) {
      const def = loadedData.idx.itemsById.get(inst.itemId);
      const isEquippable = !!(def?.tool || def?.armor);
      const name = def?.name ?? inst.itemId;
      const durTxt = (inst.durability != null) ? `Durability: ${inst.durability}` : "Durability: —";

      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, [name]));
      card.appendChild(el("div", { class: "hint" }, [durTxt]));

      const row = el("div", { class: "row" });

      if (isEquippable) {
        const btnEquip = el("button", {
          class: "btn",
          onclick: () => {
            equipInstanceOnChar(char, inst.uid, loadedData);
            safetySnapshot(state, loadedData);
            toast("Equipped.");
            renderAll(state, loadedData);
            showPanel("Equipment", panelEquipment(state, loadedData, charId));
          }
        }, ["Equip"]);
        row.appendChild(btnEquip);
      }

      const btnStore = el("button", {
        class: "btn ghost",
        onclick: () => {
          const r = transferInstanceCharToRv(state, loadedData, charId, inst.uid);
          if (!r.ok) return toast(`Can't store: ${r.reason}`);
          toast("Moved to RV storage.");
          renderAll(state, loadedData);
          showPanel("Equipment", panelEquipment(state, loadedData, charId));
        }
      }, ["Store in RV"]);
      row.appendChild(btnStore);

      card.appendChild(row);
      instList.appendChild(card);
    }
    instCard.appendChild(instList);
    wrap.appendChild(instCard);

    // Pocket Stacks (supplies)
    const stackCard = el("div", { class: "card" });
    stackCard.appendChild(el("div", { class: "cardTitle" }, ["Pockets — Supplies"]));

    const stackList = el("div", { class: "panelStack" });
    const stacks = char.pockets.stacks || [];
    if (!stacks.length) stackList.appendChild(el("div", { class: "hint" }, ["No stacked items in pockets. Transfer from Storage."]));

    for (const st of stacks) {
      const def = loadedData.idx.itemsById.get(st.itemId);
      const name = def?.name ?? st.itemId;

      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, [`${name} × ${st.qty}`]));

      const row = el("div", { class: "row" });
      const btnStore = el("button", {
        class: "btn ghost",
        onclick: async () => {
          const max = st.qty;
          const v = await inputModal("Store Supplies", `How many ${name} to move to RV storage? (1-${max})`, "", "1");
          const n = Math.max(0, Math.min(max, Math.floor(Number(v))));
          if (!n) return;
          const r = transferStackCharToRv(state, loadedData, charId, st.itemId, n);
          if (!r.ok) return toast(`Can't store: ${r.reason}`);
          toast("Moved to RV storage.");
          renderAll(state, loadedData);
          showPanel("Equipment", panelEquipment(state, loadedData, charId));
        }
      }, ["Store"]);
      row.appendChild(btnStore);

      card.appendChild(row);
      stackList.appendChild(card);
    }

    stackCard.appendChild(stackList);
    wrap.appendChild(stackCard);

    return wrap;
  }

  
  function panelStorage(state, loadedData, ctx = null) {
    const activeTileId = getActiveTileId(state, loadedData);
    const tileId = (ctx && ctx.tileIdOverride) ? ctx.tileIdOverride : activeTileId;
    const isRemote = tileId !== activeTileId;
    const entries = listAreaStorages(state, loadedData, { tileId });

    if (!state.meta.storageViewKey) state.meta.storageViewKey = "rv";
    if (!state.meta.storageTransferTargetKey) state.meta.storageTransferTargetKey = "rv";

    const viewKey = entries.some(e => e.key === state.meta.storageViewKey) ? state.meta.storageViewKey : "rv";
    const targetKey = entries.some(e => e.key === state.meta.storageTransferTargetKey) ? state.meta.storageTransferTargetKey : "rv";
    state.meta.storageViewKey = viewKey;
    state.meta.storageTransferTargetKey = targetKey;

    const wrap = el("div", { class: "panelStack" });

    // Selector row
    const row = el("div", { class: "row wrap" });

    const selView = el("select", { class: "select" });
    const selTo = el("select", { class: "select" });

    for (const e of entries) {
      selView.appendChild(el("option", { value: e.key }, [e.label]));
      selTo.appendChild(el("option", { value: e.key }, [e.label]));
    }

    selView.value = viewKey;
    selTo.value = targetKey;

    selView.addEventListener("change", () => {
      state.meta.storageViewKey = selView.value;
      showPanel("Storage", panelStorage(state, loadedData));
    });
    selTo.addEventListener("change", () => {
      state.meta.storageTransferTargetKey = selTo.value;
      showPanel("Storage", panelStorage(state, loadedData));
    });

    row.appendChild(el("div", { class: "muted" }, ["View: "]));
    row.appendChild(selView);
    row.appendChild(el("div", { class: "muted" }, [" Transfer to: "]));
    row.appendChild(selTo);

    wrap.appendChild(row);

    // RV view => keep original panel (feed/water/ration prefs, crew pocket transfers, etc.)
    if (viewKey === "rv") {
      wrap.appendChild(panelStorageRv(state, loadedData));
      return wrap;
    }

    const from = getStorageEntryByKey(state, loadedData, viewKey, { tileId });
    const to = getStorageEntryByKey(state, loadedData, targetKey, { tileId });

    if (!from) {
      wrap.appendChild(el("div", { class: "muted" }, ["(Unknown storage)"]));
      return wrap;
    }

    wrap.appendChild(el("div", { class: "hint" }, [
      "You are viewing a local inventory in this tile. Use Transfer to move items between inventories."
    ]));

    const st = ensureStorageShape(from.storage);

    if (!st.stacks.length && !st.instances.length) {
      wrap.appendChild(el("div", { class: "muted" }, ["(Empty)"]));
      return wrap;
    }

    if (st.stacks.length) {
      const sec = el("div", { class: "card" });
      sec.appendChild(el("div", { class: "cardTitle" }, ["Stacks"]));

      for (const s of st.stacks) {
        const def = loadedData.idx.itemsById.get(s.itemId);
        const r = el("div", { class: "row between" });
        r.appendChild(el("div", {}, [`${def?.name || s.itemId} ×${s.qty}`]));

        const btns = el("div", { class: "row wrap right" });

        if (to && to.key !== from.key) {
          const btn = el("button", { class: "btn small" }, ["Transfer"]);
          btn.addEventListener("click", () => {
            const max = s.qty || 0;
            inputModal(`Transfer how many? (max ${max})`, `Quantity (1-${max})`, "", String(Math.min(max, 1) || 1)).then((val) => {
if (val == null) return;
              const q = Math.max(1, Math.min(max, Math.floor(Number(val) || 0)));
              if (!q) return;
              const res = transferStackBetweenEntries(state, loadedData, from, to, s.itemId, q);
              if (!res.ok) toast(res.reason || "Can't transfer");
              showPanel("Storage", panelStorage(state, loadedData));
              renderAll(state, loadedData);
          });
});
          btns.appendChild(btn);
        }

        r.appendChild(btns);
        sec.appendChild(r);
      }

      wrap.appendChild(sec);
    }

    if (st.instances.length) {
      const sec = el("div", { class: "card" });
      sec.appendChild(el("div", { class: "cardTitle" }, ["Instances"]));

      for (const inst of st.instances) {
        const def = loadedData.idx.itemsById.get(inst.itemId);
        const r = el("div", { class: "row between" });
        r.appendChild(el("div", {}, [`${def?.name || inst.itemId}`]));

        const btns = el("div", { class: "row wrap right" });
        if (to && to.key !== from.key) {
          const btn = el("button", { class: "btn small" }, ["Transfer"]);
          btn.addEventListener("click", () => {
            const res = transferInstanceBetweenEntries(state, loadedData, from, to, inst.id || inst.uid);
            if (!res.ok) toast(res.reason || "Can't transfer");
            showPanel("Storage", panelStorage(state, loadedData));
            renderAll(state, loadedData);
          });
          btns.appendChild(btn);
        }

        r.appendChild(btns);
        sec.appendChild(r);
      }

      wrap.appendChild(sec);
    }

    return wrap;
  }


function panelStorageRv(state, loadedData) {
    const wrap = el("div", { class: "panelStack" });

    const used = countStorageUsed(state, loadedData);
    const cap = state.rv.storage.capacity || 0;
    wrap.appendChild(el("div", { class: "hint" }, [
      `RV Storage: ${used}/${cap || "∞"} units. Use this panel to mark rations, transfer items to crew pockets, feed/drink manually, and drop items to free space.`
    ]));

    const crewOptions = state.crew.members.map(c => ({ id: c.id, label: c.name, hint: c.isPlayer ? "Player" : "Crew" }));

    // Stacks
    const stackCard = el("div", { class: "card" });
    stackCard.appendChild(el("div", { class: "cardTitle" }, ["Stacks"]));
    const stackList = el("div", { class: "panelStack" });

    const stacks = state.rv.storage.stacks.slice().sort((a, b) => (a.itemId > b.itemId ? 1 : -1));
    if (!stacks.length) stackList.appendChild(el("div", { class: "hint" }, ["No stacked items."]));

    for (const s of stacks) {
      const def = loadedData.idx.itemsById.get(s.itemId);
      const name = def?.name ?? s.itemId;

      const row = el("div", { class: "card" });
      row.appendChild(el("div", { class: "cardTitle" }, [`${name} × ${s.qty}`]));

      // Rations toggle (food only)
      if (def?.category === "food") {
        const rRow = el("div", { class: "row" });
        const chk = el("input", { type: "checkbox" });
        chk.checked = !!s.isRationAllowed;
        chk.addEventListener("change", () => {
          s.isRationAllowed = chk.checked;
          state.rv.storage.rationPrefs = state.rv.storage.rationPrefs || {};
          state.rv.storage.rationPrefs[s.itemId] = chk.checked;
          safetySnapshot(state, loadedData);
          toast("Rations updated.");
        });
        rRow.appendChild(chk);
        rRow.appendChild(el("div", { class: "smallLabel" }, ["Rations"]));
        row.appendChild(rRow);
      }

      const btnRow = el("div", { class: "row" });

      // Feed / Drink directly from storage
      if (def?.category === "food") {
        const btnEat = el("button", {
          class: "btn",
          onclick: async () => {
            const targetId = await chooseModal("Feed Crew", `Who will eat ${name}?`, crewOptions);
            if (!targetId) return;
            const char = state.crew.members.find(x => x.id === targetId);
            if (!char) return;
            const r = consumeFoodFromStorage(state, loadedData, char, s.itemId);
            if (!r.ok) toast(`Can't eat: ${r.reason}`);
            renderAll(state, loadedData);
            showPanel("Storage", panelStorage(state, loadedData));
          }
        }, ["Feed"]);
        btnRow.appendChild(btnEat);
      }
      if (def?.category === "water") {
        const btnDrink = el("button", {
          class: "btn",
          onclick: async () => {
            const targetId = await chooseModal("Give Water", `Who will drink ${name}?`, crewOptions);
            if (!targetId) return;
            const char = state.crew.members.find(x => x.id === targetId);
            if (!char) return;
            const r = consumeWaterFromStorage(state, loadedData, char, s.itemId);
            if (!r.ok) toast(`Can't drink: ${r.reason}`);
            renderAll(state, loadedData);
            showPanel("Storage", panelStorage(state, loadedData));
          }
        }, ["Drink"]);
        btnRow.appendChild(btnDrink);
      }

      // Transfer to pockets
      const btnGive = el("button", {
        class: "btn ghost",
        onclick: async () => {
          const targetId = await chooseModal("Transfer to Pockets", `Transfer ${name} to which crew member?`, crewOptions);
          if (!targetId) return;

          const max = s.qty;
          const v = await inputModal("Transfer Amount", `How many ${name}? (1-${max})`, "", "1");
          const n = Math.max(0, Math.min(max, Math.floor(Number(v))));
          if (!n) return;

          const r = transferStackRvToChar(state, loadedData, targetId, s.itemId, n);
          if (!r.ok) toast(`Can't transfer: ${r.reason}`);
          else toast("Transferred.");
          renderAll(state, loadedData);
          showPanel("Storage", panelStorage(state, loadedData));
        }
      }, ["Transfer"]);
      btnRow.appendChild(btnGive);

      // Drop
      const btnDrop = el("button", {
        class: "btn ghost",
        onclick: async () => {
          const max = s.qty;
          const v = await inputModal("Drop Items", `Drop how many ${name}? (1-${max})`, "", String(max));
          const n = Math.max(0, Math.min(max, Math.floor(Number(v))));
          if (!n) return;
          const ok = await confirmModal("Confirm Drop", `Drop <b>${n}× ${name}</b>? This cannot be undone.`, "Drop", "Cancel");
          if (!ok) return;
          const r = dropFromRvStorage(state, loadedData, s.itemId, n);
          if (!r.ok) toast(`Can't drop: ${r.reason}`);
          renderAll(state, loadedData);
          showPanel("Storage", panelStorage(state, loadedData));
        }
      }, ["Drop"]);
      btnRow.appendChild(btnDrop);

      row.appendChild(btnRow);
      stackList.appendChild(row);
    }

    stackCard.appendChild(stackList);
    wrap.appendChild(stackCard);

    // Instances
    const instCard = el("div", { class: "card" });
    instCard.appendChild(el("div", { class: "cardTitle" }, ["Instances / Gear"]));
    const instList = el("div", { class: "panelStack" });

    const insts = state.rv.storage.instances.slice();
    if (!insts.length) instList.appendChild(el("div", { class: "hint" }, ["No instanced gear in storage."]));

    for (const inst of insts) {
      const def = loadedData.idx.itemsById.get(inst.itemId);
      const name = def?.name ?? inst.itemId;
      const durTxt = (inst.durability != null) ? `Durability: ${inst.durability}` : "";

      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, [name]));
      if (durTxt) card.appendChild(el("div", { class: "hint" }, [durTxt]));

      const row = el("div", { class: "row" });

      const btnGiveInst = el("button", {
        class: "btn",
        onclick: async () => {
          const targetId = await chooseModal("Give Gear", `Give ${name} to which crew member?`, crewOptions);
          if (!targetId) return;
          const r = transferInstanceRvToChar(state, loadedData, targetId, inst.uid);
          if (!r.ok) toast(`Can't give: ${r.reason}`);
          else toast("Moved to pockets.");
          renderAll(state, loadedData);
          showPanel("Storage", panelStorage(state, loadedData));
          // optional: jump to equipment for quick equip
          if (r.ok) showPanel("Equipment", panelEquipment(state, loadedData, targetId));
        }
      }, ["Give"]);
      row.appendChild(btnGiveInst);

      const btnDropInst = el("button", {
        class: "btn ghost",
        onclick: async () => {
          const ok = await confirmModal("Confirm Drop", `Drop <b>${name}</b>? This cannot be undone.`, "Drop", "Cancel");
          if (!ok) return;
          const r = dropInstanceFromRvStorage(state, loadedData, inst.uid);
          if (!r.ok) toast(`Can't drop: ${r.reason}`);
          renderAll(state, loadedData);
          showPanel("Storage", panelStorage(state, loadedData));
        }
      }, ["Drop"]);
      row.appendChild(btnDropInst);

      card.appendChild(row);
      instList.appendChild(card);
    }

    instCard.appendChild(instList);
    wrap.appendChild(instCard);

    return wrap;
  }

  function panelStations(state, loadedData) {
    const { data } = loadedData;
    const wrap = el("div", { class: "panelStack" });

    wrap.appendChild(el("div", { class: "hint" }, ["Upgrade RV stations/modules to expand storage, crew capacity, and crafting."]));

    for (const st of data.stations) {
      const cur = state.rv.stations[st.id] ?? 0;
      const curDef = st.levels.find(x => x.level === cur) || st.levels[0];
      const nextDef = st.levels.find(x => x.level === cur + 1) || null;

      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, [`${st.name} (L${cur})`]));
      card.appendChild(el("div", { class: "hint" }, [st.desc || ""]));

      const effects = (curDef?.effects || []).map(e => `${e.type}${e.value != null ? `: ${e.value}` : ""}`).join(" • ");
      if (effects) card.appendChild(el("div", { class: "smallLabel" }, [`Current effects: ${effects}`]));

      if (nextDef) {
        const costText = (nextDef.cost || []).map(c => {
          const nm = loadedData.idx.itemsById.get(c.id)?.name ?? c.id;
          const have = hasItemInAreaStorages(state, loadedData, c.id, c.qty);
          return `${have ? "✓" : "✗"} ${c.qty}× ${nm}`;
        }).join(" • ");

        card.appendChild(el("div", { class: "smallLabel" }, [`Next upgrade costs: ${costText || "(free)"}`]));
        const btn = el("button", {
          class: "btn",
          onclick: () => {
            const res = upgradeStation(state, loadedData, st.id);
            if (!res.ok) toast(res.reason);
            renderAll(state, loadedData);
            showPanel("Stations", panelStations(state, loadedData));
          }
        }, ["Upgrade"]);
        card.appendChild(btn);
      } else {
        card.appendChild(el("div", { class: "smallLabel" }, ["Max level reached."]));
      }

      wrap.appendChild(card);
    }

    return wrap;
  }

  function panelSaves(state, loadedData, ctx) {
    const wrap = el("div", { class: "panelStack" });
    wrap.appendChild(el("div", { class: "hint" }, ["Manual saves only. A hidden safety snapshot is kept to prevent accidental loss."]));

    const _saves = loadAllSaves();
    const saves = Array.isArray(_saves) ? _saves : [];
    const activeId = ctx.activeSaveId;

    const list = el("div", { class: "panelStack" });

    for (const s of saves) {
      const card = el("div", { class: `card ${s.id === activeId ? "active" : ""}` });
      card.appendChild(el("div", { class: "cardTitle" }, [s.name]));
      card.appendChild(el("div", { class: "hint" }, [`Saved: ${fmtStamp(s.ts)}`]));

      const row = el("div", { class: "row" });
      const btnLoad = el("button", {
        class: "btn",
        onclick: async () => {
          const ok = await confirmModal("Load Save", `Load "${s.name}"? Unsaved progress will be lost.`, "Load", "Cancel");
          if (!ok) return;
          ctx.loadSaveId(s.id);
          hidePanel();
        }
      }, ["Load"]);

      const btnOverwrite = el("button", {
        class: "btn ghost",
        onclick: async () => {
          const ok = await confirmModal("Overwrite Save", `Overwrite "${s.name}" with your current run?`, "Overwrite", "Cancel");
          if (!ok) return;
          updateSaveSlot(s.id, state);
          toast("Save updated.");
          showPanel("Saves", panelSaves(state, loadedData, ctx));
        }
      }, ["Overwrite"]);

      const btnDelete = el("button", {
        class: "btn ghost",
        onclick: async () => {
          const ok = await confirmModal("Delete Save", `Delete "${s.name}"? This can't be undone.`, "Delete", "Cancel");
          if (!ok) return;
          deleteSaveSlot(s.id);
          toast("Deleted.");
          showPanel("Saves", panelSaves(state, loadedData, ctx));
        }
      }, ["Delete"]);

      row.append(btnLoad, btnOverwrite, btnDelete);
      card.appendChild(row);
      list.appendChild(card);
    }

    wrap.appendChild(list);

    const row2 = el("div", { class: "row" });
    const btnNew = el("button", {
      class: "btn",
      onclick: async () => {
        const name = await inputModal("New Save", "Save name:", "My Save", `Save ${new Date().toLocaleString()}`);
        if (!name) return;
        const id = createSaveSlot(name, state);
        ctx.activeSaveId = id;
        toast("Saved.");
        showPanel("Saves", panelSaves(state, loadedData, ctx));
      }
    }, ["Create Save"]);

    const btnSnapshot = el("button", {
      class: "btn ghost",
      onclick: () => {
        safetySnapshot(state, loadedData);
        toast("Safety snapshot updated.");
      }
    }, ["Update Snapshot"]);

    row2.append(btnNew, btnSnapshot);
    wrap.appendChild(row2);

    // Snapshot restore option
    const snap = getSnapshot();
    if (snap?.state) {
      wrap.appendChild(el("div", { class: "divider" }));
      wrap.appendChild(el("div", { class: "hint" }, [`Safety snapshot: ${fmtStamp(snap.ts)}`]));
      const btnRestore = el("button", {
        class: "btn ghost",
        onclick: async () => {
          const ok = await confirmModal("Restore Snapshot", "Restore from last safety snapshot? This replaces your current in-memory state.", "Restore", "Cancel");
          if (!ok) return;
          ctx.replaceState(deepCopy(snap.state));
          toast("Snapshot restored.");
          hidePanel();
        }
      }, ["Restore Snapshot"]);
      wrap.appendChild(btnRestore);
    }

    return wrap;
  }


  /* =========================
     Settlement System (Tile Structures)
  ========================= */

  function simulateSettlementsToNow(state, loadedData, nowMs) {
    // Tick all discovered tiles (prepares for future travel/remote access).
    // We tick in whole-day steps so it’s deterministic and cheap.
    const DAY_MS = 24 * 60 * 60 * 1000;

    const tiles = state?.world?.discoveredTiles || {};
    for (const tileId of Object.keys(tiles)) {
      const settlement = ensureSettlementForTile(state, loadedData, tileId);
      const tNow = nowMs || gameNow(state);
      if (!Number.isFinite(settlement.lastTickAt)) settlement.lastTickAt = tNow;

      while (settlement.lastTickAt + DAY_MS <= tNow) {
        settlementDayTick(state, loadedData, tileId);
        settlement.lastTickAt += DAY_MS;
      }
    }
  }

  function getStructInst(state, loadedData, tileId, structId) {
    const settlement = ensureSettlementForTile(state, loadedData, tileId);
    if (!settlement.structures[structId]) settlement.structures[structId] = { id: structId, level: 0, workers: [], storage: makeEmptyStorage(0), meta: {} };
    const def = loadedData.idx.structuresById.get(structId);
    if (def) {
      const lvlDef = (def.levels || []).find(x => x.level === settlement.structures[structId].level);
      if (Number.isFinite(lvlDef?.storageCap)) settlement.structures[structId].storage.capacity = lvlDef.storageCap;
    }
    return settlement.structures[structId];
  }

  function structWorkersOk(inst, def) {
    const need = Math.max(0, Number(def?.workersRequired || 0));
    const have = Array.isArray(inst?.workers) ? inst.workers.length : 0;
    return have >= need;
  }

  function settlementDayTick(state, loadedData, tileId) {
    const { idx } = loadedData;
    const defsById = idx.structuresById;

    const settlement = ensureSettlementForTile(state, loadedData, tileId);

    // ---- Water pump -> reservoir (or pump storage)
    const pumpDef = defsById.get("water_pump");
    const pumpInst = getStructInst(state, loadedData, tileId, "water_pump");
    if (pumpDef && (pumpInst.level || 0) > 0 && structWorkersOk(pumpInst, pumpDef)) {
      const lvl = pumpInst.level || 1;
      const outPerDay = (pumpDef.productionPerDayByLevel && pumpDef.productionPerDayByLevel[String(lvl)]) || pumpDef.productionPerDay || (lvl * 25);
      const waterId = pumpDef.waterItemId || "water_clean";
      let qty = Math.max(0, Math.floor(outPerDay || 0));

      if (qty > 0) {
        const resDef = defsById.get("water_reservoir");
        const resInst = getStructInst(state, loadedData, tileId, "water_reservoir");
        const reservoirBuilt = !!(resDef && (resInst.level || 0) > 0);

        let dest = { key: `tile:${tileId}:struct:water_pump`, storage: pumpInst.storage, accept: null };
        if (reservoirBuilt) {
          dest = { key: `tile:${tileId}:struct:water_reservoir`, storage: resInst.storage, accept: (itemId, ld) => (ld?.idx?.itemsById?.get(itemId)?.category === "water") };
        }

        const can = storageHasSpace(dest.storage, qty);
        if (!can) qty = Math.max(0, ((dest.storage.capacity || 0) <= 0 ? qty : (dest.storage.capacity - countStorageUsedObj(dest.storage))));
        if (qty > 0) addStackToStorageObj(dest.storage, loadedData, waterId, qty);
      }
    }

    // ---- Farm production
    const farmDef = defsById.get("farm");
    const farmInst = getStructInst(state, loadedData, tileId, "farm");
    if (farmDef && (farmInst.level || 0) > 0 && structWorkersOk(farmInst, farmDef)) {
      const meta = farmInst.meta || (farmInst.meta = {});
      if (!meta.cropId) meta.cropId = null;
      if (!meta.active) meta.active = false;
      if (meta.needsResupply === undefined) meta.needsResupply = false;

      if (meta.active && meta.cropId && !meta.needsResupply) {
        const lvl = farmInst.level || 1;
        const yields = farmDef.yieldPerDayByLevel || {};
        const out = Math.max(0, Math.floor(Number(yields[String(lvl)] || (lvl * 16))));
        if (out > 0) {
          addStackToStorageObj(farmInst.storage, loadedData, meta.cropId, out);
          pushLog(state, `Farm produced ${out}× ${(idx.itemsById.get(meta.cropId)?.name || meta.cropId)}.`);
        }

        // Auto-requeue behavior: if reservoir+pump built, keep running; otherwise require resupply after each harvest
        const pumpBuilt = (getStructInst(state, loadedData, tileId, "water_pump").level || 0) > 0;
        const resBuilt = (getStructInst(state, loadedData, tileId, "water_reservoir").level || 0) > 0;

        if (pumpBuilt && resBuilt) {
          // Optional small water draw per cycle (keeps water system meaningful but not punishing)
          const resInst = getStructInst(state, loadedData, tileId, "water_reservoir");
          const draw = Math.max(0, Math.floor(farmDef.waterPerCycle || 10));
          if (draw > 0) {
            removeStackFromStorageObj(resInst.storage, loadedData, farmDef.waterItemId || "water_clean", Math.min(draw, 999999));
          }
        } else {
          meta.needsResupply = true;
        }
      }
    }
  }

  function buildOrUpgradeStructure(state, loadedData, tileId, structId, payOpts = {}) {
    const { idx, data } = loadedData;
    const def = idx.structuresById.get(structId);
    if (!def) return { ok: false, reason: "unknown structure" };

    const settlement = ensureSettlementForTile(state, loadedData, tileId);
    const inst = getStructInst(state, loadedData, tileId, structId);

    const nextLevel = (inst.level || 0) + 1;
    const next = (def.levels || []).find(l => l.level === nextLevel);
    if (!next) return { ok: false, reason: "max level" };

    // Verify cost across ALL local inventories + RV
    for (const c of (next.cost || [])) {
      if (!hasItemInAreaStorages(state, loadedData, c.id, c.qty, { tileId, includeRv: payOpts.allowRv !== false })) {
        return { ok: false, reason: `Missing ${c.qty}× ${(idx.itemsById.get(c.id)?.name || c.id)}` };
      }
    }

    // Pay
    for (const c of (next.cost || [])) removeItemFromAreaStorages(state, loadedData, c.id, c.qty, { tileId, includeRv: payOpts.allowRv !== false });

    inst.level = nextLevel;
    if (Number.isFinite(next.storageCap)) inst.storage.capacity = next.storageCap;

    pushLog(state, `${def.name} upgraded to Lv ${inst.level}.`);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function moveCharPocketsToSettlementOrRv(state, loadedData, tileId, char) {
    const settlement = ensureSettlementForTile(state, loadedData, tileId);

    // Stacks
    const stacks = Array.isArray(char?.pockets?.stacks) ? [...char.pockets.stacks] : [];
    for (const s of stacks) {
      if (!s || !s.itemId || !s.qty) continue;
      const res = transferStackCharToRv(state, loadedData, char.id, s.itemId, s.qty);
      if (!res.ok) {
        // force move to ground pile
        const st = getPocketStack(char, s.itemId);
        if (st) st.qty = 0;
        addStackToStorageObj(settlement.ground, loadedData, s.itemId, s.qty);
      }
    }
    // prune pocket stacks
    if (char?.pockets) char.pockets.stacks = (char.pockets.stacks || []).filter(s => (s.qty || 0) > 0);

    // Instances
    const insts = Array.isArray(char?.pockets?.instances) ? [...char.pockets.instances] : [];
    for (const inst of insts) {
      if (!inst?.uid) continue;
      const res = transferInstanceCharToRv(state, loadedData, char.id, inst.uid);
      if (!res.ok) {
        // force move to ground pile
        const forced = removeInstanceByUid(char.pockets.instances, inst.uid);
        if (forced) {
          // unequip if needed
          for (const slot of Object.keys(char.equipment || {})) {
            if (char.equipment[slot] === inst.uid) char.equipment[slot] = null;
          }
          settlement.ground.instances.push(forced);
        }
      }
    }
  }

  function settleAssignCrewToStructure(state, loadedData, tileId, charId, structId) {
    const { idx } = loadedData;
    const settlement = ensureSettlementForTile(state, loadedData, tileId);
    const def = loadedData.idx.structuresById.get(structId);
    const inst = getStructInst(state, loadedData, tileId, structId);
    if (!def) return { ok: false, reason: "unknown structure" };
    if ((inst.level || 0) <= 0) return { ok: false, reason: "build it first" };

    const char = state.crew.members.find(m => m.id === charId);
    if (!char) return { ok: false, reason: "bad char" };
    if (char.isPlayer) return { ok: false, reason: "Rover can’t be assigned." };

    // Remove from caravan
    state.crew.members = state.crew.members.filter(m => m.id !== charId);

    // Move pockets back to RV (overflow to ground pile)
    moveCharPocketsToSettlementOrRv(state, loadedData, tileId, char);

    // Clear job queue (optional safety)
    if (state.queues?.jobsByCharId) state.queues.jobsByCharId[charId] = [];

    // Create citizen entry
    const citizen = deepCopy(char);
    citizen.settlement = { tileId, assignedTo: structId };
    // Tie needs to settlement stats (simple MVP binding)
    citizen.needs = deepCopy(settlement.stats);

    // Put in citizen pool and assign
    settlement.citizens.push(citizen);

    if (!Array.isArray(inst.workers)) inst.workers = [];
    inst.workers.push(charId);

    pushLog(state, `${char.name} assigned to ${def.name}.`);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function findSettlementCitizen(settlement, charId) {
    return settlement.citizens.find(c => c.id === charId) || null;
  }

  function removeCitizenFromAllWorkers(settlement, charId) {
    for (const inst of Object.values(settlement.structures || {})) {
      if (Array.isArray(inst.workers)) inst.workers = inst.workers.filter(id => id !== charId);
    }
  }

  function settleUnassignCitizen(state, loadedData, tileId, charId) {
    const settlement = ensureSettlementForTile(state, loadedData, tileId);
    const citizen = findSettlementCitizen(settlement, charId);
    if (!citizen) return { ok: false, reason: "not a citizen" };

    removeCitizenFromAllWorkers(settlement, charId);
    citizen.settlement = { tileId, assignedTo: null };
    pushLog(state, `${citizen.name} is now unassigned in the settlement.`);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function settleReleaseCitizen(state, loadedData, tileId, charId) {
    const settlement = ensureSettlementForTile(state, loadedData, tileId);
    const citizen = findSettlementCitizen(settlement, charId);
    if (!citizen) return { ok: false, reason: "not a citizen" };

    removeCitizenFromAllWorkers(settlement, charId);
    settlement.citizens = settlement.citizens.filter(c => c.id !== charId);

    pushLog(state, `${citizen.name} was released from settlement duty.`);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function settleReturnCitizenToCaravan(state, loadedData, tileId, charId, swapCharId = null, structSwapTo = null, dismissSwap = false) {
    const settlement = ensureSettlementForTile(state, loadedData, tileId);
    const citizen = findSettlementCitizen(settlement, charId);
    if (!citizen) return { ok: false, reason: "not a citizen" };

    // Caravan capacity check
    const maxCrew = state.crew.maxCrew || 0;
    const curCrew = state.crew.members.length;

    if (curCrew >= maxCrew) {
      // Caller must resolve via swap/dismiss.
      if (!swapCharId) return { ok: false, reason: "caravan full" };
      const swapChar = state.crew.members.find(m => m.id === swapCharId);
      if (!swapChar || swapChar.isPlayer) return { ok: false, reason: "bad swap" };

      if (dismissSwap) {
        // Dismiss the swapChar (release from caravan)
        moveCharPocketsToSettlementOrRv(state, loadedData, tileId, swapChar);
        state.crew.members = state.crew.members.filter(m => m.id !== swapCharId);
        pushLog(state, `${swapChar.name} was dismissed from the caravan.`);
      } else {
        // Swap into settlement citizen pool (optionally to a structure)
        state.crew.members = state.crew.members.filter(m => m.id !== swapCharId);
        moveCharPocketsToSettlementOrRv(state, loadedData, tileId, swapChar);
        const newCitizen = deepCopy(swapChar);
        newCitizen.settlement = { tileId, assignedTo: null };
        newCitizen.needs = deepCopy(settlement.stats);
        settlement.citizens.push(newCitizen);

        if (structSwapTo) {
          const inst = getStructInst(state, loadedData, tileId, structSwapTo);
          if (!Array.isArray(inst.workers)) inst.workers = [];
          if ((inst.level || 0) > 0) inst.workers.push(swapCharId);
          newCitizen.settlement.assignedTo = structSwapTo;
        }

        pushLog(state, `${swapChar.name} moved to the settlement (swap).`);
      }
    }

    // Remove citizen from settlement
    removeCitizenFromAllWorkers(settlement, charId);
    settlement.citizens = settlement.citizens.filter(c => c.id !== charId);

    // Add to caravan crew
    const back = deepCopy(citizen);
    delete back.settlement;
    back.needs = back.needs || { hunger: 80, thirst: 80, morale: 70, health: 100 };
    back.pockets = back.pockets || { capacity: 6, stacks: [], instances: [] };
    back.pockets.stacks = [];
    back.pockets.instances = [];
    back.equipment = back.equipment || { mainHand: null, offHand: null, head: null, body: null, legs: null, accessory: null };
    for (const k of Object.keys(back.equipment)) back.equipment[k] = null;

    state.crew.members.push(back);

    pushLog(state, `${back.name} returned to the caravan.`);
    safetySnapshot(state, loadedData);
    return { ok: true };
  }

  function toggleSettlementOverlay(state, loadedData, ctx) {
    if (UI.settlementOverlay) {
      UI.settlementOverlay.remove();
      UI.settlementOverlay = null;
      return;
    }

    const activeTileId = getActiveTileId(state, loadedData);
    const tileId = (ctx && ctx.tileIdOverride) ? ctx.tileIdOverride : activeTileId;
    const isRemote = tileId !== activeTileId;
    ensureSettlementForTile(state, loadedData, tileId);

    // Overlay shell
    UI.settlementOverlay = el("div", { class: "settlementOverlay" });
    const panel = el("div", { class: "settlementPanel" });

    const closeBtn = el("button", { class: "btn ghost small" }, ["Close"]);
    closeBtn.addEventListener("click", () => toggleSettlementOverlay(state, loadedData, ctx));

    const title = el("div", { class: "settlementTitle" }, [
      el("div", { class: "settlementTitleMain" }, ["Settlement"]),
      el("div", { class: "settlementTitleSub" }, [`Tile: ${tileId}`])
    ]);

    const header = el("div", { class: "settlementHeader" }, [title, closeBtn]);

    const tabs = el("div", { class: "settlementTabs" });
    const tabNames = isRemote ? ["Structures", "Citizens", "Stats"] : ["Structures", "Citizens", "Storage", "Stats"];
    const tabBtns = {};
    const tabStateKey = "settlementTab";
    if (!state.meta[tabStateKey]) state.meta[tabStateKey] = "Structures";

    for (const t of tabNames) {
      const b = el("button", { class: "btn ghost small" }, [t]);
      tabBtns[t] = b;
      b.addEventListener("click", () => {
        state.meta[tabStateKey] = t;
        render();
      });
      tabs.appendChild(b);
    }

    const body = el("div", { class: "settlementBody" });

    function renderStructures() {
      const { idx } = loadedData;
      const payOpts = { allowRv: !isRemote }; // local tile can use RV+local; remote (map) uses local only
      const settlement = ensureSettlementForTile(state, loadedData, tileId);
      const wrap = el("div", { class: "panelStack" });

      wrap.appendChild(el("div", { class: "hint" }, [
        "Build and upgrade structures for this tile. Costs can be paid from ANY local inventory + the caravan."
      ]));

      for (const def of (loadedData.data.structures || [])) {
        const inst = getStructInst(state, loadedData, tileId, def.id);
        const settlement = ensureSettlementForTile(state, loadedData, tileId);
        const workerNames = (inst.workers || []).map(wid => (settlement.citizens || []).find(c => c.id === wid)?.name || wid);
        const workerLine = workerNames.length ? `Assigned: ${workerNames.join(", ")}` : "";
        const row = el("div", { class: "card" });

        const top = el("div", { class: "row between" }, [
          el("div", { class: "col" }, [
            el("div", { class: "cardTitle" }, [def.name]),
            el("div", { class: "muted" }, [def.desc || ""])
          ]),
          el("div", { class: "col right" }, [
            el("div", { class: "muted" }, [inst.level > 0 ? `Lv ${inst.level}` : "Locked (Lv 0)"]),
            el("div", { class: "muted" }, [`Workers: ${(inst.workers || []).length}/${Math.max(0, Number(def.workersRequired || 0))}`]),
            workerLine ? el("div", { class: "muted" }, [workerLine]) : null
          ])
        ]);

        const btnRow = el("div", { class: "row wrap" });

        const nextLevel = (inst.level || 0) + 1;
        const next = (def.levels || []).find(l => l.level === nextLevel);

        const btnBuild = el("button", { class: "btn small" }, [inst.level > 0 ? "Upgrade" : "Build"]);
        btnBuild.disabled = !next;
        btnBuild.addEventListener("click", () => {
          if (!next) return;
          const needs = (next.cost || []).map(c => `${c.qty}× ${(idx.itemsById.get(c.id)?.name || c.id)}`).join(", ");
          confirmModal("Confirm Build", `Spend: ${needs}?`).then((ok) => {
            if (!ok) return;
            const res = buildOrUpgradeStructure(state, loadedData, tileId, def.id, { allowRv: !isRemote });
            if (!res.ok) toast(res.reason || "Can\'t build");
            render();
            renderAll(state, loadedData);
          });
        });

        btnRow.appendChild(btnBuild);

        // Manage (assignment / farm crop controls)
        const btnManage = el("button", { class: "btn ghost small" }, ["Manage"]);
        btnManage.disabled = (inst.level || 0) <= 0;
        btnManage.addEventListener("click", () => {
          state.meta.settlementSelectedStructureId = def.id;
          state.meta[tabStateKey] = "Citizens";
          render();
        });
        btnRow.appendChild(btnManage);

        // Cost preview
        if (next) {
          const costLine = el("div", { class: "muted" }, [
            "Next: ",
            ...((next.cost || []).flatMap((c, i) => {
              const ok = hasItemInAreaStorages(state, loadedData, c.id, c.qty, { tileId, includeRv: payOpts.allowRv !== false });
              const txt = `${c.qty}× ${(idx.itemsById.get(c.id)?.name || c.id)}`;
              return [el("span", { class: ok ? "ok" : "bad" }, [txt]), i < (next.cost.length - 1) ? el("span", {}, [", "]) : null].filter(Boolean);
            }))
          ]);
          row.append(top, costLine, btnRow);
        } else {
          row.append(top, btnRow);
        }

        wrap.appendChild(row);
      }

      return wrap;
    }

    function renderCitizens() {
      const settlement = ensureSettlementForTile(state, loadedData, tileId);
      const defsById = loadedData.idx.structuresById;

      const wrap = el("div", { class: "panelStack" });

      const selectedStruct = state.meta.settlementSelectedStructureId || null;
      if (selectedStruct) {
        const sd = defsById.get(selectedStruct);
        if (sd) wrap.appendChild(el("div", { class: "hint" }, [`Managing workers for: ${sd.name}`]));
      } else {
        wrap.appendChild(el("div", { class: "hint" }, ["Assign caravan crew to settlement structures. Assigned citizens stop consuming caravan supplies."]));
      }

      // Caravan crew list (eligible)
      const crewCard = el("div", { class: "card" });
      crewCard.appendChild(el("div", { class: "cardTitle" }, ["Caravan Crew (available)"]));

      const crew = state.crew.members.filter(m => !m.isPlayer);
      if (!crew.length) {
        crewCard.appendChild(el("div", { class: "muted" }, ["No assignable crew (Rover can’t be assigned)."]));
      } else {
        for (const m of crew) {
          const r = el("div", { class: "row between" });
          r.appendChild(el("div", {}, [m.name]));
          const btns = el("div", { class: "row" });

          const btnToSettlement = el("button", { class: "btn small" }, [selectedStruct ? "Assign" : "Send to Settlement"]);
          btnToSettlement.addEventListener("click", () => {
            if (selectedStruct) {
              const res = settleAssignCrewToStructure(state, loadedData, tileId, m.id, selectedStruct);
              if (!res.ok) toast(res.reason || "Can't assign");
            } else {
              // Move to settlement unassigned
              state.crew.members = state.crew.members.filter(x => x.id !== m.id);
              moveCharPocketsToSettlementOrRv(state, loadedData, tileId, m);
              const citizen = deepCopy(m);
              citizen.settlement = { tileId, assignedTo: null };
              citizen.needs = deepCopy(settlement.stats);
              settlement.citizens.push(citizen);
              pushLog(state, `${m.name} moved to settlement (unassigned).`);
              safetySnapshot(state, loadedData);
            }
            render();
            renderAll(state, loadedData);
          });

          btns.appendChild(btnToSettlement);
          r.appendChild(btns);
          crewCard.appendChild(r);
        }
      }

      wrap.appendChild(crewCard);

      // Settlement citizens
      const citizenCard = el("div", { class: "card" });
      citizenCard.appendChild(el("div", { class: "cardTitle" }, ["Settlement Citizens"]));

      if (!settlement.citizens.length) {
        citizenCard.appendChild(el("div", { class: "muted" }, ["No citizens assigned to this settlement yet."]));
      } else {
        for (const c of settlement.citizens) {
          const assignedTo = c?.settlement?.assignedTo || null;
          const label = assignedTo ? (defsById.get(assignedTo)?.name || assignedTo) : "Unassigned";
          const r = el("div", { class: "row between" }, [
            el("div", {}, [
              el("div", {}, [c.name]),
              el("div", { class: "muted" }, [`Role: ${label}`])
            ])
          ]);
          const btns = el("div", { class: "row wrap right" });

          if (assignedTo) {
            const btnUnassign = el("button", { class: "btn ghost small" }, ["Unassign"]);
            btnUnassign.addEventListener("click", () => {
              settleUnassignCitizen(state, loadedData, tileId, c.id);
              render();
              renderAll(state, loadedData);
            });
            btns.appendChild(btnUnassign);
          }

          const btnReturn = el("button", { class: "btn small" }, ["Return to Caravan"]);
          btnReturn.addEventListener("click", () => {
            const res = settleReturnCitizenToCaravan(state, loadedData, tileId, c.id);
            if (res.ok) {
              render();
              renderAll(state, loadedData);
              return;
            }
            if (res.reason !== "caravan full") {
              toast(res.reason || "Can't return");
              return;
            }

            // Caravan full -> manage swap/dismiss
            const candidates = state.crew.members.filter(m => !m.isPlayer);
            const opts = candidates.map(m => `${m.name} (swap candidate)`);
            if (!opts.length) {
              toast("Caravan is full and has no swappable members.");
              return;
            }
            chooseModal("Caravan is full. Choose a crew member to manage:", opts, (choice) => {
              if (choice == null) return;
              const swapChar = candidates[choice];
              // action: swap into settlement (unassigned) or dismiss
              chooseModal(`What do you want to do with ${swapChar.name}?`, ["Swap into settlement", "Dismiss from caravan"], (action) => {
                if (action == null) return;
                const dismiss = action === 1;
                const structSwapTo = dismiss ? null : (c?.settlement?.assignedTo || null);

                const rr = settleReturnCitizenToCaravan(
                  state, loadedData, tileId, c.id,
                  swapChar.id,
                  structSwapTo,
                  dismiss
                );

                if (!rr.ok) toast(rr.reason || "Couldn't resolve caravan full");
                render();
                renderAll(state, loadedData);
              });
            });
          });
          btns.appendChild(btnReturn);

          const btnRelease = el("button", { class: "btn ghost small" }, ["Release"]);
          btnRelease.addEventListener("click", () => {
            confirmModal("Confirm", `Release ${c.name} from duty?`).then((ok) => {
              if (!ok) return;
              settleReleaseCitizen(state, loadedData, tileId, c.id);
              render();
              renderAll(state, loadedData);
            });
          });
          btns.appendChild(btnRelease);

          r.appendChild(btns);
          citizenCard.appendChild(r);
        }
      }

      // Farm management (crop selection + resupply) when selected structure is Farm
      wrap.appendChild(citizenCard);
      if (selectedStruct === "farm") {
        const farmDef = defsById.get("farm");
        const farmInst = getStructInst(state, loadedData, tileId, "farm");
        const meta = farmInst.meta || (farmInst.meta = {});
        const farmCard = el("div", { class: "card" });
        farmCard.appendChild(el("div", { class: "cardTitle" }, ["Farm Control"]));

        if ((farmInst.level || 0) <= 0) {
          farmCard.appendChild(el("div", { class: "muted" }, ["Build the farm first."]));
        } else {
          const cropRow = el("div", { class: "row wrap" });
          cropRow.appendChild(el("div", { class: "muted" }, ["Crop: "]));
          const sel = el("select", { class: "select" });
          sel.appendChild(el("option", { value: "" }, ["— Select —"]));
          for (const cid of (farmDef?.crops || ["corn", "wheat", "vegetable", "berry"])) {
            const nm = loadedData.idx.itemsById.get(cid)?.name || cid;
            sel.appendChild(el("option", { value: cid }, [nm]));
          }
          sel.value = meta.cropId || "";
          sel.addEventListener("change", () => {
            meta.cropId = sel.value || null;
            safetySnapshot(state, loadedData);
          });
          cropRow.appendChild(sel);

          const status = meta.active
            ? (meta.needsResupply ? "Paused (needs resupply)" : "Active")
            : "Inactive";

          farmCard.appendChild(el("div", { class: "muted" }, [`Status: ${status}`]));
          farmCard.appendChild(cropRow);

          const btnRow = el("div", { class: "row wrap" });

          const btnStart = el("button", { class: "btn small" }, [meta.active ? "Stop" : "Start"]);
          btnStart.addEventListener("click", () => {
            if (meta.active) {
              meta.active = false;
              meta.needsResupply = false;
              pushLog(state, "Farm stopped.");
              safetySnapshot(state, loadedData);
              render();
              return;
            }

            if (!meta.cropId) {
              toast("Choose a crop first.");
              return;
            }

            // Initial supply: 10 dirt, 10 seeds (crop seed), 50 clean water
            const dirtId = farmDef?.dirtItemId || "dirt";
            const waterId = farmDef?.waterItemId || "water_clean";
            const seedMap = farmDef?.seedByCrop || { corn: "corn_seed", wheat: "wheat_seed", vegetable: "vegetable_seed", berry: "berry_seed" };
            const seedId = seedMap[meta.cropId] || farmDef?.seedItemId || "vegetable_seed";

            const costs = [
              { id: dirtId, qty: Math.max(0, Math.floor(farmDef?.initialSupplies?.dirt || 10)) },
              { id: seedId, qty: Math.max(0, Math.floor(farmDef?.initialSupplies?.seeds || 10)) },
              { id: waterId, qty: Math.max(0, Math.floor(farmDef?.initialSupplies?.water || 50)) }
            ];

            for (const cst of costs) {
              if (!hasItemInAreaStorages(state, loadedData, cst.id, cst.qty, { tileId })) {
                toast(`Missing ${cst.qty}× ${(loadedData.idx.itemsById.get(cst.id)?.name || cst.id)}.`);
                return;
              }
            }

            for (const cst of costs) removeItemFromAreaStorages(state, loadedData, cst.id, cst.qty, { tileId });

            meta.active = true;
            meta.needsResupply = false;
            pushLog(state, "Farm started.");
            safetySnapshot(state, loadedData);
            render();
          });

          btnRow.appendChild(btnStart);

          if (meta.active && meta.needsResupply) {
            const btnResupply = el("button", { class: "btn small" }, ["Resupply"]);
            btnResupply.addEventListener("click", () => {
              if (!meta.cropId) return;
              const dirtId = farmDef?.dirtItemId || "dirt";
              const waterId = farmDef?.waterItemId || "water_clean";
              const seedMap = farmDef?.seedByCrop || { corn: "corn_seed", wheat: "wheat_seed", vegetable: "vegetable_seed", berry: "berry_seed" };
              const seedId = seedMap[meta.cropId] || farmDef?.seedItemId || "vegetable_seed";

              const costs = [
                { id: dirtId, qty: Math.max(0, Math.floor(farmDef?.initialSupplies?.dirt || 10)) },
                { id: seedId, qty: Math.max(0, Math.floor(farmDef?.initialSupplies?.seeds || 10)) },
                { id: waterId, qty: Math.max(0, Math.floor(farmDef?.initialSupplies?.water || 50)) }
              ];

              for (const cst of costs) {
                if (!hasItemInAreaStorages(state, loadedData, cst.id, cst.qty, { tileId })) {
                  toast(`Missing ${cst.qty}× ${(loadedData.idx.itemsById.get(cst.id)?.name || cst.id)}.`);
                  return;
                }
              }
              for (const cst of costs) removeItemFromAreaStorages(state, loadedData, cst.id, cst.qty, { tileId });
              meta.needsResupply = false;
              pushLog(state, "Farm resupplied.");
              safetySnapshot(state, loadedData);
              render();
            });
            btnRow.appendChild(btnResupply);
          }

          farmCard.appendChild(btnRow);
        }

        wrap.appendChild(farmCard);
      }

      return wrap;
    }

    function renderStorage() {
      const wrap = el("div", { class: "panelStack" });

      const entries = listAreaStorages(state, loadedData, { tileId });
      const viewKey = state.meta.storageViewKey || "rv";
      const targetKey = state.meta.storageTransferTargetKey || "rv";

      const row = el("div", { class: "row wrap" });
      const selView = el("select", { class: "select" });
      const selTo = el("select", { class: "select" });

      for (const e of entries) {
        selView.appendChild(el("option", { value: e.key }, [e.label]));
        selTo.appendChild(el("option", { value: e.key }, [e.label]));
      }
      selView.value = entries.some(e => e.key === viewKey) ? viewKey : "rv";
      selTo.value = entries.some(e => e.key === targetKey) ? targetKey : "rv";

      selView.addEventListener("change", () => { state.meta.storageViewKey = selView.value; render(); });
      selTo.addEventListener("change", () => { state.meta.storageTransferTargetKey = selTo.value; render(); });

      row.appendChild(el("div", { class: "muted" }, ["View: "]));
      row.appendChild(selView);
      row.appendChild(el("div", { class: "muted" }, [" Transfer to: "]));
      row.appendChild(selTo);

      wrap.appendChild(row);

      const from = getStorageEntryByKey(state, loadedData, selView.value, { tileId });
      const to = getStorageEntryByKey(state, loadedData, selTo.value, { tileId });

      if (!from) return wrap;

      // List stacks
      const st = ensureStorageShape(from.storage);
      if (!st.stacks.length && !st.instances.length) {
        wrap.appendChild(el("div", { class: "muted" }, ["(Empty)"]));
        return wrap;
      }

      if (st.stacks.length) {
        const sec = el("div", { class: "card" });
        sec.appendChild(el("div", { class: "cardTitle" }, ["Stacks"]));
        for (const s of st.stacks) {
          const def = loadedData.idx.itemsById.get(s.itemId);
          const r = el("div", { class: "row between" });
          r.appendChild(el("div", {}, [`${def?.name || s.itemId} ×${s.qty}`]));

          const btns = el("div", { class: "row wrap right" });
          if (to && to.key !== from.key) {
            const btn = el("button", { class: "btn small" }, ["Transfer"]);
            btn.addEventListener("click", () => {
              const max = s.qty || 0;
              inputModal(`Transfer how many? (max ${max})`, `Quantity (1-${max})`, "", String(Math.min(max, 1) || 1)).then((val) => {
if (val == null) return;
                const q = Math.max(1, Math.min(max, Math.floor(Number(val) || 0)));
                if (!q) return;
                const res = transferStackBetweenEntries(state, loadedData, from, to, s.itemId, q);
                if (!res.ok) toast(res.reason || "Can't transfer");
                render();
                renderAll(state, loadedData);
          });
});
            btns.appendChild(btn);
          }
          r.appendChild(btns);
          sec.appendChild(r);
        }
        wrap.appendChild(sec);
      }

      if (st.instances.length) {
        const sec = el("div", { class: "card" });
        sec.appendChild(el("div", { class: "cardTitle" }, ["Instances"]));
        for (const inst of st.instances) {
          const def = loadedData.idx.itemsById.get(inst.itemId);
          const r = el("div", { class: "row between" });
          r.appendChild(el("div", {}, [`${def?.name || inst.itemId}`]));
          const btns = el("div", { class: "row wrap right" });
          if (to && to.key !== from.key) {
            const btn = el("button", { class: "btn small" }, ["Transfer"]);
            btn.addEventListener("click", () => {
              const res = transferInstanceBetweenEntries(state, loadedData, from, to, inst.id || inst.uid);
              if (!res.ok) toast(res.reason || "Can't transfer");
              render();
              renderAll(state, loadedData);
            });
            btns.appendChild(btn);
          }
          r.appendChild(btns);
          sec.appendChild(r);
        }
        wrap.appendChild(sec);
      }

      return wrap;
    }

    function renderStats() {
      const settlement = ensureSettlementForTile(state, loadedData, tileId);
      const s = settlement.stats || { hunger: 100, thirst: 100, morale: 100 };
      const wrap = el("div", { class: "panelStack" });
      wrap.appendChild(el("div", { class: "hint" }, [
        "Settlement stats are placeholders for now. Assigned citizens share these values until we add full simulation."
      ]));
      wrap.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row between" }, [el("div", {}, ["Hunger"]), el("div", {}, [String(s.hunger)])]),
        el("div", { class: "row between" }, [el("div", {}, ["Thirst"]), el("div", {}, [String(s.thirst)])]),
        el("div", { class: "row between" }, [el("div", {}, ["Morale"]), el("div", {}, [String(s.morale)])])
      ]));
      return wrap;
    }

    function render() {
      const tab = state.meta[tabStateKey] || "Structures";
      for (const t of tabNames) tabBtns[t].classList.toggle("active", t === tab);

      body.innerHTML = "";
      if (tab === "Structures") body.appendChild(renderStructures());
      else if (tab === "Citizens") body.appendChild(renderCitizens());
      else if (tab === "Storage") body.appendChild(renderStorage());
      else body.appendChild(renderStats());
    }

    panel.append(header, tabs, body);
    UI.settlementOverlay.appendChild(panel);
    document.body.appendChild(UI.settlementOverlay);
    render();
  }


  /* =========================
     Admin Panel
  ========================= */
  function isAdminUnlocked() {
    return store.getItem(LS_ADMIN_UNLOCK_KEY) === "1";
  }

  function setAdminUnlocked(v) {
    store.setItem(LS_ADMIN_UNLOCK_KEY, v ? "1" : "0");
  }

  

  /* =========================
     MAP + SHIPMENTS (v0.4)
  ========================= */

  function ensureTravelShipmentsShape(state) {
    state.world ||= {};
    state.world.travel ||= { active: false, fromTileId: null, toTileId: null, startAt: 0, endAt: 0, nextEventAt: 0, seed: 0 };
    if (!Array.isArray(state.world.shipments)) state.world.shipments = [];
  }

  function minutesToMs(min) { return Math.floor(min * 60 * 1000); }

  function formatEtaMs(ms) {
    ms = Math.max(0, Math.floor(ms || 0));
    const mins = Math.ceil(ms / (60 * 1000));
    if (mins <= 1) return "1 min";
    if (mins < 60) return `${mins} mins`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function getMapCfg(loadedData) {
    const d = loadedData?.data || {};
    return d.maps || FALLBACK_DATA.maps || { view: { size: 5, minSize: 5, maxSize: 15 }, travel: { baseMinutesPerTile: 60 }, defaults: { danger: 1, travelTimeMod: 1.0 } };
  }

  function tileHasMeaningfulSettlement(tile) {
    const s = tile?.settlement;
    if (!s) return false;
    const hasStruct = s.structures && Object.values(s.structures).some(v => (v || 0) > 0);
    const hasCit = Array.isArray(s.citizens) && s.citizens.length > 0;
    const hasGround = s.ground && Array.isArray(s.ground.stacks) && s.ground.stacks.some(st => (st.qty || 0) > 0);
    return !!(hasStruct || hasCit || hasGround);
  }

  function getInboundShipmentsToCaravan(state, loadedData) {
    ensureTravelShipmentsShape(state);
    const activeTileId = getActiveTileId(state, loadedData);
    return state.world.shipments.filter(s => s && s.status === "in_transit" && s.toMode && s.toMode.type === "caravan" && s.toMode.expectedTileId === activeTileId);
  }

  function startCaravanTravel(state, loadedData, toTileId, opts = {}) {
    ensureTravelShipmentsShape(state);
    const activeTileId = getActiveTileId(state, loadedData);
    if (state.world.travel.active) return { ok: false, reason: "Caravan is already traveling." };
    if (!toTileId || toTileId === activeTileId) return { ok: false, reason: "Already there." };

    const mapCfg = getMapCfg(loadedData);
    const baseMin = Number(mapCfg?.travel?.baseMinutesPerTile) || 60;

    // For MVP: adjacent-only travel time
    const dist = geohashGridDistance(activeTileId, toTileId);
    if (dist !== 1) return { ok: false, reason: "You can only move to adjacent tiles (1 step) right now." };

    const fromTile = getOrCreateTile(state, loadedData, activeTileId);
    const toTile = getOrCreateTile(state, loadedData, toTileId);

    const mod = (Number(fromTile.travelTimeMod) || 1) * (Number(toTile.travelTimeMod) || 1);
    const minutes = Math.max(1, Math.round(baseMin * Math.sqrt(mod)));

    const tNow = gameNow(state);
    state.world.travel = {
      active: true,
      fromTileId: activeTileId,
      toTileId,
      startAt: tNow,
      endAt: tNow + minutesToMs(minutes),
      nextEventAt: tNow + minutesToMs(15),
      seed: Math.floor(Math.random() * 1e9)
    };

    pushLog(state, `Caravan started traveling to ${toTileId} (ETA ${minutes} min).`);
    safetySnapshot(state);
    renderAll(state, loadedData);
    return { ok: true };
  }

  function cancelCaravanTravel(state, loadedData, reason = "Travel canceled.") {
    ensureTravelShipmentsShape(state);
    if (!state.world.travel.active) return;
    pushLog(state, reason);
    state.world.travel.active = false;
    safetySnapshot(state);
  }

  function finishCaravanTravel(state, loadedData) {
    ensureTravelShipmentsShape(state);
    if (!state.world.travel.active) return;
    const dest = state.world.travel.toTileId;
    state.meta.lastTileId = dest;
    state.world.travel.active = false;

    // ensure discovery
    getOrCreateTile(state, loadedData, dest);

    pushLog(state, `Caravan arrived at ${dest}.`);
    safetySnapshot(state);
  }

  function tickTravelEvents(state, loadedData, tNow) {
    ensureTravelShipmentsShape(state);
    const tr = state.world.travel;
    if (!tr.active) return;

    // resolve any events in 15-min chunks (MVP: auto-resolve, log only + occasional slowdowns)
    while (tr.nextEventAt && tr.nextEventAt < tr.endAt && tNow >= tr.nextEventAt) {
      const tile = getOrCreateTile(state, loadedData, tr.toTileId);
      const danger = Math.max(1, Math.floor(tile.danger || 1));
      const roll = Math.random();

      if (roll < 0.06 * danger) {
        // storm delay
        tr.endAt += minutesToMs(10);
        pushLog(state, `Storm slowed the caravan (+10 min).`);
      } else if (roll < 0.09 * danger) {
        // minor raid / mishap
        pushLog(state, `A minor raid spooked the crew, but the caravan pushed on.`);
      }

      tr.nextEventAt += minutesToMs(15);
    }
  }

function simulateShipmentsToNow(state, loadedData, tNow) {
  ensureTravelShipmentsShape(state);

  const shipments = state.world.shipments;
  if (!shipments.length) return;

  for (const s of shipments) {
    if (!s || s.status !== "in_transit") continue;
    if (tNow < s.etaAt) continue;

    // deliver or bounce
    if (s.toMode && s.toMode.type === "caravan") {
      const activeTileId = getActiveTileId(state, loadedData);
      if (activeTileId !== s.toMode.expectedTileId) {
        // return to origin (caravan moved)
        const originEntries = listAreaStorages(state, loadedData, { tileId: s.fromTileId, includeRv: true });
        const origin = originEntries.find(e => e.key === s.fromKey) || originEntries[0];

        for (const p of (s.payload || [])) {
          if (!origin || !origin.storage) continue;

          const putBack = addStackToStorageObj(origin.storage, loadedData, p.itemId, p.qty);
          if (!putBack.ok) {
            // overflow to origin ground (unlimited)
            const originSettlement = ensureSettlementForTile(state, loadedData, s.fromTileId);
            addStackToStorageObj(originSettlement.ground, loadedData, p.itemId, p.qty);
          }
        }

        s.status = "returned";
        pushLog(state, `Shipment to caravan was returned to origin (caravan moved).`);
        continue;
      }
    }

    // normal delivery
    const destEntries = listAreaStorages(
      state,
      loadedData,
      { tileId: s.toTileId, includeRv: (s.toMode?.type === "caravan") }
    );
    const dest = destEntries.find(e => e.key === s.toKey) || destEntries[0];

    for (const p of (s.payload || [])) {
      if (!dest || !dest.storage) continue;

      const delivered = addStackToStorageObj(dest.storage, loadedData, p.itemId, p.qty);
      if (!delivered.ok) {
        // overflow to destination ground (unlimited)
        const destSettlement = ensureSettlementForTile(state, loadedData, s.toTileId);
        addStackToStorageObj(destSettlement.ground, loadedData, p.itemId, p.qty);
      }
    }

    s.status = "delivered";
    pushLog(state, `Shipment delivered to ${s.toMode?.type === "caravan" ? "caravan" : "settlement"} (${s.toTileId}).`);
  }
}


  function simulateTravelAndShipmentsToNow(state, loadedData, tNow) {
    ensureTravelShipmentsShape(state);

    // travel
    if (state.world.travel.active) {
      tickTravelEvents(state, loadedData, tNow);
      if (tNow >= state.world.travel.endAt) {
        finishCaravanTravel(state, loadedData);
      }
    }

    // shipments
    simulateShipmentsToNow(state, loadedData, tNow);
  }

  
  function getItemQtyInStorageObj(storageObj, itemId) {
    if (!storageObj || !Array.isArray(storageObj.stacks)) return 0;
    let n = 0;
    for (const st of storageObj.stacks) {
      if (st && st.itemId === itemId) n += (st.qty || 0);
    }
    return n;
  }

function createShipment(state, loadedData, params) {
  ensureTravelShipmentsShape(state);

  const { fromTileId, toTileId, fromKey, toKey, itemId, qty, toMode } = params || {};
  const nQty = Math.max(1, Math.floor(Number(qty || 0)));

  if (!fromTileId || !toTileId) return { ok: false, reason: "Bad route." };
  if (!itemId || !nQty || nQty <= 0) return { ok: false, reason: "Bad quantity." };

  const fromEntries = listAreaStorages(state, loadedData, { tileId: fromTileId, includeRv: true });
  const from = fromEntries.find(e => e.key === fromKey) || fromEntries[0];
  if (!from || !from.storage) return { ok: false, reason: "Origin storage not found." };

  // verify availability
  const have = getItemQtyInStorageObj(from.storage, itemId);
  if (have < nQty) return { ok: false, reason: "Not enough items." };

  // IMPORTANT: removeStackFromStorageObj returns boolean (true/false)
  const removedOk = removeStackFromStorageObj(from.storage, loadedData, itemId, nQty);
  if (!removedOk) return { ok: false, reason: "Couldn't remove items." };

  const mapCfg = getMapCfg(loadedData);
  const baseMin = Number(mapCfg?.travel?.baseMinutesPerTile) || 60;
  const dist = Math.max(1, Math.floor(geohashGridDistance(fromTileId, toTileId) || 1));
  const minutes = Math.max(1, dist * baseMin);

  const tNow = gameNow(state);
  const id = `sh_${tNow}_${Math.floor(Math.random() * 1e6)}`;

  const s = {
    id,
    status: "in_transit",
    createdAt: tNow,
    etaAt: tNow + minutesToMs(minutes),
    fromTileId,
    toTileId,
    fromKey: from.key,
    toKey,
    payload: [{ itemId, qty: nQty }],
    toMode
  };

  state.world.shipments.push(s);

  const itemName =
    ((typeof getItemByIdSafe === "function")
      ? getItemByIdSafe(loadedData, itemId)
      : (loadedData?.idx?.itemsById?.get ? loadedData.idx.itemsById.get(itemId) : null)
    )?.name || itemId;

  pushLog(state, `Shipment sent: ${nQty}× ${itemName} (${fromTileId} → ${toTileId}), ETA ${minutes} min.`);
  safetySnapshot(state, loadedData);
  return { ok: true, shipment: s };
}

  function cancelShipment(state, loadedData, shipId, reason = "Shipment canceled.") {
  ensureTravelShipmentsShape(state);

  const s = state.world.shipments.find(x => x && x.id === shipId);
  if (!s || s.status !== "in_transit") return;

  const originEntries = listAreaStorages(state, loadedData, { tileId: s.fromTileId, includeRv: true });
  const origin = originEntries.find(e => e.key === s.fromKey) || originEntries[0];

  for (const p of (s.payload || [])) {
    if (!origin || !origin.storage) continue;

    const putBack = addStackToStorageObj(origin.storage, loadedData, p.itemId, p.qty);
    if (!putBack.ok) {
      const originSettlement = ensureSettlementForTile(state, loadedData, s.fromTileId);
      addStackToStorageObj(originSettlement.ground, loadedData, p.itemId, p.qty);
    }
  }

  s.status = "canceled";
  pushLog(state, reason);
  safetySnapshot(state);
}

  function openShipmentModal(state, loadedData, remoteTileId) {
    const activeTileId = getActiveTileId(state, loadedData);
    const remoteTile = getOrCreateTile(state, loadedData, remoteTileId);
    if (!tileHasMeaningfulSettlement(remoteTile)) {
      toast("No settlement here to trade with (yet).");
      return;
    }

    const caravanTile = getOrCreateTile(state, loadedData, activeTileId);
    const caravanHasSettlement = tileHasMeaningfulSettlement(caravanTile);

    const title = `Trade Goods — ${remoteTileId}`;
    const body = el("div", { class: "col", style: "gap:10px" });

    const modeRow = el("div", { class: "row" });
    const modeSel = el("select", { class: "select" });
    modeSel.appendChild(el("option", { value: "caravan_to_settlement" }, ["Send from Caravan → Settlement"]));
    modeSel.appendChild(el("option", { value: "settlement_to_caravan" }, ["Request from Settlement → Caravan"]));
    modeRow.appendChild(el("div", { class: "label" }, ["Direction"]));
    modeRow.appendChild(modeSel);

    const fromRow = el("div", { class: "row" });
    const fromSel = el("select", { class: "select" });
    const toRow = el("div", { class: "row" });
    const toSel = el("select", { class: "select" });

    const itemRow = el("div", { class: "row" });
    const itemSel = el("select", { class: "select" });
    const qtyRow = el("div", { class: "row" });
    const qtyInput = el("input", { class: "input", type: "number", min: "1", value: "1" });

    const note = el("div", { class: "muted", style: "font-size:12px" }, [
      "Shipments take time based on tile distance. ",
      caravanHasSettlement ? "Destination/source can be RV or your local settlement (choose below)." : "Destination/source will be RV (no local settlement on your current tile).",
      " If you move/check location while an INBOUND shipment is en route to this tile, it will be returned instead of delivered."
    ]);

    let closeModalFn = null;

   function fillEndpoints() {
  // Preserve selections before rebuilding (critical)
  const prevMode = modeSel.value;
  const prevFrom = fromSel.value;
  const prevTo = toSel.value;
  const prevItem = itemSel.value;

  // Rebuild options
  fromSel.innerHTML = "";
  toSel.innerHTML = "";
  itemSel.innerHTML = "";

  const mode = prevMode;

  const fromTileId = (mode === "caravan_to_settlement") ? activeTileId : remoteTileId;
  const toTileId   = (mode === "caravan_to_settlement") ? remoteTileId : activeTileId;

  // Endpoints:
  // - If endpoint is caravan tile: include RV + local settlement storages (if any)
  // - If endpoint is remote tile: settlement storages only (no RV)
  const fromEntriesFinal = (fromTileId === activeTileId)
    ? listAreaStorages(state, loadedData, { tileId: activeTileId, includeRv: true })
    : listAreaStorages(state, loadedData, { tileId: remoteTileId, includeRv: false });

  const toEntriesFinal = (toTileId === activeTileId)
    ? listAreaStorages(state, loadedData, { tileId: activeTileId, includeRv: true })
    : listAreaStorages(state, loadedData, { tileId: remoteTileId, includeRv: false });

  for (const e of (fromEntriesFinal || [])) {
    fromSel.appendChild(el("option", { value: e.key }, [e.label]));
  }
  for (const e of (toEntriesFinal || [])) {
    toSel.appendChild(el("option", { value: e.key }, [e.label]));
  }

  // Restore From/To selections if still valid
  const fromKey =
    (prevFrom && (fromEntriesFinal || []).some(e => e.key === prevFrom))
      ? prevFrom
      : ((fromEntriesFinal && fromEntriesFinal[0]) ? fromEntriesFinal[0].key : "");

  const toKey =
    (prevTo && (toEntriesFinal || []).some(e => e.key === prevTo))
      ? prevTo
      : ((toEntriesFinal && toEntriesFinal[0]) ? toEntriesFinal[0].key : "");

  if (fromKey) fromSel.value = fromKey;
  if (toKey) toSel.value = toKey;

  // items for chosen "from"
  const fromEntry = (fromEntriesFinal || []).find(e => e.key === fromSel.value) || (fromEntriesFinal || [])[0];
  const toEntry   = (toEntriesFinal || []).find(e => e.key === toSel.value) || (toEntriesFinal || [])[0];

  if (!fromEntry) return;

  // ---- build item list from "from" storage (supports stacks[] OR items{} maps) ----
// ---- build item list from "from" storage (robust + always visible) ----
itemSel.options.length = 0;

// Always add a visible placeholder first (so the dropdown is never a blank sliver)
itemSel.add(new Option("-- Select an item --", ""));

const s = fromEntry.storage || {};
let stacks = [];

// Primary shape used elsewhere in your codebase: { stacks: [{itemId, qty}, ...] }
if (Array.isArray(s.stacks)) {
  stacks = s.stacks;
} else {
  // Backup shapes (just in case)
  const map =
    (s.items && typeof s.items === "object" && !Array.isArray(s.items)) ? s.items :
    (s.contents && typeof s.contents === "object" && !Array.isArray(s.contents)) ? s.contents :
    (s.inv && typeof s.inv === "object" && !Array.isArray(s.inv)) ? s.inv :
    null;

  if (map) {
    stacks = Object.entries(map).map(([itemId, qty]) => ({ itemId, qty }));
  }
}

// Add items
for (const st of stacks) {
  const itemId = st?.itemId;
  const qty = Number(st?.qty ?? 0);
  if (!itemId || qty <= 0) continue;

  // Destination filter
  if (toEntry && typeof toEntry.accept === "function" && !toEntry.accept(itemId)) continue;

const it = (typeof getItemByIdSafe === "function")
  ? getItemByIdSafe(loadedData, itemId)
  : ((loadedData?.idx?.itemsById && loadedData.idx.itemsById[itemId]) ? loadedData.idx.itemsById[itemId] : null);
  const label = `${it?.name || itemId} (x${qty})`;
  itemSel.add(new Option(label, itemId));
}

// If there are no real items, replace placeholder with a clear message
if (itemSel.options.length === 1) {
  itemSel.options[0].text = "(No shippable items in this storage)";
}

// Restore item selection if still valid
if (prevItem) {
  const hasPrev = Array.from(itemSel.options).some(o => o.value === prevItem);
  if (hasPrev) itemSel.value = prevItem;
}


}

    modeSel.addEventListener("change", fillEndpoints);
    fromSel.addEventListener("change", fillEndpoints);
    toSel.addEventListener("change", fillEndpoints);

    fromRow.appendChild(el("div", { class: "label" }, ["From"]));
    fromRow.appendChild(fromSel);
    toRow.appendChild(el("div", { class: "label" }, ["To"]));
    toRow.appendChild(toSel);
    itemRow.appendChild(el("div", { class: "label" }, ["Item"]));
    itemRow.appendChild(itemSel);
    qtyRow.appendChild(el("div", { class: "label" }, ["Qty"]));
    qtyRow.appendChild(qtyInput);

    body.appendChild(modeRow);
    body.appendChild(fromRow);
    body.appendChild(toRow);
    body.appendChild(itemRow);
    body.appendChild(qtyRow);
    body.appendChild(note);

    const footer = el("div", { class: "modalFooter" });
    const btnCancel = el("button", { class: "btn ghost" }, ["Close"]);
    const btnSend = el("button", { class: "btn" }, ["Send Shipment"]);

    btnCancel.addEventListener("click", () => { if (closeModalFn) closeModalFn(); });
    btnSend.addEventListener("click", () => {
      const mode = modeSel.value;
      const itemId = itemSel.value;
      const qty = Math.max(1, Math.floor(Number(qtyInput.value || 1)));
      if (!itemId) return toast("No item selected.");

      const fromTileId = (mode === "caravan_to_settlement") ? activeTileId : remoteTileId;
      const toTileId = (mode === "caravan_to_settlement") ? remoteTileId : activeTileId;

      const fromKey = fromSel.value;
      const toKey = toSel.value;

      const toMode = (toTileId === activeTileId)
        ? { type: "caravan", expectedTileId: activeTileId }
        : { type: "tile" };

      const res = createShipment(state, loadedData, { fromTileId, toTileId, fromKey, toKey, itemId, qty, toMode });
      if (!res.ok) return toast(res.reason || "Couldn't create shipment.");

      if (closeModalFn) closeModalFn();
      renderAll(state, loadedData);
    });

    footer.append(btnCancel, btnSend);

    openModal(title, body, footer);

    function openModal(titleText, bodyEl, footerEl) {
      // Use existing modal overlay stack
      const overlay = el("div", { class: "modalOverlay" });
      const modal = el("div", { class: "modal" });

      const head = el("div", { class: "modalHeader" }, [
        el("div", { class: "modalTitle" }, [titleText]),
        el("button", { class: "btn ghost", style: "min-width: 70px" }, ["X"])
      ]);
      head.lastChild.addEventListener("click", () => closeModal());

      modal.appendChild(head);
      modal.appendChild(el("div", { class: "modalBody" }, [bodyEl]));
      if (footerEl) modal.appendChild(footerEl);

      overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      fillEndpoints();

      function closeModal() {
        overlay.remove();
      }
      closeModalFn = closeModal;
    }
  }

  function toggleMapOverlay(state, loadedData, ctx) {
    ensureTravelShipmentsShape(state);

    if (UI.mapOverlay) {
      UI.mapOverlay.remove();
      UI.mapOverlay = null;
      return;
    }

    // close settlement if open (keeps layer clean)
    if (UI.settlementOverlay) {
      UI.settlementOverlay.remove();
      UI.settlementOverlay = null;
    }

    const mapCfg = getMapCfg(loadedData);
    const minSize = Number(mapCfg?.view?.minSize) || 5;
    const maxSize = Number(mapCfg?.view?.maxSize) || 15;

    let viewSize = state.meta.mapViewSize || Number(mapCfg?.view?.size) || 5;
    viewSize = Math.max(minSize, Math.min(maxSize, Math.floor(viewSize)));
    if (viewSize % 2 === 0) viewSize += 1;

    const activeTileId = getActiveTileId(state, loadedData);
    let selected = activeTileId;

    UI.mapOverlay = el("div", { class: "mapOverlay" });
    const panel = el("div", { class: "mapPanel" });

    const header = el("div", { class: "mapHeader" });
    const leftHead = el("div", { class: "row", style: "gap:10px; align-items:center" }, [
      el("div", { class: "mapTitle" }, ["Map"]),
      el("div", { class: "muted", style: "font-size:12px" }, ["(click tiles to inspect / move / trade)"])
    ]);

    const controls = el("div", { class: "row", style: "gap:8px; align-items:center" });
    const btnMinus = el("button", { class: "btn ghost" }, ["−"]);
    const sizeLabel = el("div", { class: "muted", style: "min-width:62px; text-align:center; font-size:12px" }, [`${viewSize}×${viewSize}`]);
    const btnPlus = el("button", { class: "btn ghost" }, ["+"]);
    const btnClose = el("button", { class: "btn ghost" }, ["Close"]);

    controls.append(btnMinus, sizeLabel, btnPlus, btnClose);
    header.append(leftHead, controls);

    const body = el("div", { class: "mapBody" });
    const gridWrap = el("div", { class: "mapGridWrap" });
    const info = el("div", { class: "mapInfo" });

    function render() {
      sizeLabel.textContent = `${viewSize}×${viewSize}`;
      gridWrap.innerHTML = "";
      info.innerHTML = "";

      const tr = state.world.travel;
      if (tr && tr.active) {
        const msLeft = tr.endAt - gameNow(state);
        info.appendChild(el("div", { class: "card" }, [
          el("div", { class: "cardTitle" }, ["Caravan Traveling"]),
          el("div", { class: "muted" }, [`To: ${tr.toTileId}`]),
          el("div", { class: "muted" }, [`ETA: ${formatEtaMs(msLeft)}`])
        ]));
      }

      const r = Math.floor(viewSize / 2);
      const g0 = geohashToGridCoords(activeTileId);
      const precision = activeTileId.length;

      const grid = el("div", { class: "mapGrid" });
      grid.style.gridTemplateColumns = `repeat(${viewSize}, 72px)`;

      // rows: north at top (dy positive)
      for (let dy = r; dy >= -r; dy--) {
        for (let dx = -r; dx <= r; dx++) {
          const tileId = gridCoordsToGeohash(g0.x + dx, g0.y + dy, precision);
          const tile = state.world.discoveredTiles[tileId];
          const discovered = !!tile;
          const isCurrent = tileId === activeTileId;
          const isSelected = tileId === selected;

          let labelTop = discovered ? (String(tile.biomeId || "tile").toUpperCase().slice(0, 6)) : "????";
          let labelSub = `${dx},${dy}`;

          const cell = el("div", { class: "mapCell" + (discovered ? " discovered" : " unknown") + (isCurrent ? " current" : "") + ((tile && tileHasMeaningfulSettlement(tile)) ? " hasSettlement" : "") }, [
            el("div", { class: "mcTop" }, [labelTop]),
            el("div", { class: "mcSub" }, [labelSub])
          ]);

          if (isSelected) cell.style.outline = "2px solid rgba(255,255,255,0.35)";

          cell.addEventListener("click", () => {
            selected = tileId;
            render();
          });

          grid.appendChild(cell);
        }
      }

      gridWrap.appendChild(grid);

      // selected info
      const selTile = state.world.discoveredTiles[selected];
      const dist = geohashGridDistance(activeTileId, selected);

      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "cardTitle" }, [selected === activeTileId ? "Current Tile" : "Tile"]));
      card.appendChild(el("div", { class: "muted" }, [`ID: ${selected}`]));
      card.appendChild(el("div", { class: "muted" }, [`Distance: ${dist} tile(s)`]));

      if (selTile) {
        card.appendChild(el("div", { class: "muted" }, [`Biome: ${selTile.biomeId || "unknown"}`]));
        card.appendChild(el("div", { class: "muted" }, [`Danger: ${selTile.danger ?? 1} | Travel Mod: ${selTile.travelTimeMod ?? 1}`]));
      } else {
        card.appendChild(el("div", { class: "muted" }, ["Undiscovered (move adjacent or check location to discover)."]));
      }

      // action buttons
      const btnRow = el("div", { class: "row", style: "gap:10px; flex-wrap:wrap; margin-top:8px" });

      const inbound = getInboundShipmentsToCaravan(state, loadedData);
      const warnText = inbound.length ? `WARNING: ${inbound.length} inbound shipment(s) are en route to this tile. If you move/check location, they will be returned instead of delivered.` : null;

      function confirmIfInbound(fn) {
        if (!warnText) return fn();
        confirmModal("Inbound Shipment Warning", warnText).then(ok => { if (ok) fn(); });
      }

      if (selected !== activeTileId && (!state.world.travel.active)) {
        // adjacent move
        if (dist === 1) {
          const btnMove = el("button", { class: "btn" }, ["Move Caravan (1h)"]);
          btnMove.addEventListener("click", () => {
            confirmIfInbound(() => {
              const res = startCaravanTravel(state, loadedData, selected);
              if (!res.ok) toast(res.reason || "Can't move.");
              render();
              renderAll(state, loadedData);
            });
          });
          btnRow.appendChild(btnMove);
        }

        // fast travel to visited tiles
        if (selTile) {
          const btnFT = el("button", { class: "btn ghost" }, ["Fast Travel"]);
          btnFT.addEventListener("click", () => {
            confirmIfInbound(() => {
              if (state.world.travel.active) cancelCaravanTravel(state, loadedData, "Travel canceled due to fast travel.");
              state.meta.lastTileId = selected;
              getOrCreateTile(state, loadedData, selected);
              pushLog(state, `Fast traveled to ${selected}.`);
              safetySnapshot(state);
              renderAll(state, loadedData);
              render();
            });
          });
          btnRow.appendChild(btnFT);
        }
      }

      if (selTile) {
        const tile = getOrCreateTile(state, loadedData, selected);
        const hasSettle = tileHasMeaningfulSettlement(tile);

        const btnManage = el("button", { class: "btn ghost" }, ["Manage Settlement"]);
        btnManage.addEventListener("click", () => {
          // open settlement overlay for this tile
          const ctx2 = Object.assign({}, ctx || {}, { tileIdOverride: selected });
          toggleMapOverlay(state, loadedData, ctx);
          toggleSettlementOverlay(state, loadedData, ctx2);
        });
        btnRow.appendChild(btnManage);

        if (hasSettle) {
          const btnTrade = el("button", { class: "btn" }, ["Trade Goods"]);
          btnTrade.addEventListener("click", () => openShipmentModal(state, loadedData, selected));
          btnRow.appendChild(btnTrade);
        }
      }

      if (warnText) {
        card.appendChild(el("div", { class: "badge warn", style: "margin-top:8px" }, [warnText]));
      }

      card.appendChild(btnRow);
      info.appendChild(card);

      // shipments list
      const shipCard = el("div", { class: "card" });
      shipCard.appendChild(el("div", { class: "cardTitle" }, ["Shipments En Route"]));

      const list = el("div", { class: "mapShipList" });
      const tNow = gameNow(state);

      const active = state.world.shipments.filter(s => s && s.status === "in_transit");
      if (!active.length) {
        list.appendChild(el("div", { class: "muted" }, ["(none)"]));
      } else {
        for (const s of active) {
          const msLeft = s.etaAt - tNow;
          const row = el("div", { class: "shipRow" });
          row.appendChild(el("div", { class: "shipRowTop" }, [
            el("div", {}, [`${s.fromTileId} → ${s.toTileId}`]),
            el("div", { class: "muted" }, [`ETA ${formatEtaMs(msLeft)}`])
          ]));

          const p = (s.payload && s.payload[0]) ? s.payload[0] : null;
          const itemName = p ? (getItemById(loadedData, p.itemId)?.name || p.itemId) : "items";
          row.appendChild(el("div", { class: "shipRowSub" }, [`${p ? `${p.qty}× ${itemName}` : ""}  •  to: ${s.toMode?.type === "caravan" ? "caravan" : "settlement"}`]));

          const btns = el("div", { class: "row", style: "gap:8px; justify-content:flex-end" });
          const btnCancelShip = el("button", { class: "btn ghost" }, ["Cancel"]);
          btnCancelShip.addEventListener("click", () => {
            cancelShipment(state, loadedData, s.id, "Shipment canceled and returned to origin.");
            renderAll(state, loadedData);
            render();
          });
          btns.appendChild(btnCancelShip);
          row.appendChild(btns);

          list.appendChild(row);
        }
      }

      shipCard.appendChild(list);
      info.appendChild(shipCard);
    }

    btnClose.addEventListener("click", () => toggleMapOverlay(state, loadedData, ctx));
    btnMinus.addEventListener("click", () => {
      viewSize = Math.max(minSize, viewSize - 2);
      state.meta.mapViewSize = viewSize;
      safetySnapshot(state);
      render();
    });
    btnPlus.addEventListener("click", () => {
      viewSize = Math.min(maxSize, viewSize + 2);
      state.meta.mapViewSize = viewSize;
      safetySnapshot(state);
      render();
    });

    // click outside closes
    UI.mapOverlay.addEventListener("click", (e) => {
      if (e.target === UI.mapOverlay) toggleMapOverlay(state, loadedData, ctx);
    });

    panel.append(header, body);
    body.append(gridWrap, info);
    UI.mapOverlay.appendChild(panel);
    document.body.appendChild(UI.mapOverlay);

    render();
  }

function toggleAdminOverlay(state, loadedData, ctx) {
    if (UI.adminOverlay) {
      UI.adminOverlay.remove();
      UI.adminOverlay = null;
      return;
    }

    UI.adminOverlay = el("div", { class: "adminOverlay" });
    UI.adminOverlay.addEventListener("click", (e) => { if (e.target === UI.adminOverlay) toggleAdminOverlay(state, loadedData, ctx); });
    const panel = el("div", { class: "adminPanel" });
    const titleRow = el("div", { class: "row" });
    titleRow.appendChild(el("div", { class: "adminTitle" }, ["Admin Panel"]));
    const btnClose = el("button", {
      class: "btn ghost",
      onclick: () => toggleAdminOverlay(state, loadedData, ctx)
    }, ["Close"]);
    titleRow.appendChild(btnClose);
    panel.appendChild(titleRow);

    const unlocked = isAdminUnlocked();
    const lockRow = el("div", { class: "row" });

    if (!unlocked) {
      const pass = el("input", { class: "input", placeholder: "Passphrase" });
      const btnUnlock = el("button", {
        class: "btn",
        onclick: () => {
          const want = (loadedData.data.config.adminPassphrase || "ROVER").toUpperCase();
          if ((pass.value || "").trim().toUpperCase() === want) {
            setAdminUnlocked(true);
            toast("Admin unlocked.");
            toggleAdminOverlay(state, loadedData, ctx);
            toggleAdminOverlay(state, loadedData, ctx);
          } else toast("Wrong passphrase.");
        }
      }, ["Unlock"]);
      lockRow.append(pass, btnUnlock);
      panel.appendChild(lockRow);
    } else {
      const btnLock = el("button", { class: "btn ghost", onclick: () => { setAdminUnlocked(false); toast("Admin locked."); toggleAdminOverlay(state, loadedData, ctx); } }, ["Lock"]);
      panel.appendChild(btnLock);

      panel.appendChild(el("div", { class: "divider" }));

      // Time controls
      panel.appendChild(el("div", { class: "smallLabel" }, ["Time Controls"]));
      const rowT = el("div", { class: "row" });
      rowT.append(
        el("button", { class: "btn ghost", onclick: () => { addSimTime(state, 10 * 60 * 1000); ctx.simulateAndRender(); } }, ["+10m"]),
        el("button", { class: "btn ghost", onclick: () => { addSimTime(state, 60 * 60 * 1000); ctx.simulateAndRender(); } }, ["+1h"]),
        el("button", { class: "btn ghost", onclick: () => { addSimTime(state, 24 * 60 * 60 * 1000); ctx.simulateAndRender(); } }, ["+1d"]),
        el("button", { class: "btn", onclick: () => { resetSimTimeToReal(state); ctx.simulateAndRender(); } }, ["Reset to Real"])
      );
      panel.appendChild(rowT);

      // Day/Night toggle
      const dnRow = el("div", { class: "row" });
      const chk = el("input", { type: "checkbox" });
      chk.checked = !!state.meta.useSimTimeForDayNight;
      chk.addEventListener("change", () => {
        state.meta.useSimTimeForDayNight = chk.checked;
        safetySnapshot(state, loadedData);
        ctx.simulateAndRender();
      });
      dnRow.append(el("div", { class: "smallLabel" }, ["Use Sim Time for Day/Night: "]), chk);
      panel.appendChild(dnRow);

      const rowMid = el("div", { class: "row" });
      rowMid.append(
        el("button", {
          class: "btn ghost",
          onclick: () => {
            // Jump sim time to next local midnight based on current sim clock
            const t = gameNow(state);
            const d = new Date(t);
            const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
            addSimTime(state, next - t);
            ctx.simulateAndRender();
          }
        }, ["Jump to Midnight"]),
        el("button", {
          class: "btn ghost",
          onclick: () => {
            // Fast-forward to next completion among jobs+crafts
            const t = gameNow(state);
            let next = null;

            for (const q of Object.values(state.queues.jobsByCharId)) {
              if (!q || q.length === 0) continue;
              const first = q[0];
              if (first.startAt == null) continue;
              next = next == null ? (first.startAt + first.durationMs) : Math.min(next, first.startAt + first.durationMs);
            }
            for (const q of Object.values(state.queues.craftsByStationId)) {
              if (!q || q.length === 0) continue;
              const first = q[0];
              if (first.startAt == null) continue;
              next = next == null ? (first.startAt + first.durationMs) : Math.min(next, first.startAt + first.durationMs);
            }
            if (next == null || next <= t) {
              toast("No active timers.");
              return;
            }
            addSimTime(state, next - t);
            ctx.simulateAndRender();
          }
        }, ["To Next Completion"])
      );
      panel.appendChild(rowMid);

      panel.appendChild(el("div", { class: "divider" }));

      // Item spawner
      panel.appendChild(el("div", { class: "smallLabel" }, ["Spawn Items"]));
      const items = loadedData.data.items.slice().sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      const selItem = el("select", { class: "select" });
      for (const it of items) selItem.appendChild(el("option", { value: it.id }, [it.name || it.id]));
      const qtyInp = el("input", { class: "input", type: "number", value: "5", min: "1", style: "max-width:90px" });
      const btnAdd = el("button", {
        class: "btn",
        onclick: () => {
          const id = selItem.value;
          const q = Math.max(1, parseInt(qtyInp.value || "1", 10));
          const res = addItemToStorage(state, loadedData, id, q, { rationAllowed: true });
          if (!res.ok) toast(res.reason);
          else {
            pushLog(state, `ADMIN: added ${q}× ${loadedData.idx.itemsById.get(id)?.name ?? id}.`, "system", null, loadedData);
            safetySnapshot(state, loadedData);
            ctx.simulateAndRender();
          }
        }
      }, ["Add"]);
      panel.appendChild(el("div", { class: "row" }, [selItem, qtyInp, btnAdd]));

            // Heal/cure
      panel.appendChild(el("div", { class: "smallLabel" }, ["Crew Tools"]));

      // Build an NPC dropdown from npcs.json (or fallback list if JSON missing)
      const npcs = (loadedData.data.npcs || []).slice().sort((a, b) =>
        (a.name || a.id).localeCompare(b.name || b.id)
      );

      const selNpc = el("select", { class: "select" });
      for (const n of npcs) selNpc.appendChild(el("option", { value: n.id }, [n.name || n.id]));

      // Default selection if medic exists
      if (npcs.some(n => n.id === "npc_medic")) selNpc.value = "npc_medic";

      const btnHeal = el("button", {
        class: "btn ghost",
        onclick: () => {
          for (const c of state.crew.members) {
            c.needs.health = 100;
            c.conditions.sickness = null;
            c.conditions.injury = null;
            c.conditions.downed = false;
          }
          pushLog(state, "ADMIN: healed and cured crew.", "system", null, loadedData);
          safetySnapshot(state, loadedData);
          ctx.simulateAndRender();
        }
      }, ["Heal/Cure All"]);

      const btnSpawnNpc = el("button", {
        class: "btn ghost",
        onclick: () => {
          const id = selNpc.value;
          const res = recruitNpcFromTemplate(state, loadedData, id);

          if (!res || res.ok === false) {
            toast(res?.reason || "Could not recruit NPC.");
            return;
          }

          pushLog(
            state,
            `ADMIN: recruited ${loadedData.idx.npcsById.get(id)?.name ?? id}.`,
            "system",
            null,
            loadedData
          );
          safetySnapshot(state, loadedData);
          ctx.simulateAndRender();
        }
      }, ["Spawn NPC"]);

      const rowHC = el("div", { class: "row" });
      rowHC.append(btnHeal, selNpc, btnSpawnNpc);
      panel.appendChild(rowHC);

      // Save export/import
      panel.appendChild(el("div", { class: "divider" }));
      panel.appendChild(el("div", { class: "smallLabel" }, ["Save Tools"]));

      const rowSI = el("div", { class: "row" });
      rowSI.append(
        el("button", {
          class: "btn ghost",
          onclick: async () => {
            const txt = JSON.stringify(state);
            try {
              await navigator.clipboard.writeText(txt);
              toast("Save JSON copied to clipboard.");
            } catch {
              toast("Clipboard failed. Open DevTools to copy manually.");
              console.log("SAVE JSON:", txt);
            }
          }
        }, ["Copy Save JSON"]),
        el("button", {
          class: "btn ghost",
          onclick: async () => {
            const txt = await inputModal("Import Save JSON", "Paste JSON:", "", "");
            if (!txt) return;
            const parsed = safeJsonParse(txt, null);
            if (!parsed) return toast("Invalid JSON.");
            ctx.replaceState(parsed);
            toast("Imported.");
            toggleAdminOverlay(state, loadedData, ctx);
          }
        }, ["Import JSON"])
      );
      panel.appendChild(rowSI);

      // Tile override
      panel.appendChild(el("div", { class: "divider" }));
      panel.appendChild(el("div", { class: "smallLabel" }, ["Tile Tools"]));
      const rowTile = el("div", { class: "row" });
      rowTile.append(
        el("button", {
          class: "btn ghost",
          onclick: async () => {
            const val = await inputModal("Set TileId", "Enter geohash tileId:", "e.g. 9q8yyz1", state.meta.lastTileId || "");
            if (!val) return;
            state.meta.lastTileId = val;
            getOrCreateTile(state, loadedData, val);
            pushLog(state, `ADMIN: moved to tile ${val}.`, "system", null, loadedData);
            safetySnapshot(state, loadedData);
            ctx.simulateAndRender();
          }
        }, ["Set TileId (Debug)"])
      );
      panel.appendChild(rowTile);
    }

    UI.adminOverlay.appendChild(panel);
    UI.adminOverlay.addEventListener("click", (e) => {
      if (e.target === UI.adminOverlay) toggleAdminOverlay(state, loadedData, ctx);
    });
    document.body.appendChild(UI.adminOverlay);
  }

  /* =========================
     Main App Controller
  ========================= */
  async function boot() {
    buildUiShell();

   const loadedData = await loadData();
window.loadedData = loadedData; // DEBUG: allow console inspection
if (loadedData.usedFallback) {
  pushGlobalBanner("Using fallback data (JSON files not found yet). This is OK for v0.1 coding order.");
} else {
  pushGlobalBanner("Loaded JSON data successfully.");
}

// State management
let state = null;

const ctx = {
  activeSaveId: store.getItem(LS_LAST_ACTIVE_SAVE_KEY) || null,

  replaceState(newState) {
    state = newState;
    window.state = state; // DEBUG: allow console inspection
    // Ensure derived structures exist for new versions
    if (!state.queues) state.queues = { jobsByCharId: {}, craftsByStationId: {} };
    if (!state.queues.jobsByCharId) state.queues.jobsByCharId = {};
    if (!state.queues.craftsByStationId) state.queues.craftsByStationId = {};
    if (!state.world) state.world = { discoveredTiles: {} };
    if (!state.world.discoveredTiles) state.world.discoveredTiles = {};
    // Back-compat for older builds that used state.time.ticks
    if (!state.time) state.time = { ticks: 0 };
    if (typeof state.time.ticks !== "number") state.time.ticks = 0;
    if (!state.rv?.storage) {
      state.rv = state.rv || {};
      state.rv.storage = { capacity: 0, stacks: [], instances: [] };
    }
    if (!state.meta) state.meta = { lastSimAt: gameNow(state), timeOffsetMs: 0 };
    if (!state.log) state.log = [];
    recomputeDerivedStats(state, loadedData);
    simulateToNow(state, loadedData);
    renderAll(state, loadedData);
  },


      loadSaveId(id) {
        const s = getSaveSlot(id);
        if (!s) return toast("Save not found.");
        this.activeSaveId = id;
        store.setItem(LS_LAST_ACTIVE_SAVE_KEY, id);
        this.replaceState(deepCopy(s.state));
        toast(`Loaded: ${s.name}`);
      },

      simulateAndRender() {
        simulateToNow(state, loadedData);
        renderAll(state, loadedData);
      }
    };

    // If there is a last active save, load it; else new game.
    const lastId = ctx.activeSaveId;
    if (lastId && getSaveSlot(lastId)) {
      ctx.loadSaveId(lastId);
    } else {
      state = defaultNewGameState(loadedData);
      safetySnapshot(state, loadedData);
      ctx.replaceState(state);
      toast("New run started. Create a save when you're ready.");
    }

    // Wire buttons
    UI.btnCheckLocation.addEventListener("click", async () => {
      try {
        toast("Checking location…", 1200);
        const pos = await getGpsPosition();
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        state.meta.lastKnownLat = lat;
        state.meta.lastKnownLon = lon;

        const prec = loadedData.data.config.tilePrecision || 7;
        const tileId = geohashEncode(lat, lon, prec);

        // v0.4: travel/shipment safety checks
        ensureTravelShipmentsShape(state);
        const inbound = getInboundShipmentsToCaravan(state, loadedData);
        if (state.world.travel && state.world.travel.active) {
          const ok = await confirmModal("Travel In Progress", "The caravan is currently traveling. Checking location will cancel travel and relocate instantly. Continue?");
          if (!ok) return;
          cancelCaravanTravel(state, loadedData, "Travel canceled due to location check.");
        }
        if (inbound.length) {
          const ok2 = await confirmModal("Inbound Shipment Warning", `You have ${inbound.length} inbound shipment(s) en route to this tile. If you relocate now, they will be returned instead of delivered. Continue?`);
          if (!ok2) return;
        }

        
        state.meta.lastTileId = tileId;

        const tile = getOrCreateTile(state, loadedData, tileId);
        const biome = biomeForTile(loadedData, tile);

        pushLog(state, `Entered tile ${tileId} (${biome.name}).`, "system", null, loadedData);
        safetySnapshot(state, loadedData);

        ctx.simulateAndRender();
      } catch (e) {
        console.error(e);
        // Fallback: if GPS is denied/unavailable, drop the player into a deterministic default tile
        // so the game remains playable without location permission.
        const prec = loadedData.data.config.tilePrecision || 7;
        const fallbackTileId = state.meta.lastTileId || geohashEncode(0, 0, prec);
        state.meta.lastKnownLat = state.meta.lastKnownLat ?? 0;
        state.meta.lastKnownLon = state.meta.lastKnownLon ?? 0;
        state.meta.lastTileId = fallbackTileId;
        const tile = getOrCreateTile(state, loadedData, fallbackTileId);
        const biome = biomeForTile(loadedData, tile);
        pushLog(state, `Location unavailable — using default tile ${fallbackTileId} (${biome.name}).`, "warn", null, loadedData);
        safetySnapshot(state, loadedData);
        ctx.simulateAndRender();
        toast("Location unavailable — using default tile.");
      }
    });

    UI.btnActions.addEventListener("click", () => showPanel("Actions", panelActions(state, loadedData)));
    UI.btnCrafting.addEventListener("click", () => showPanel("Crafting", panelCrafting(state, loadedData)));
    UI.btnCrew.addEventListener("click", () => showPanel("Crew", panelCrew(state, loadedData)));
    UI.btnStorage.addEventListener("click", () => showPanel("Storage", panelStorage(state, loadedData)));
    UI.btnStations.addEventListener("click", () => showPanel("Stations", panelStations(state, loadedData)));
    UI.btnSaves.addEventListener("click", () => showPanel("Saves", panelSaves(state, loadedData, ctx)));
    UI.btnSettlement.addEventListener("click", () => toggleSettlementOverlay(state, loadedData, ctx));
    UI.btnMap.addEventListener("click", () => toggleMapOverlay(state, loadedData, ctx));
    UI.btnAdmin.addEventListener("click", () => toggleAdminOverlay(state, loadedData, ctx));

    // Keyboard: ~ toggles admin overlay
    window.addEventListener("keydown", (e) => {
      // Backtick key toggles admin panel (works for ~ too)
      if (e.key === "`" || e.key === "~") {
        e.preventDefault();
        toggleAdminOverlay(state, loadedData, ctx);
      }
      // ESC closes side panel
      if (e.key === "Escape") {
        hidePanel();
      }
    });

    // Periodic simulation tick while open
    setInterval(() => {
      if (!state) return;
      simulateToNow(state, loadedData);
      renderAll(state, loadedData);
    }, 1000);

    // Before unload: safety snapshot to avoid loss
    window.addEventListener("beforeunload", () => {
      if (!state) return;
      state.meta.lastSimAt = gameNow(state);
      safetySnapshot(state, loadedData);
    });

    renderAll(state, loadedData);
  }

  function pushGlobalBanner(msg) {
    const b = el("div", { class: "banner" }, [msg]);
    document.body.appendChild(b);
    setTimeout(() => b.classList.add("show"), 50);
    setTimeout(() => b.classList.remove("show"), 6000);
    setTimeout(() => b.remove(), 6500);
  }

  // Start once DOM ready
  window.addEventListener("DOMContentLoaded", boot);
})();


/* ============================================================
   SHIPMENT OVERRIDES v0.4.1
   Fixes: items not removed/added due to wrong arg order / return handling.
   Safe: function declarations override earlier duplicates.
============================================================ */

function createShipment(state, loadedData, params) {
  ensureTravelShipmentsShape(state);

  const {
    fromTileId, toTileId, fromKey, toKey,
    itemId, qty,
    toMode
  } = params || {};

  if (!fromTileId || !toTileId) return { ok: false, reason: "Bad route." };
  const nQty = Math.max(1, Math.floor(Number(qty || 0)));
  if (!itemId || !nQty) return { ok: false, reason: "Bad quantity." };

  const fromEntries = listAreaStorages(state, loadedData, { tileId: fromTileId, includeRv: true });
  const from = fromEntries.find(e => e.key === fromKey) || fromEntries[0];
  if (!from) return { ok: false, reason: "Origin storage not found." };

  // verify availability
  const have = getItemQtyInStorageObj(from.storage, itemId);
  if (have < nQty) return { ok: false, reason: "Not enough items." };

  // remove from origin NOW (items are in transit)
  const removedOk = removeStackFromStorageObj(from.storage, loadedData, itemId, nQty);
  if (!removedOk) return { ok: false, reason: "Couldn't remove items." };

  const mapCfg = getMapCfg(loadedData);
  const baseMin = Number(mapCfg?.travel?.baseMinutesPerTile) || 60;
  const dist = Math.max(1, Math.floor(geohashGridDistance(fromTileId, toTileId) || 1));
  const minutes = Math.max(1, dist * baseMin);

  const tNow = gameNow(state);
  const id = `sh_${tNow}_${Math.floor(Math.random() * 1e6)}`;

  const s = {
    id,
    status: "in_transit",
    createdAt: tNow,
    etaAt: tNow + minutesToMs(minutes),
    fromTileId,
    toTileId,
    fromKey: from.key,
    toKey: toKey || "rv",
    payload: [{ itemId, qty: nQty }],
    toMode
  };

  state.world.shipments.push(s);

  const it = loadedData?.idx?.itemsById?.get(itemId);
  const itemName = it?.name || itemId;
  pushLog(state, `Shipment sent: ${nQty}× ${itemName} (${fromTileId} → ${toTileId}), ETA ${minutes} min.`);
  safetySnapshot(state);
  return { ok: true, shipment: s };
}

function cancelShipment(state, loadedData, shipId, reason = "Shipment canceled.") {
  ensureTravelShipmentsShape(state);
  const s = state.world.shipments.find(x => x && x.id === shipId);
  if (!s || s.status !== "in_transit") return;

  const originTile = getOrCreateTile(state, loadedData, s.fromTileId);
  ensureSettlementForTile(state, loadedData, s.fromTileId);

  const originEntries = listAreaStorages(state, loadedData, { tileId: s.fromTileId, includeRv: true });
  const origin = originEntries.find(e => e.key === s.fromKey) || originEntries[0];

  if (origin) {
    for (const p of (s.payload || [])) {
      const r = addStackToStorageObj(origin.storage, loadedData, p.itemId, p.qty);
      if (!r.ok) {
        const g = originTile.settlement?.ground;
        if (g) addStackToStorageObj(g, loadedData, p.itemId, p.qty);
      }
    }
  }

  s.status = "canceled";
  pushLog(state, reason);
  safetySnapshot(state);
}

function simulateShipmentsToNow(state, loadedData, tNow) {
  ensureTravelShipmentsShape(state);

  const shipments = state.world.shipments;
  if (!shipments.length) return;

  for (const s of shipments) {
    if (!s || s.status !== "in_transit") continue;
    if (tNow < (s.etaAt || 0)) continue;

    // Ensure settlements exist for ground overflow handling
    const originTile = getOrCreateTile(state, loadedData, s.fromTileId);
    ensureSettlementForTile(state, loadedData, s.fromTileId);

    // deliver or bounce (caravan moved)
    if (s.toMode && s.toMode.type === "caravan") {
      const activeTileId = getActiveTileId(state, loadedData);
      if (activeTileId !== s.toMode.expectedTileId) {
        const originEntries = listAreaStorages(state, loadedData, { tileId: s.fromTileId, includeRv: true });
        const origin = originEntries.find(e => e.key === s.fromKey) || originEntries[0];
        if (origin) {
          for (const p of (s.payload || [])) {
            const r = addStackToStorageObj(origin.storage, loadedData, p.itemId, p.qty);
            if (!r.ok) {
              const g = originTile.settlement?.ground;
              if (g) addStackToStorageObj(g, loadedData, p.itemId, p.qty);
            }
          }
        }
        s.status = "returned";
        pushLog(state, "Shipment to caravan was returned to origin (caravan moved).");
        continue;
      }
    }

    // normal delivery
    const destTile = getOrCreateTile(state, loadedData, s.toTileId);
    ensureSettlementForTile(state, loadedData, s.toTileId);

    const includeRv = (s.toMode?.type === "caravan");
    const destEntries = listAreaStorages(state, loadedData, { tileId: s.toTileId, includeRv });
    const dest = destEntries.find(e => e.key === s.toKey) || destEntries[0];

    if (dest) {
      for (const p of (s.payload || [])) {
        const r = addStackToStorageObj(dest.storage, loadedData, p.itemId, p.qty);
        if (!r.ok) {
          // overflow to ground at destination
          const g = destTile.settlement?.ground;
          if (g) addStackToStorageObj(g, loadedData, p.itemId, p.qty);
        }
      }
    } else {
      // If no destination storage could be found, drop on ground.
      const g = destTile.settlement?.ground;
      for (const p of (s.payload || [])) if (g) addStackToStorageObj(g, loadedData, p.itemId, p.qty);
    }

    s.status = "delivered";
    pushLog(state, `Shipment delivered to ${s.toMode?.type === "caravan" ? "caravan" : "settlement"} (${s.toTileId}).`);
  }
}

