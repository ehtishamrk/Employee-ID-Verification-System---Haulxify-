import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { el, setHidden, escapeHtml } from "./common.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const params = new URLSearchParams(window.location.search);
const token = params.get("card") || "";

async function verify() {
  setHidden(el("state"), true);

  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
    showError("Invalid verification link.");
    return;
  }

  try {
    const snap = await getDoc(doc(db, "cards", token));
    if (!snap.exists()) {
      showError("This employee card is invalid, canceled, frozen, expired, or no longer exists.");
      return;
    }

    const card = snap.data();
    const now = new Date();
    const expiry = new Date(`${card.expiryDate}T23:59:59`);
    if (card.status !== "active" || Number.isNaN(expiry.getTime()) || expiry < now) {
      showError("This employee card is not currently valid.");
      return;
    }

    // Public verifier intentionally exposes only work identity fields.
    // Home address, emergency number and blood group remain admin-only.
    el("employee").innerHTML = `
      ${card.photoBase64 ? `<img class="employee-photo" src="${escapeHtml(card.photoBase64)}" alt="Employee photo">` : ""}
      <div class="verified-mark">✓ VERIFIED EMPLOYEE</div>
      <h1>${escapeHtml(card.name)}</h1>
      <p class="designation">${escapeHtml(card.designation)}</p>
      <div class="detail-grid">
        <div><span>Employee ID</span><strong>${escapeHtml(card.employeeId)}</strong></div>
        <div><span>Department</span><strong>${escapeHtml(card.department)}</strong></div>
        <div><span>Phone</span><strong>${escapeHtml(card.phone || "—")}</strong></div>
        <div><span>Shift</span><strong>${escapeHtml(card.shiftTimings || "—")}</strong></div>
        <div><span>Card Issued</span><strong>${escapeHtml(card.issueDate)}</strong></div>
        <div><span>Card Expires</span><strong>${escapeHtml(card.expiryDate)}</strong></div>
      </div>
    `;

    setHidden(el("employee"), false);
    setHidden(el("footer"), false);
    el("verifiedAt").textContent = `Verified ${new Date().toLocaleString()}`;
  } catch (error) {
    console.error(error);
    showError("Verification could not be completed. Please try again.");
  }
}

function showError(message) {
  el("error").textContent = message;
  setHidden(el("error"), false);
  setHidden(el("footer"), false);
  el("verifiedAt").textContent = `Checked ${new Date().toLocaleString()}`;
}

verify();
