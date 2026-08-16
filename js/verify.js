import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { el, setHidden, escapeHtml } from "./common.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const params = new URLSearchParams(window.location.search);
const token = params.get("card") || "";

const ICONS = {
  id: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="12" r="2"/><path d="M14 10h4M14 14h4"/></svg>`,
  department: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2C10.5 21 3 13.5 3 6a2 2 0 0 1 2-2Z"/></svg>`,
  shift: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  issued: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m9 15 2 2 4-4"/></svg>`,
  expires: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m10 15 4 4M14 15l-4 4"/></svg>`,
};

function initials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

async function verify() {
  // Malformed or missing link — never worth a Firestore round trip.
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

  const detail = (icon, label, value) => `
    <div class="detail-item">
      <span class="detail-icon">${ICONS[icon]}</span>
      <div>
        <span class="detail-label">${escapeHtml(label)}</span>
        <strong class="detail-value">${escapeHtml(value || "—")}</strong>
      </div>
    </div>`;

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
  `;

  setHidden(el("employee"), false);
  setHidden(el("footer"), false);
  el("verifiedAt").textContent = `Verified ${new Date().toLocaleString()}`;
}

function showError(message) {
  setHidden(el("state"), true);
  const ring = document.querySelector(".badge-photo-ring");
  // A neutral "unresolved identity" mark, distinct from the warning icon
  // used in the message below — avoids showing the same glyph twice.
  ring.innerHTML = `<div class="badge-photo-fallback badge-photo-unknown">?</div>`;

  el("error").innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="error-icon"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
    <p>${escapeHtml(message)}</p>
  `;
  setHidden(el("error"), false);
  setHidden(el("footer"), false);
  el("verifiedAt").textContent = `Checked ${new Date().toLocaleString()}`;
}

verify();
