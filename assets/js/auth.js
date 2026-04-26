// ══════════════════════════════════════════════════════════════
//  Hyrox Epicure — Auth client-side
//  Protection par mot de passe + session sessionStorage
// ══════════════════════════════════════════════════════════════

const AUTH_SESSION_KEY = "hyrox_auth_session_v1";
const AUTH_COMP_KEY    = "hyrox_auth_comp_v1";   // comp lié à la session
const DEFAULT_PASSWORD = "epicure";              // mot de passe par défaut

// Hash SHA-256 d'une chaîne → hex string
async function hashPassword(password) {
  const enc  = new TextEncoder();
  const buf  = await crypto.subtle.digest("SHA-256", enc.encode(password.trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// Récupère le hash stocké dans la config Supabase (ou le hash du mot de passe par défaut)
async function getStoredHash() {
  try {
    // HyroxStore doit être chargé avant auth.js
    if (typeof HyroxStore === "undefined") return null;
    const state = HyroxStore.loadState();
    return state?.config?.adminPasswordHash || await hashPassword(DEFAULT_PASSWORD);
  } catch {
    return await hashPassword(DEFAULT_PASSWORD);
  }
}

// Clé compétition alignée sur HyroxStore (URL ?comp= + session onglet).
function getAuthCompetitionKey() {
  try {
    if (typeof HyroxStore !== "undefined" && typeof HyroxStore.getEffectiveCompetitionRef === "function") {
      const r = HyroxStore.getEffectiveCompetitionRef();
      if (r) return r;
    }
  } catch (_) {}
  return new URLSearchParams(window.location.search).get("comp") || "default";
}

// Vérifie si la session courante est valide pour cette compétition
function isAuthenticated() {
  try {
    const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return false;
    const session = JSON.parse(raw);
    // Session expire après 8 heures
    if (Date.now() - session.ts > 8 * 60 * 60 * 1000) {
      sessionStorage.removeItem(AUTH_SESSION_KEY);
      return false;
    }
    // Vérifier que la session est pour la même compétition
    const comp = getAuthCompetitionKey();
    if (session.comp && session.comp !== comp) return false;
    return true;
  } catch {
    return false;
  }
}

// Ouvre une session après vérification du mot de passe
// Retourne true si OK, false sinon
async function login(password) {
  const inputHash  = await hashPassword(password);
  const storedHash = await getStoredHash();
  if (inputHash !== storedHash) return false;
  const comp = getAuthCompetitionKey();
  sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ ts: Date.now(), comp }));
  return true;
}

// Déconnexion
function logout() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  window.location.reload();
}

// Change le mot de passe (sauvegarde le hash dans la config)
async function changePassword(newPassword) {
  if (!newPassword || newPassword.trim().length < 4) {
    throw new Error("Le mot de passe doit contenir au moins 4 caractères.");
  }
  const hash  = await hashPassword(newPassword);
  const state = HyroxStore.loadState();
  state.config.adminPasswordHash = hash;
  HyroxStore.saveState(state);
  return hash;
}

// ── Modal de connexion ─────────────────────────────────────────
// Injecte un modal et bloque la page jusqu'à authentification.
// Appeler en haut de chaque page protégée.
function requireAuth(options = {}) {
  const { onSuccess } = options;

  // Si déjà connecté → OK
  if (isAuthenticated()) {
    onSuccess?.();
    return;
  }

  // Empêcher le scroll de la page en dessous
  document.body.style.overflow = "hidden";

  // Injecter le modal dans le DOM (après DOMContentLoaded si besoin)
  function inject() {
    // Supprimer un éventuel modal existant
    document.getElementById("auth-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "auth-overlay";
    overlay.innerHTML = `
      <div id="auth-modal">
        <div id="auth-logo">HYROX · EPICURE</div>
        <div id="auth-lock">🔒</div>
        <div id="auth-title">Espace réservé</div>
        <div id="auth-sub">Cette page est protégée. Entrez le mot de passe pour continuer.</div>
        <form id="auth-form" autocomplete="off">
          <div id="auth-input-wrap">
            <input
              type="password"
              id="auth-password"
              placeholder="Mot de passe…"
              autofocus
              autocomplete="current-password"
            />
            <button type="button" id="auth-eye" aria-label="Afficher">👁</button>
          </div>
          <div id="auth-error" class="hidden">Mot de passe incorrect.</div>
          <button type="submit" id="auth-submit" class="primary">
            <span id="auth-btn-text">Connexion</span>
            <span id="auth-spinner" class="hidden">⏳</span>
          </button>
        </form>
        <div id="auth-hint"></div>
      </div>`;

    document.body.appendChild(overlay);

    const form     = document.getElementById("auth-form");
    const input    = document.getElementById("auth-password");
    const errEl    = document.getElementById("auth-error");
    const btnText  = document.getElementById("auth-btn-text");
    const spinner  = document.getElementById("auth-spinner");
    const eyeBtn   = document.getElementById("auth-eye");

    eyeBtn.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.classList.add("hidden");
      btnText.textContent = "Vérification…";
      spinner.classList.remove("hidden");

      const ok = await login(input.value);

      spinner.classList.add("hidden");
      btnText.textContent = "Connexion";

      if (ok) {
        overlay.classList.add("auth-success");
        document.body.style.overflow = "";
        setTimeout(() => {
          overlay.remove();
          onSuccess?.();
        }, 350);
      } else {
        errEl.classList.remove("hidden");
        input.value = "";
        input.focus();
        // Shake
        const modal = document.getElementById("auth-modal");
        modal.classList.add("shake");
        setTimeout(() => modal.classList.remove("shake"), 500);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
}

// ── Bouton de déconnexion dans le header ──────────────────────
// Injecte un petit bouton "🔓 Déconnexion" à la fin du <header>
function injectLogoutBtn() {
  const header = document.querySelector("header");
  if (!header || document.getElementById("auth-logout-btn")) return;

  const btn = document.createElement("button");
  btn.id = "auth-logout-btn";
  btn.title = "Se déconnecter";
  btn.innerHTML = "🔓";
  btn.addEventListener("click", () => {
    if (confirm("Se déconnecter ?")) logout();
  });
  header.appendChild(btn);
}

// Exporter
window.HyroxAuth = { requireAuth, login, logout, isAuthenticated, changePassword, hashPassword };
window.injectLogoutBtn = injectLogoutBtn;
