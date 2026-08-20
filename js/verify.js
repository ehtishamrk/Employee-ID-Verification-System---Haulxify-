import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
// Firestore LITE — a small, REST-based client meant for exactly this page's
// job: one single read, then done. The full Firestore SDK opens a
// persistent realtime connection before a getDoc() resolves, which is real,
// avoidable latency on a page whose only purpose is "scan it, see it fast."
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore-lite.js";
import { firebaseConfig } from "./firebase-config.js";
import { el, setHidden, escapeHtml, formatDateTime, ID_TYPES } from "./common.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const params = new URLSearchParams(window.location.search);
const cardToken = params.get("card") || "";
const passId = params.get("pass") || "";

const ICONS = {
  id: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="12" r="2"/><path d="M14 10h4M14 14h4"/></svg>`,
  department: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2C10.5 21 3 13.5 3 6a2 2 0 0 1 2-2Z"/></svg>`,
  shift: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  issued: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m9 15 2 2 4-4"/></svg>`,
  expires: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m10 15 4 4M14 15l-4 4"/></svg>`,
  purpose: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M6 21V4a1 1 0 0 1 1-1h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1Z"/><path d="M9 13h6M9 17h6"/></svg>`,
  host: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c1-3.5 4-5.5 7-5.5s6 2 7 5.5"/></svg>`,
};

function initials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function detail(icon, label, value) {
  return `
    <div class="detail-item">
      <span class="detail-icon">${ICONS[icon] || ""}</span>
      <div>
        <span class="detail-label">${escapeHtml(label)}</span>
        <strong class="detail-value">${escapeHtml(value || "—")}</strong>
      </div>
    </div>`;
}

// ---- Modal + staff-module bridge (shared with the lazily-loaded module) ----
let staffModulePromise = null;
function loadStaffModule() {
  if (!staffModulePromise) staffModulePromise = import("./verify-staff.js");
  return staffModulePromise;
}

function openModal(html) {
  el("modalContent").innerHTML = html;
  setHidden(el("modalOverlay"), false);
}
function closeModal() {
  setHidden(el("modalOverlay"), true);
  el("modalContent").innerHTML = "";
}
el("modalClose").addEventListener("click", closeModal);
el("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

const ctx = {
  app, db, cardToken, passId,
  ICONS, detail, escapeHtml, formatDateTime, ID_TYPES,
  el, setHidden, openModal, closeModal,
};

async function bootStaffBar() {
  const mod = await loadStaffModule();
  mod.mountStaffBar(ctx);
  return mod;
}

el("staffToggle").addEventListener("click", async () => {
  el("staffToggle").textContent = "Loading…";
  const mod = await bootStaffBar();
  mod.toggleSignInForm();
  // Only check/reveal staff actions on a card AFTER the person opted in by
  // tapping this link — this is the one place we'd otherwise eagerly load
  // the Auth SDK for every public scan, which is exactly the cost this
  // whole rewrite exists to avoid. Registered via onSignedIn (not called
  // directly) so this fires correctly whether they were already signed in
  // or are signing in for the first time just now via the form below.
  if (ctx.hostCard) {
    mod.onSignedIn(() => mod.tryAutoReveal(ctx));
  }
});

// ---- Employee card mode ----
async function verifyCard(token) {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
    showError("This link is malformed and can't be verified. Please rescan the QR code on the ID card.");
    return;
  }

  try {
    const snap = await getDoc(doc(db, "cards", token));
    if (!snap.exists()) {
      showError("This employee card doesn't exist. It may have been deleted.");
      return;
    }
    renderEmployee(snap.data());
  } catch (error) {
    // Firestore Rules deny the read outright for frozen, canceled, expired,
    // or unknown tokens — that denial surfaces here as permission-denied,
    // not as a missing document. Treat it as the expected "not valid" case.
    if (error?.code === "permission-denied") {
      showError("This employee card is frozen, canceled, or expired. Contact HAULXIFY HR if you believe this is a mistake.");
    } else {
      console.error(error);
      showError("Verification couldn't be completed. Check your connection and try again.");
    }
  }
}

function renderEmployee(card) {
  setHidden(el("state"), true);

  const ring = document.querySelector(".badge-photo-ring");
  ring.innerHTML = card.photoBase64
    ? `<img class="badge-photo" src="${escapeHtml(card.photoBase64)}" alt="">`
    : `<div class="badge-photo-fallback">${escapeHtml(initials(card.name))}</div>`;

  el("employee").innerHTML = `
    <div class="verified-mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m4 12.5 5 5L20 7"/></svg>
      Verified Employee
    </div>
    <h1>${escapeHtml(card.name)}</h1>
    <p class="designation">${escapeHtml(card.designation)}</p>
    <div class="detail-grid">
      ${detail("id", "Employee ID", card.employeeId)}
      ${detail("department", "Department", card.department)}
      ${detail("phone", "Phone", card.phone)}
      ${detail("shift", "Shift", card.shiftTimings)}
      ${detail("issued", "Card Issued", card.issueDate)}
      ${detail("expires", "Card Expires", card.expiryDate)}
    </div>
    <div id="staffActions" class="staff-actions hidden"></div>
  `;

  setHidden(el("employee"), false);
  setHidden(el("footer"), false);
  el("verifiedAt").textContent = `Verified ${new Date().toLocaleString()}`;

  // Host context for the (opt-in only) staff "Issue Visitor Pass" action —
  // stored for when/if someone taps "Staff sign-in" below. Nothing here
  // triggers a module load or auth check on its own.
  ctx.hostCard = { token: cardToken, ...card };
}

// ---- Visitor pass mode ----
// Pass docs are never publicly readable, so there is no point attempting a
// read before we know someone is signed in as staff — that would just be a
// guaranteed permission-denied round trip. Ask for sign-in immediately.
function showPassGate(id) {
  setHidden(el("state"), true);
  el("badgeSubtitle").textContent = "Visitor Pass";
  el("stateCaption").textContent = "";
  el("verifyDisclaimer").textContent = "This page manages a physical visitor pass. It is only accessible to signed-in HAULXIFY reception staff.";

  const ring = document.querySelector(".badge-photo-ring");
  ring.innerHTML = `<div class="badge-photo-fallback badge-photo-unknown">${escapeHtml(id)}</div>`;

  el("passPanel").innerHTML = `
    <div class="pass-status-badge locked">Staff Only</div>
    <h1>Visitor Pass #${escapeHtml(id)}</h1>
    <p class="designation">Sign in as reception staff to view this pass</p>
  `;
  setHidden(el("passPanel"), false);
  setHidden(el("footer"), false);
  el("verifiedAt").textContent = `Checked ${new Date().toLocaleString()}`;

  bootStaffBar().then(mod => {
    mod.toggleSignInForm(true);
    mod.onSignedIn(() => mod.loadPass(ctx, id));
  });
}

function showError(message) {
  setHidden(el("state"), true);
  const ring = document.querySelector(".badge-photo-ring");
  ring.innerHTML = `<div class="badge-photo-fallback badge-photo-unknown">?</div>`;

  el("error").innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="error-icon"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
    <p>${escapeHtml(message)}</p>
  `;
  setHidden(el("error"), false);
  setHidden(el("footer"), false);
  el("verifiedAt").textContent = `Checked ${new Date().toLocaleString()}`;
}
ctx.showError = showError;
ctx.renderEmployee = renderEmployee;

if (passId) {
  showPassGate(passId);
} else if (cardToken) {
  verifyCard(cardToken);
} else {
  setHidden(el("state"), true);
  showError("This link is missing a card or pass reference. Please rescan the QR code.");
}
