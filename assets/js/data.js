const REMOTE_CFG_KEY = "hyrox_epicure_remote_cfg_v1";
const DEFAULT_SUPABASE_URL = "https://exxbcrbafrzkhcvwkffg.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_TiwXEH-JopQejQ0I04r9MQ_ieo5y9Ko";
const DEFAULT_PROJECT_REF = "hyrox-epicure-2026";
const COMPETITION_QUERY_KEY = "comp";
/** Mémorise le dernier `comp` vu en URL (onglet) pour relier la navigation even si un lien a perdu le paramètre. */
const COMP_CONTEXT_SESSION_KEY = "hyrox_epicure_comp_context_v1";
const AUTO_PUSH_DELAY_MS = 1200;
let autoPushTimer = null;
let cloudReady = false;
let cloudInitPromise = null;
let stateCache = null;

/** Open / Pro (valeurs d’héritage inconnues → Open). */
function normalizeCategory(cat) {
  const c = cat || "Open";
  if (c === "Lite") return "Open";
  if (c === "Pro") return "Pro";
  return "Open";
}

/** Formats d’inscription Hyrox : solo, duo même sexe, mixte (charges Open homme, pas de Pro). */
const TEAM_FORMAT_SOLO = "Solo";
const TEAM_FORMAT_DUO_H = "DuoH";
const TEAM_FORMAT_DUO_F = "DuoF";
const TEAM_FORMAT_MIXTE = "Mixte";

function getTeamFormat(team) {
  if (!team) return TEAM_FORMAT_SOLO;
  const tf = team.teamFormat;
  if (tf === TEAM_FORMAT_DUO_H || tf === TEAM_FORMAT_DUO_F || tf === TEAM_FORMAT_MIXTE || tf === TEAM_FORMAT_SOLO) {
    return tf;
  }
  if (team.gender === "Mixte") return TEAM_FORMAT_MIXTE;
  return TEAM_FORMAT_SOLO;
}

function effectiveCategory(team) {
  if (getTeamFormat(team) === TEAM_FORMAT_MIXTE) return "Open";
  return normalizeCategory(team && team.category);
}

/** Clé unique pour classement, drag, heats (Open/Pro + format + sexe si solo). */
function rankGroupKey(team) {
  const f = getTeamFormat(team);
  const c = effectiveCategory(team);
  if (f === TEAM_FORMAT_SOLO) return `${c}|Solo|${(team && team.gender) || ""}`;
  if (f === TEAM_FORMAT_DUO_H) return `${c}|DuoH`;
  if (f === TEAM_FORMAT_DUO_F) return `${c}|DuoF`;
  return "Open|Mixte";
}

/**
 * Ordre personnalisé des catégories pour les heats / affichage.
 * Tableau de clés `rankGroupKey` sans doublon, ou `null` si absent / invalide → ordre implicite.
 */
function normalizeRankGroupHeatOrder(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set();
  const out = [];
  for (const k of raw) {
    const s = String(k || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length ? out : null;
}

/** Libellé court pour affichage (TV, scores, portail). */
function formatTeamDivisionLine(team) {
  if (!team) return "—";
  const f = getTeamFormat(team);
  const c = effectiveCategory(team);
  if (f === TEAM_FORMAT_SOLO) return `${c} · ${team.gender || "—"}`;
  if (f === TEAM_FORMAT_DUO_H) return `${c} · Duo hommes`;
  if (f === TEAM_FORMAT_DUO_F) return `${c} · Duo femmes`;
  return "Open · Mixte";
}

/** Nom affiché : athlète 1, ou « A / B » en Double / Mixte (cf. fiche Hyrox France). */
function formatTeamDisplayName(team) {
  if (!team) return "—";
  const p1 = `${(team.lastName || "").trim()} ${(team.firstName || "").trim()}`.trim();
  if (getTeamFormat(team) === TEAM_FORMAT_SOLO) return p1 || (team.name || "—");
  const p2 = `${(team.partnerLastName || "").trim()} ${(team.partnerFirstName || "").trim()}`.trim();
  if (p1 && p2) return `${p1} / ${p2}`;
  return p1 || p2 || (team.name || "—");
}

function buildTeamName(t) {
  return formatTeamDisplayName(t);
}

function normalizeTeamFormatFields(team) {
  const t = { ...team };
  const validFmt = [TEAM_FORMAT_SOLO, TEAM_FORMAT_DUO_H, TEAM_FORMAT_DUO_F, TEAM_FORMAT_MIXTE];
  let tf = t.teamFormat;
  if (!validFmt.includes(tf)) {
    tf = t.gender === "Mixte" ? TEAM_FORMAT_MIXTE : TEAM_FORMAT_SOLO;
  }
  t.teamFormat = tf;
  if (t.teamFormat === TEAM_FORMAT_MIXTE) {
    t.gender = "";
    t.category = "Open";
  } else if (t.teamFormat !== TEAM_FORMAT_SOLO) {
    t.gender = "";
  } else if (t.gender === "Mixte") {
    t.teamFormat = TEAM_FORMAT_MIXTE;
    t.gender = "";
    t.category = "Open";
  }
  t.category = normalizeCategory(t.category);
  if (t.teamFormat === TEAM_FORMAT_MIXTE) t.category = "Open";
  if (t.teamFormat === TEAM_FORMAT_SOLO) {
    t.partnerLastName = "";
    t.partnerFirstName = "";
  }
  return t;
}

const defaultState = {
  config: {
    competitionName: "Hyrox Epicure",
    location: "Epicure",
    date: "",
    startTime: "08:00",
    /** Minutes d’échauffement avant le départ du heat (planning, pas un créneau « après départ »). */
    warmupMinutes: 30,
    /**
     * Fenêtre affichage TV (barre 16 seg., fin « en course ») et planning/ops
     * lorsqu’aucun créneau n’est défini après l’heure de départ du heat.
     */
    estimatedParcoursMinutes: 90,
    heatIntervalMinutes: 20,
    athletesPerHeat: 2,
    metconStaggerMinutes: 0,
    /**
     * Ordre de passage des catégories (clés `rankGroupKey`) pour heats, planning, blocs classement/TV.
     * `null` ou tableau vide → règles implicites (Open/Pro, solo, duos…).
     */
    rankGroupHeatOrder: null,
  },
  teams: [],
  /** Aucun créneau club après le départ : l’échauffement est uniquement `config.warmupMinutes` avant le heat. */
  events: [],
  scores: [],
  /** Heures d’arrivée / départ par segment (Hyrox 16 segments) : { [teamId]: { segments: [{ arr, dep }, ...] } } */
  hyroxPassages: {},
  news: [],
  updatedAt: null,
};

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadState() {
  if (!stateCache) return structuredClone(defaultState);
  return structuredClone(stateCache);
}

function saveState(nextState) {
  const value = {
    ...nextState,
    updatedAt: new Date().toISOString(),
  };
  stateCache = normalizeState(value);
  scheduleAutoPush(value);
  return structuredClone(stateCache);
}

function getRemoteConfig() {
  const urlRef = getEffectiveCompetitionRef();
  try {
    const raw = localStorage.getItem(REMOTE_CFG_KEY);
    if (!raw) {
      return {
        provider: "supabase",
        url: DEFAULT_SUPABASE_URL,
        anonKey: DEFAULT_SUPABASE_ANON_KEY,
        projectRef: urlRef || DEFAULT_PROJECT_REF,
        autoSync: true,
      };
    }
    return {
      provider: "supabase",
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_ANON_KEY,
      projectRef: urlRef || DEFAULT_PROJECT_REF,
      autoSync: true,
      ...JSON.parse(raw),
      // URL ou session (getEffective) impose la compétition cloud.
      ...(urlRef ? { projectRef: urlRef } : {}),
    };
  } catch {
    return {
      provider: "supabase",
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_ANON_KEY,
      projectRef: urlRef || DEFAULT_PROJECT_REF,
      autoSync: true,
    };
  }
}

function setRemoteConfig(cfg) {
  const urlRef = getEffectiveCompetitionRef();
  const next = {
    provider: "supabase",
    url: String(cfg.url || DEFAULT_SUPABASE_URL).trim(),
    anonKey: String(cfg.anonKey || DEFAULT_SUPABASE_ANON_KEY).trim(),
    projectRef: String(urlRef || cfg.projectRef || DEFAULT_PROJECT_REF).trim() || DEFAULT_PROJECT_REF,
    autoSync: cfg.autoSync !== false,
  };
  localStorage.setItem(REMOTE_CFG_KEY, JSON.stringify(next));
  return next;
}

function sanitizeCompetitionRef(value) {
  const raw = String(value || "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe || DEFAULT_PROJECT_REF;
}

/** true si l’id Supabase relève à cette appli (préfixe `hyrox-` / `hyrox_`, pour filtrer d’autres jeux de données sur la même table). */
function isHyroxCompetitionId(id) {
  return /^hyrox[-_]/i.test(String(id || "").trim());
}

function getCompetitionRefFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const ref = params.get(COMPETITION_QUERY_KEY);
    if (!ref) return "";
    return sanitizeCompetitionRef(ref);
  } catch {
    return "";
  }
}

/**
 * L’identifiant de compétition actif : d’abord l’URL `?comp=`, sinon la valeur mémorisée (session de l’onglet).
 * Synchronise le storage quand l’URL contient `comp`.
 */
function getEffectiveCompetitionRef() {
  const fromUrl = getCompetitionRefFromUrl();
  if (fromUrl) {
    try {
      sessionStorage.setItem(COMP_CONTEXT_SESSION_KEY, fromUrl);
    } catch (_) {}
    return fromUrl;
  }
  try {
    const s = sessionStorage.getItem(COMP_CONTEXT_SESSION_KEY);
    if (s) return sanitizeCompetitionRef(s);
  } catch (_) {}
  return "";
}

function buildCompetitionUrl(ref, absolute = false) {
  const safe = sanitizeCompetitionRef(ref);
  const current = new URL(window.location.href);
  current.searchParams.set(COMPETITION_QUERY_KEY, safe);
  return absolute ? current.toString() : `${current.pathname}${current.search}${current.hash}`;
}

/**
 * Sans `?comp=` dans l’URL : redirection vers choix-competition.html (chargement liste Supabase).
 * Ne pas utiliser sur choix-competition ni pages qui n’imbriquent pas une compétition (ex. index d’accueil).
 */
function redirectToCompetitionPickerIfUrlMissingComp() {
  try {
    const leaf = (window.location.pathname.split("/").pop() || "").toLowerCase();
    if (leaf === "choix-competition.html") return false;
    if (getCompetitionRefFromUrl()) return false;
    window.location.replace(
      "choix-competition.html?return=" +
        encodeURIComponent(
          window.location.pathname + window.location.search + window.location.hash
        )
    );
    return true;
  } catch (_) {
    return false;
  }
}

function hasRemoteCredentials(cfg) {
  return Boolean(cfg && cfg.url && cfg.anonKey);
}

function notifySync(status, message) {
  window.dispatchEvent(
    new CustomEvent("hyrox:remote-sync", {
      detail: { status, message, at: new Date().toISOString() },
    })
  );
}

function scheduleAutoPush(stateSnapshot) {
  const cfg = getRemoteConfig();
  if (!hasRemoteCredentials(cfg)) return;
  if (autoPushTimer) clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(async () => {
    try {
      await whenCloudReady();
      notifySync("pending", "Synchronisation automatique...");
      await pushRemote(stateSnapshot);
    } catch (err) {
      notifySync("error", `Erreur sync auto: ${err.message || err}`);
      console.error("Erreur sync auto", err);
    }
  }, AUTO_PUSH_DELAY_MS);
}

/** Une seule valeur arr/dep pour push : garder tout ce qui existe ; si deux saisies différentes, prendre le plus « tard » (lexicographique sur hh:mm:ss du même jour). */
function mergePassageTimeCell(a, b) {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (!sa) return sb;
  if (!sb) return sa;
  if (sa === sb) return sa;
  return sa > sb ? sa : sb;
}

/** Fusion passages Hyrox : aucun pointage perdu lorsque deux juges écrivent quasi en même temps. */
function mergeHyroxPassagesForPush(remoteMap, localMap) {
  const out = {};
  const ids = new Set([
    ...Object.keys(remoteMap || {}),
    ...Object.keys(localMap || {}),
  ]);
  for (const teamId of ids) {
    const r = remoteMap?.[teamId];
    const l = localMap?.[teamId];
    if (!r?.segments && !l?.segments) {
      if (r || l) out[teamId] = l || r;
      continue;
    }
    const segsR = r?.segments || [];
    const segsL = l?.segments || [];
    const segments = [];
    for (let i = 0; i < 16; i++) {
      segments.push({
        arr: mergePassageTimeCell(segsR[i]?.arr, segsL[i]?.arr),
        dep: mergePassageTimeCell(segsR[i]?.dep, segsL[i]?.dep),
      });
    }
    out[teamId] = {
      segments,
      dnf: !!(r?.dnf || l?.dnf),
    };
  }
  return out;
}

function normalizeState(rawState) {
  const incoming = rawState || {};
  const state = {
    ...structuredClone(defaultState),
    ...incoming,
    // Conserver les épreuves du cloud lorsqu’elles sont présentes (scores, classement, portail athlète).
    events: Array.isArray(incoming.events) ? [...incoming.events] : structuredClone(defaultState.events),
  };
  // Un seul enregistrement par id (évite doublons visibles sur la TV / classement après sync)
  const seenTeamIds = new Set();
  state.teams = (state.teams || [])
    .filter((team) => {
      const id = String(team?.id || "").trim();
      if (!id) return true;
      if (seenTeamIds.has(id)) return false;
      seenTeamIds.add(id);
      return true;
    })
    .map((team) => {
      const t = normalizeTeamFormatFields({ ...team });
      return {
        ...t,
        firstName: t.firstName || "",
        lastName: t.lastName || "",
        partnerFirstName: t.partnerFirstName || "",
        partnerLastName: t.partnerLastName || "",
        name: buildTeamName(t),
        email: typeof t.email === "string" ? t.email.trim() : "",
        category: t.category,
        teamFormat: t.teamFormat,
        gender: t.gender || "",
        heatNumber: Number(t.heatNumber || 1),
      };
    });
  const byScoreKey = new Map();
  (state.scores || []).forEach((s) => {
    if (!s || s.teamId == null || s.eventId == null) return;
    byScoreKey.set(`${s.teamId}\0${s.eventId}`, s);
  });
  state.scores = Array.from(byScoreKey.values());
  state.events = (state.events || []).map((event, index) => ({
    ...event,
    order: Number(event.order || index + 1),
    durationMinutes: Number(event.durationMinutes || 0),
    timeCapMinutes: Number(event.timeCapMinutes || 0),
    scoreFormat: event.scoreFormat || "",
    notes: event.notes || "",
  }));
  const sanitizedRankOrder = normalizeRankGroupHeatOrder(state.config?.rankGroupHeatOrder);

  state.config = {
    ...defaultState.config,
    ...state.config,
    rankGroupHeatOrder: sanitizedRankOrder,
    metconStaggerMinutes: 0,
    estimatedParcoursMinutes: Math.max(
      1,
      Number(
        state.config?.estimatedParcoursMinutes != null
          ? state.config.estimatedParcoursMinutes
          : defaultState.config.estimatedParcoursMinutes
      ) || 90
    ),
  };
  delete state.config.hyroxPassageOrders;
  state.hyroxPassages =
    state.hyroxPassages && typeof state.hyroxPassages === "object" && !Array.isArray(state.hyroxPassages)
      ? state.hyroxPassages
      : {};
  syncHyroxPassageRun1Starts(state);
  return state;
}

async function pushRemote(stateArg) {
  const cfg = getRemoteConfig();
  if (!cfg.url || !cfg.anonKey) {
    throw new Error("Config Supabase incomplète (URL/Anon key).");
  }
  const local = normalizeState(stateArg || stateCache || defaultState);

  let remoteState = null;
  try {
    const id = cfg.projectRef || "default";
    const res = await fetch(
      `${cfg.url}/rest/v1/competition_states?id=eq.${encodeURIComponent(id)}&select=state&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
        },
      }
    );
    if (res.ok) {
      const rows = await res.json();
      if (rows.length && rows[0].state) {
        remoteState = normalizeState(rows[0].state || {});
      }
    }
  } catch (e) {
    console.warn("pushRemote: lecture serveur pour fusion passages", e);
  }

  let merged = local;
  if (remoteState) {
    merged = normalizeState({
      ...local,
      hyroxPassages: mergeHyroxPassagesForPush(remoteState.hyroxPassages || {}, local.hyroxPassages || {}),
    });
  }

  const state = merged;
  const payload = {
    id: cfg.projectRef || "default",
    state: state,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(`${cfg.url}/rest/v1/competition_states?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Erreur push remote: ${res.status} ${txt}`);
  }
  const rows = await res.json();
  if (rows && rows[0] && rows[0].state) {
    stateCache = normalizeState(rows[0].state);
  } else {
    stateCache = state;
  }
  /* Permet à la TV (autres onglets) de rafraîchir dès un passage / score enregistré ici. */
  notifySync("success", "État publié sur le cloud.");
  return rows;
}

async function pullRemote() {
  const cfg = getRemoteConfig();
  if (!cfg.url || !cfg.anonKey) {
    throw new Error("Config Supabase incomplète (URL/Anon key).");
  }
  const id = cfg.projectRef || "default";
  const res = await fetch(
    `${cfg.url}/rest/v1/competition_states?id=eq.${encodeURIComponent(id)}&select=state,updated_at&limit=1`,
    {
      method: "GET",
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
      },
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Erreur pull remote: ${res.status} ${txt}`);
  }
  const rows = await res.json();
  if (!rows.length) {
    const created = normalizeState(defaultState);
    await pushRemote(created);
    stateCache = created;
    return structuredClone(stateCache);
  }
  stateCache = normalizeState(rows[0].state || {});
  return structuredClone(stateCache);
}

async function listCompetitions() {
  const cfg = getRemoteConfig();
  if (!cfg.url || !cfg.anonKey) {
    throw new Error("Config Supabase incomplète (URL/Anon key).");
  }
  const res = await fetch(
    `${cfg.url}/rest/v1/competition_states?select=id,updated_at&order=updated_at.desc&limit=200`,
    {
      method: "GET",
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
      },
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Erreur liste compétitions: ${res.status} ${txt}`);
  }
  const rows = await res.json();
  return rows
    .filter((r) => isHyroxCompetitionId(r.id))
    .map((r) => ({
      id: String(r.id || ""),
      updatedAt: r.updated_at || null,
    }));
}

async function whenCloudReady() {
  if (cloudReady) return;
  if (cloudInitPromise) return cloudInitPromise;
  cloudInitPromise = (async () => {
    notifySync("pending", "Connexion cloud...");
    await pullRemote();
    cloudReady = true;
    notifySync("success", "Cloud connecté.");
  })();
  return cloudInitPromise;
}

// Convertit mm:ss ou hh:mm:ss en secondes (ou retourne la valeur numérique brute).
function parseScoreValue(raw) {
  if (raw == null || raw === "" || raw === "DNF") return null;
  const s = String(raw).trim();
  if (/^\d+:\d{2}(:\d{2})?$/.test(s)) {
    const parts = s.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
  }
  const n = parseFloat(s.replace(",", "."));
  return isNaN(n) ? null : n;
}

// Classement par rang (épreuves scorées) — 1 rang par épreuve scorée, somme des rangs,
// le total le plus bas gagne. Par division (Open/Pro + format + sexe si solo).
function getRanking(state) {
  const scoredEvents = state.events.filter((e) => e.scored);

  const groups = {};
  state.teams.forEach((team) => {
    const key = rankGroupKey(team);
    if (!groups[key]) groups[key] = [];
    groups[key].push(team);
  });

  // rankMap[teamId][eventId] = rang numérique
  const rankMap = {};
  state.teams.forEach((t) => { rankMap[t.id] = {}; });

  Object.values(groups).forEach((athletes) => {
    scoredEvents.forEach((event) => {
      // Récupérer les scores de ce groupe pour cet event
      const withScore = athletes
        .map((a) => {
          const sc = state.scores.find((s) => s.teamId === a.id && s.eventId === event.id);
          // Pour les events timeCap : utiliser le rawValue encodé directement
          // (finished → secondes < timeCapSeconds ; time cap → 100000 - reps, toujours > timeCapSeconds)
          const val = sc ? parseScoreValue(sc.rawValue ?? sc.performance) : null;
          return { id: a.id, val, dnf: sc?.dnf || false };
        })
        .filter((x) => x.val !== null && !x.dnf);

      // Trier selon la direction du score
      // Pour MetCon timeCap : higherIsBetter=false donc on trie ASC → les temps (petits) devant, reps encodés (grands) derrière
      withScore.sort((a, b) =>
        event.higherIsBetter ? b.val - a.val : a.val - b.val
      );

      // Attribuer les rangs (ex-aequo → même rang)
      let rank = 1;
      withScore.forEach((entry, idx) => {
        if (idx > 0 && withScore[idx - 1].val !== entry.val) rank = idx + 1;
        rankMap[entry.id][event.id] = rank;
      });

      // DNF / absent → rang = participants + 1, SEULEMENT si au moins un score existe
      if (withScore.length > 0) {
        const worstRank = athletes.length + 1;
        athletes.forEach((a) => {
          if (rankMap[a.id][event.id] == null) rankMap[a.id][event.id] = worstRank;
        });
      }
    });
  });

  const rows = state.teams
    .map((team) => {
      const eventRanks = scoredEvents.map((e) => ({
        eventId: e.id,
        eventName: e.name,
        rank: rankMap[team.id]?.[e.id] ?? null,
      }));
      const scored = eventRanks.filter((r) => r.rank != null);
      const total  = scored.reduce((sum, r) => sum + r.rank, 0);
      return { teamId: team.id, team, eventRanks, total, scoredCount: scored.length };
    })
    .sort((a, b) => {
      const ka = athleteSortKey(a.team, state);
      const kb = athleteSortKey(b.team, state);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const va = ka[i] ?? 0;
        const vb = kb[i] ?? 0;
        if (va < vb) return -1;
        if (va > vb) return 1;
      }
      if (a.scoredCount === 0 && b.scoredCount === 0) return 0;
      if (a.scoredCount === 0) return 1;
      if (b.scoredCount === 0) return -1;
      return a.total - b.total;
    });
  const seenOut = new Set();
  return rows.filter((r) => {
    if (!r.teamId || seenOut.has(r.teamId)) return false;
    seenOut.add(r.teamId);
    return true;
  });
}

/** Vrai si l'équipe a au moins un DNF sur une épreuve scorée (abandon, non terminé). */
function teamHasDnfScore(state, teamId) {
  if (!state?.scores?.length || !teamId) return false;
  const scoredIds = new Set((state.events || []).filter((e) => e.scored).map((e) => e.id));
  return state.scores.some(
    (s) => s.teamId === teamId && s.dnf && scoredIds.has(s.eventId)
  );
}

/** DNF parcours (page Passages) ou abandon sur une épreuve scorée — même logique que la grille TV / classements. */
function teamIsDnf(state, teamId) {
  return getHyroxPassageDnf(state, teamId) || teamHasDnfScore(state, teamId);
}

function parseHmToMinutes(hm) {
  const [h, m] = String(hm || "08:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Retourne l'heure courante en minutes depuis minuit, en tenant compte de la date de compétition.
// - Pas de date configurée → heure réelle (comportement normal)
// - Date dans le futur     → -9999 (tout est "à venir")
// - Date dans le passé     → 99999 (tout est "terminé")
// - Date = aujourd'hui     → heure réelle
function effectiveNowMin(state) {
  const d = new Date();
  const realMin = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const dateStr = state?.config?.date; // "YYYY-MM-DD"
  if (!dateStr) return realMin;
  const todayStr = d.toISOString().slice(0, 10);
  if (todayStr < dateStr) return -9999;   // compétition pas encore commencée
  if (todayStr > dateStr) return 99999;   // compétition terminée (jour passé)
  return realMin; // c'est le bon jour → heure réelle
}

function minutesToHm(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Ordre de passage (heats, classement, TV) :
 * 1) Open puis Pro
 * 2) Solo puis duos, avec Mixte en premier, puis duo femmes puis duo hommes
 * 3) En solo : Femme puis Homme
 */
const DIVISION_SORT = { Open: 0, Pro: 1 };
const FORMAT_ORDER_MAP = { Solo: 0, Mixte: 1, DuoF: 2, DuoH: 3 };
const GEND_ORDER_SOLO = { Femme: 0, Homme: 1 };

function athleteSortKey(a, state) {
  const order = a.sortOrder != null ? Number(a.sortOrder) : 9999;
  const last = (a.lastName || a.name || "").toLowerCase();
  const ord = state ? normalizeRankGroupHeatOrder(state.config?.rankGroupHeatOrder) : null;
  if (!ord || !ord.length) {
    const div = DIVISION_SORT[normalizeCategory(effectiveCategory(a))] ?? 99;
    const fmt = FORMAT_ORDER_MAP[getTeamFormat(a)] ?? 99;
    const gend = getTeamFormat(a) === TEAM_FORMAT_SOLO ? (GEND_ORDER_SOLO[a.gender] ?? 99) : 0;
    return [div, fmt, gend, order, last];
  }
  const rk = rankGroupKey(a);
  const gIdx = ord.indexOf(rk);
  const grpPri = gIdx >= 0 ? gIdx : 999;
  return [grpPri, order, last];
}

function compareAthletes(a, b, state) {
  const ka = athleteSortKey(a, state);
  const kb = athleteSortKey(b, state);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const va = ka[i] ?? 0;
    const vb = kb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** Ordre des blocs « classement / TV » : suit `rankGroupHeatOrder` si défini, puis ordre comme les heats (tri athlètes). */
function sortedRankGroupKeys(state) {
  if (!state || !state.teams) return [];
  const sortedTeams = [...state.teams].sort((a, b) => compareAthletes(a, b, state));
  const ord = normalizeRankGroupHeatOrder(state.config?.rankGroupHeatOrder);
  const keysPresent = new Set(sortedTeams.map((t) => rankGroupKey(t)));
  const out = [];
  const seen = new Set();
  if (ord && ord.length) {
    ord.forEach((k) => {
      if (!keysPresent.has(k) || seen.has(k)) return;
      out.push(k);
      seen.add(k);
    });
  }
  sortedTeams.forEach((t) => {
    const k = rankGroupKey(t);
    if (!seen.has(k)) {
      out.push(k);
      seen.add(k);
    }
  });
  return out;
}

function buildHeatSchedule(state) {
  const perHeat = Number(state.config.athletesPerHeat || 2);
  const sorted = [...state.teams].sort((a, b) => compareAthletes(a, b, state));

  // Groupement dynamique par position dans le tableau trié
  const grouped = {};
  sorted.forEach((athlete, idx) => {
    const heat = Math.floor(idx / perHeat) + 1;
    if (!grouped[heat]) grouped[heat] = [];
    grouped[heat].push(athlete);
  });

  const startMinutes = parseHmToMinutes(state.config.startTime);
  const interval = Number(state.config.heatIntervalMinutes || 20);

  return Object.keys(grouped)
    .map(Number)
    .sort((a, b) => a - b)
    .map((heat) => ({
      heat,
      startTime: minutesToHm(startMinutes + (heat - 1) * interval),
      athletes: grouped[heat],
    }));
}

/**
 * Fin de la fenêtre « en course » pour la TV (après somme des créneaux `events` post-départ,
 * ou sinon `config.estimatedParcoursMinutes` à partir du départ du heat).
 * Retour en minutes depuis minuit (nombre).
 */
function getAthleteEndMinutes(athlete, state) {
  if (!athlete || !state) return null;
  const schedule = buildHeatSchedule(state);
  const h = schedule.find((s) => s.athletes.some((a) => a.id === athlete.id));
  if (!h) return null;
  const heatStart = parseHmToMinutes(h.startTime);
  const evs = [...(state.events || [])].sort((a, b) => a.order - b.order);
  let afterDep = 0;
  for (const ev of evs) {
    afterDep += Number(ev.durationMinutes) || 0;
  }
  if (afterDep > 0) return heatStart + afterDep;
  const est = Number(state.config?.estimatedParcoursMinutes) > 0 ? Number(state.config.estimatedParcoursMinutes) : 90;
  return heatStart + est;
}

/** Passe "HH:MM" ou "H:MM:SS" → horloge "HH:MM:SS" (passages / Rox). */
function hmToPassageDayClock(hm) {
  const s = String(hm || "").trim();
  if (!s) return "";
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(s)) {
    const p = s.split(":").map(Number);
    return `${String(p[0]).padStart(2, "0")}:${String(p[1]).padStart(2, "0")}:${String(p[2] || 0).padStart(2, "0")}`;
  }
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(":").map(Number);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  }
  return s;
}

/**
 * Heure de départ réelle sur le parcours (départ du heat) = Start du segment RUN 1.
 */
function getHeatStartClockString(state, teamId) {
  const schedule = buildHeatSchedule(state);
  const block = schedule.find((h) => h.athletes.some((a) => a.id === teamId));
  if (!block) return "";
  return hmToPassageDayClock(block.startTime);
}

function normalizeTeamPayload(raw, state) {
  const validFmt = [TEAM_FORMAT_SOLO, TEAM_FORMAT_DUO_H, TEAM_FORMAT_DUO_F, TEAM_FORMAT_MIXTE];
  let teamFormat = validFmt.includes(raw.teamFormat) ? raw.teamFormat : TEAM_FORMAT_SOLO;
  if (!validFmt.includes(raw.teamFormat) && raw.gender === "Mixte") {
    teamFormat = TEAM_FORMAT_MIXTE;
  }
  let category = normalizeCategory(raw.category);
  let gender = String(raw.gender || "").trim();
  if (teamFormat === TEAM_FORMAT_MIXTE) {
    category = "Open";
    gender = "";
  } else if (teamFormat !== TEAM_FORMAT_SOLO) {
    gender = "";
  } else if (gender === "Mixte") {
    teamFormat = TEAM_FORMAT_MIXTE;
    category = "Open";
    gender = "";
  }
  if (teamFormat === TEAM_FORMAT_MIXTE) category = "Open";

  let pl = String(raw.partnerLastName || "").trim();
  let pf = String(raw.partnerFirstName || "").trim();
  if (teamFormat === TEAM_FORMAT_SOLO) {
    pl = "";
    pf = "";
  } else {
    pl = pl.toUpperCase();
    pf = pf ? pf.charAt(0).toUpperCase() + pf.slice(1).toLowerCase() : "";
  }

  let defaultOrder = 1;
  const gk = rankGroupKey({ teamFormat, category, gender });
  if (state && state.teams) {
    const siblings = state.teams.filter((t) => rankGroupKey(t) === gk);
    const maxOrder = siblings.reduce((m, t) => Math.max(m, t.sortOrder ?? 0), 0);
    defaultOrder = maxOrder + 1;
  }
  const fn = String(raw.firstName || "").trim();
  const ln = String(raw.lastName || "").trim();
  const built = {
    id: raw.id || uid("ath"),
    firstName: raw.firstName || "",
    lastName: raw.lastName || "",
    partnerFirstName: pf,
    partnerLastName: pl,
    email: typeof raw.email === "string" ? raw.email.trim() : "",
    club: raw.club || "",
    category,
    teamFormat,
    gender,
    sortOrder: raw.sortOrder != null ? Number(raw.sortOrder) : defaultOrder,
  };
  built.name = buildTeamName(built);
  return built;
}

function upsertScore(state, payload) {
  const idx = state.scores.findIndex(
    (s) => s.teamId === payload.teamId && s.eventId === payload.eventId
  );
  if (idx >= 0) state.scores[idx] = payload;
  else state.scores.push(payload);
}

const HYROX_PASSAGE_LABELS = [
  "RUN 1", "SKI ERG", "RUN 2", "SLED PUSH", "RUN 3", "SLED PULL", "RUN 4", "BBJ",
  "RUN 5", "ROW", "RUN 6", "FARMER CARRY", "RUN 7", "LUNGE", "RUN 8", "WALLBALL",
];

/** Clés utilisées pour l’admin (ordre des catégories) — alignées sur `rankGroupKey`. */
const RANK_GROUP_ORDER_KEYS = [
  "Open|Solo|Femme",
  "Open|Solo|Homme",
  "Pro|Solo|Femme",
  "Pro|Solo|Homme",
  "Open|DuoF",
  "Open|DuoH",
  "Pro|DuoF",
  "Pro|DuoH",
  "Open|Mixte",
];

function rankGroupCategoryLabel(key) {
  const labels = {
    "Open|Solo|Femme": "Open · Solo · Femmes",
    "Open|Solo|Homme": "Open · Solo · Hommes",
    "Pro|Solo|Femme": "Pro · Solo · Femmes",
    "Pro|Solo|Homme": "Pro · Solo · Hommes",
    "Open|DuoF": "Open · Duo femmes",
    "Open|DuoH": "Open · Duo hommes",
    "Pro|DuoF": "Pro · Duo femmes",
    "Pro|DuoH": "Pro · Duo hommes",
    "Open|Mixte": "Open · Mixte",
  };
  return labels[key] || key;
}

/** Heure du jour → secondes depuis minuit (HH:MM ou HH:MM:SS). */
function parsePassageClock(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  const h = parts[0];
  const m = parts[1];
  const sec = parts.length >= 3 ? parts[2] : 0;
  return h * 3600 + m * 60 + sec;
}

function formatPassageClock(sec) {
  if (sec == null || !isFinite(sec)) return "";
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Durée Rox sur un segment (Start → End du même segment), gère passage minuit. */
function roxSegmentDurationSec(arrStr, depStr) {
  const a = parsePassageClock(arrStr);
  const d = parsePassageClock(depStr);
  if (a == null || d == null) return null;
  let diff = d - a;
  if (diff < 0) diff += 86400;
  return diff;
}

/**
 * Temps de zone Rox entre la fin du segment courant et le début du suivant
 * (fin de run → début atelier, fin atelier → début du run suivant).
 * @param endCurrentStr  heure End du segment i
 * @param startNextStr   heure Start du segment i+1
 */
function roxTransitionZoneSec(endCurrentStr, startNextStr) {
  return roxSegmentDurationSec(endCurrentStr, startNextStr);
}

function formatDurationMMSS(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Extrait le segment i depuis la structure brute (tableau, trou, clés "0"…"15" ou objet).
 * Utilisé en lecture seule pour ne pas masquer le RUN 1 quand `segments[0]` est null.
 */
function normalizePassageRawSegments(raw) {
  const cell = (i) => {
    let o = null;
    if (Array.isArray(raw) && i < raw.length) o = raw[i];
    else if (raw && typeof raw === "object" && !Array.isArray(raw)) o = raw[i] ?? raw[String(i)];
    if (o == null || typeof o !== "object") return { arr: "", dep: "" };
    return { arr: o.arr != null ? String(o.arr) : "", dep: o.dep != null ? String(o.dep) : "" };
  };
  return Array.from({ length: 16 }, (_, i) => cell(i));
}

/** Affichage / grille : ne modifie pas l’état. RUN 1 : Start = heure de départ du heat. */
function getPassageSegmentsReadOnly(state, teamId) {
  const raw = state.hyroxPassages?.[teamId]?.segments;
  const base = normalizePassageRawSegments(raw);
  const run1 = getHeatStartClockString(state, teamId);
  const arr0 = String(base[0].arr || "").trim();
  const dep0 = String(base[0].dep || "").trim();
  return Array.from({ length: 16 }, (_, i) => {
    if (i === 0) {
      return { arr: (run1 || arr0) || "", dep: dep0 };
    }
    return { arr: String(base[i].arr || "").trim(), dep: String(base[i].dep || "").trim() };
  });
}

/**
 * Durée totale (chrono gun) : heure de départ du heat → heure d’arrivée au mur (seg. 16).
 * @returns secondes, ou null si heure de fin absente.
 */
function getHyroxGlobalTimeSec(state, teamId) {
  if (!state || !teamId) return null;
  const segs = getPassageSegmentsReadOnly(state, teamId);
  const start = getHeatStartClockString(state, teamId);
  const depWalls = segs[15] ? String(segs[15].dep || "").trim() : "";
  if (!start || !depWalls) return null;
  return roxSegmentDurationSec(start, depWalls);
}

/** Chrono d’arrivée affichable (H:MM:SS si ≥1 h, sinon M:SS). */
function formatHyroxRaceDuration(totalSec) {
  if (totalSec == null || !isFinite(totalSec) || totalSec < 0) return "—";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getTeamPassages(state, teamId) {
  if (!state.hyroxPassages || typeof state.hyroxPassages !== "object") state.hyroxPassages = {};
  if (!state.hyroxPassages[teamId]) {
    state.hyroxPassages[teamId] = {
      segments: Array.from({ length: 16 }, () => ({ arr: "", dep: "" })),
      dnf: false,
    };
  } else if (!Array.isArray(state.hyroxPassages[teamId].segments)) {
    state.hyroxPassages[teamId].segments = Array.from({ length: 16 }, () => ({ arr: "", dep: "" }));
  } else {
    while (state.hyroxPassages[teamId].segments.length < 16) {
      state.hyroxPassages[teamId].segments.push({ arr: "", dep: "" });
    }
    state.hyroxPassages[teamId].segments = state.hyroxPassages[teamId].segments.slice(0, 16);
  }
  if (typeof state.hyroxPassages[teamId].dnf !== "boolean") {
    state.hyroxPassages[teamId].dnf = false;
  }
  return state.hyroxPassages[teamId].segments;
}

/**
 * Fusionne les passages déjà enregistrés dans le cache canonique pour cet athlète
 * (autre juge / onglet / dernier save) dans `state`, sans écraser une case déjà remplie localement.
 * Utilisé avant chaque saisie non vide pour limiter les courses entre pointages.
 */
function mergeHyroxPassagesForTeamFromCache(state, teamId) {
  if (!teamId || !stateCache?.hyroxPassages?.[teamId]?.segments) return;
  const cached = stateCache.hyroxPassages[teamId];
  const segs = getTeamPassages(state, teamId);
  const cs = cached.segments;
  for (let i = 0; i < 16; i++) {
    if (!cs[i]) continue;
    if (!segs[i]) segs[i] = { arr: "", dep: "" };
    const la = String(segs[i].arr || "").trim();
    const lb = String(cs[i].arr || "").trim();
    const lc = String(segs[i].dep || "").trim();
    const ld = String(cs[i].dep || "").trim();
    segs[i].arr = la || lb;
    segs[i].dep = lc || ld;
  }
  if (state.hyroxPassages?.[teamId] && cached.dnf === true) {
    state.hyroxPassages[teamId].dnf = true;
  }
}

/** Abandon parcours (passages) — coché depuis scores.html, distinct du DNF des épreuves scorées. */
function getHyroxPassageDnf(state, teamId) {
  const e = state.hyroxPassages?.[teamId];
  return !!(e && e.dnf === true);
}

function setHyroxPassageDnf(state, teamId, dnf) {
  if (!state.hyroxPassages || typeof state.hyroxPassages !== "object") state.hyroxPassages = {};
  getTeamPassages(state, teamId);
  state.hyroxPassages[teamId].dnf = !!dnf;
}

/**
 * Remet à zéro les passages Hyrox d’un seul athlète : segments vides, DNF retiré.
 * Recolle le Start RUN 1 sur l’heure de départ du heat si le planning le fournit.
 */
function clearHyroxPassagesForTeam(state, teamId) {
  if (!teamId || !state.teams?.some((t) => t.id === teamId)) return;
  if (!state.hyroxPassages || typeof state.hyroxPassages !== "object") state.hyroxPassages = {};
  state.hyroxPassages[teamId] = {
    segments: Array.from({ length: 16 }, () => ({ arr: "", dep: "" })),
    dnf: false,
  };
  syncHyroxPassageRun1Starts(state);
}

/** Aligne le Start (arr) du RUN 1 sur l’heure de départ du heat pour chaque athlète. */
function syncHyroxPassageRun1Starts(state) {
  if (!state.teams || !state.teams.length) return;
  for (const team of state.teams) {
    const t = getHeatStartClockString(state, team.id);
    if (!t) continue;
    const segs = getTeamPassages(state, team.id);
    if (segs[0]) segs[0].arr = t;
  }
}

function setPassageField(state, teamId, segIndex, field, value) {
  if (field !== "arr" && field !== "dep") return;
  const v = value == null ? "" : String(value).trim();
  const segs = getTeamPassages(state, teamId);
  if (!segs[segIndex]) segs[segIndex] = { arr: "", dep: "" };
  if (field === "arr" && segIndex === 0) {
    const t = getHeatStartClockString(state, teamId);
    if (t) segs[0].arr = t;
    return;
  }
  if (v) {
    mergeHyroxPassagesForTeamFromCache(state, teamId);
  }
  segs[segIndex][field] = v;
  const t0 = getHeatStartClockString(state, teamId);
  if (t0) segs[0].arr = t0;
}

function getHyroxPreset() {
  return [];
}

window.HyroxStore = {
  uid,
  loadState,
  saveState,
  normalizeState,
  getRanking,
  teamHasDnfScore,
  teamIsDnf,
  buildHeatSchedule,
  getHeatStartClockString,
  getAthleteEndMinutes,
  compareAthletes,
  normalizeTeamPayload,
  upsertScore,
  HYROX_PASSAGE_LABELS,
  RANK_GROUP_ORDER_KEYS,
  normalizeRankGroupHeatOrder,
  rankGroupCategoryLabel,
  parsePassageClock,
  formatPassageClock,
  roxSegmentDurationSec,
  roxTransitionZoneSec,
  formatDurationMMSS,
  getHyroxGlobalTimeSec,
  formatHyroxRaceDuration,
  getTeamPassages,
  getPassageSegmentsReadOnly,
  setPassageField,
  getHyroxPassageDnf,
  setHyroxPassageDnf,
  clearHyroxPassagesForTeam,
  parseScoreValue,
  effectiveNowMin,
  getHyroxPreset,
  getRemoteConfig,
  setRemoteConfig,
  pushRemote,
  pullRemote,
  whenCloudReady,
  listCompetitions,
  isHyroxCompetitionId,
  getCompetitionRefFromUrl,
  getEffectiveCompetitionRef,
  sanitizeCompetitionRef,
  buildCompetitionUrl,
  redirectToCompetitionPickerIfUrlMissingComp,
  defaultState,
  normalizeCategory,
  getTeamFormat,
  effectiveCategory,
  rankGroupKey,
  formatTeamDivisionLine,
  formatTeamDisplayName,
  sortedRankGroupKeys,
  TEAM_FORMAT_SOLO,
  TEAM_FORMAT_DUO_H,
  TEAM_FORMAT_DUO_F,
  TEAM_FORMAT_MIXTE,
};

// Propagation du paramètre ?comp= sur les liens internes (dès que le DOM des ancres est prêt).
function patchNavLinksWithComp() {
  const ref = getEffectiveCompetitionRef();
  if (!ref) return;
  const apply = () => {
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto")) return;
      try {
        const base = window.location.href;
        const url = new URL(href, base);
        if (url.hostname && window.location.hostname && url.hostname !== window.location.hostname) return;
        url.searchParams.set(COMPETITION_QUERY_KEY, ref);
        a.setAttribute("href", url.pathname + url.search + url.hash);
      } catch (_) {}
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
}
(function initNavCompPatch() {
  patchNavLinksWithComp();
})();

// Initialisation cloud automatique (mode cloud strict).
whenCloudReady().catch((err) => {
  notifySync("error", `Cloud indisponible: ${err.message || err}`);
});
