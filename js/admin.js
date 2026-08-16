import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  el, setHidden, escapeHtml, dateToInputValue, addOneYear,
  generateToken, resizeImageToBase64
} from "./common.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentCards = [];
let selectedToken = "";
let activeQrCode = null; // current QRCodeStyling instance, kept for the download button

const loginView = el("loginView");
const appView = el("appView");
const form = el("cardForm");
const formMessage = el("formMessage");

el("issueDate").value = dateToInputValue(new Date());
el("expiryDate").value = addOneYear(el("issueDate").value);

el("issueDate").addEventListener("change", () => {
  el("expiryDate").value = addOneYear(el("issueDate").value);
});

el("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setHidden(el("loginError"), true);
  try {
    await signInWithEmailAndPassword(auth, el("email").value.trim(), el("password").value);
  } catch (error) {
    el("loginError").textContent = "Sign-in failed. Check your credentials and confirm this account is an authorized HAULXIFY admin.";
    setHidden(el("loginError"), false);
  }
});

el("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    setHidden(loginView, false);
    setHidden(appView, true);
    return;
  }

  try {
    // Admin authorization is enforced by Firestore Rules.
    const adminDoc = await getDoc(doc(db, "admins", user.uid));
    if (!adminDoc.exists()) {
      await signOut(auth);
      throw new Error("not-admin");
    }

    el("adminEmail").textContent = user.email || "";
    setHidden(loginView, true);
    setHidden(appView, false);
    await loadCards();
  } catch {
    setHidden(el("loginError"), false);
    el("loginError").textContent = "This account is not authorized as a HAULXIFY administrator.";
    setHidden(loginView, false);
    setHidden(appView, true);
  }
});

async function loadCards() {
  const snap = await getDocs(collection(db, "cards"));
  currentCards = snap.docs.map(d => ({ token: d.id, ...d.data() }));
  renderStats();
  renderCards();
}

function renderStats() {
  const total = currentCards.length;
  const active = currentCards.filter(c => c.status === "active").length;
  const frozen = currentCards.filter(c => c.status === "frozen").length;
  const canceled = currentCards.filter(c => c.status === "canceled").length;

  const in30Days = new Date();
  in30Days.setDate(in30Days.getDate() + 30);
  const expiringSoon = currentCards.filter(c => {
    if (c.status !== "active" || !c.expiryDate) return false;
    const expiry = new Date(`${c.expiryDate}T23:59:59`);
    return !Number.isNaN(expiry.getTime()) && expiry <= in30Days && expiry >= new Date();
  }).length;

  const stat = (label, value, accentClass = "") => `
    <div class="stat-card ${accentClass}">
      <span class="stat-value">${value}</span>
      <span class="stat-label">${escapeHtml(label)}</span>
    </div>`;

  el("statsBar").innerHTML = [
    stat("Total Cards", total),
    stat("Active", active, "accent-active"),
    stat("Frozen", frozen, "accent-frozen"),
    stat("Canceled", canceled, "accent-canceled"),
    stat("Expiring ≤ 30 Days", expiringSoon, "accent-expiring"),
  ].join("");
}

function formatTimestamp(ts) {
  if (!ts || typeof ts.toDate !== "function") return "—";
  return ts.toDate().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderCards() {
  const query = el("search").value.trim().toLowerCase();
  const filtered = currentCards.filter(c =>
    String(c.name || "").toLowerCase().includes(query) ||
    String(c.employeeId || "").toLowerCase().includes(query)
  );

  if (!filtered.length) {
    el("cardsTable").innerHTML = '<div class="empty">No cards found.</div>';
    return;
  }

  const rows = filtered.map(c => `
    <tr>
      <td class="mono">${escapeHtml(c.employeeId)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.department)}</td>
      <td><span class="badge ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
      <td class="mono">${escapeHtml(c.expiryDate || "")}</td>
      <td>${formatTimestamp(c.updatedAt)}</td>
      <td class="row-actions">
        <button class="btn small" data-action="select" data-token="${escapeHtml(c.token)}">Open</button>
        <button class="btn small" data-action="freeze" data-token="${escapeHtml(c.token)}">${c.status === "frozen" ? "Unfreeze" : "Freeze"}</button>
        <button class="btn small danger-outline" data-action="cancel" data-token="${escapeHtml(c.token)}">Cancel</button>
      </td>
    </tr>
  `).join("");

  el("cardsTable").innerHTML = `
    <table>
      <thead><tr>
        <th>Employee ID</th><th>Name</th><th>Department</th><th>Status</th><th>Expiry</th><th>Updated</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  el("cardsTable").querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => handleCardAction(btn.dataset.action, btn.dataset.token));
  });
}

el("search").addEventListener("input", renderCards);

async function handleCardAction(action, token) {
  const card = currentCards.find(c => c.token === token);
  if (!card) return;

  if (action === "select") {
    fillForm(card);
    selectedToken = token;
    showQr(token);
    return;
  }

  if (action === "freeze") {
    const next = card.status === "frozen" ? "active" : "frozen";
    await setDoc(doc(db, "cards", token), {
      status: next,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || ""
    }, { merge: true });
    await loadCards();
    return;
  }

  if (action === "cancel") {
    const ok = confirm(`Cancel card for ${card.name} (${card.employeeId})? The old QR will stop working.`);
    if (!ok) return;
    await setDoc(doc(db, "cards", token), {
      status: "canceled",
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || ""
    }, { merge: true });
    await loadCards();
  }
}

function fillForm(card) {
  el("editingToken").value = card.token;
  el("name").value = card.name || "";
  el("designation").value = card.designation || "";
  el("employeeId").value = card.employeeId || "";
  el("department").value = card.department || "";
  el("phone").value = card.phone || "";
  el("emergencyNumber").value = card.emergencyNumber || "";
  el("joiningDate").value = card.joiningDate || "";
  el("issueDate").value = card.issueDate || "";
  el("expiryDate").value = card.expiryDate || "";
  el("shiftTimings").value = card.shiftTimings || "";
  el("homeAddress").value = card.homeAddress || "";
  el("bloodGroup").value = card.bloodGroup || "";
  setHidden(el("deleteBtn"), false);

  el("editingName").textContent = card.name || "this employee";
  setHidden(el("editingBanner"), false);
}

function resetForm() {
  form.reset();
  el("editingToken").value = "";
  el("issueDate").value = dateToInputValue(new Date());
  el("expiryDate").value = addOneYear(el("issueDate").value);
  setHidden(el("deleteBtn"), true);
  setHidden(el("editingBanner"), true);
  selectedToken = "";
  activeQrCode = null;
  setHidden(el("qrArea"), true);
  setHidden(el("qrEmpty"), false);
  setHidden(formMessage, true);
}

el("resetBtn").addEventListener("click", resetForm);
el("cancelEditBtn").addEventListener("click", resetForm);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setHidden(formMessage, true);

  const editing = el("editingToken").value.trim();
  const employeeId = el("employeeId").value.trim();

  // Soft duplicate check — Firestore doesn't enforce uniqueness for us, so
  // warn rather than silently issuing a second active card for the same ID.
  if (!editing) {
    const clash = currentCards.find(c => c.employeeId === employeeId && c.status === "active");
    if (clash) {
      const proceed = confirm(
        `An active card already exists for Employee ID ${employeeId} (${clash.name}).\n\nIssue another card anyway?`
      );
      if (!proceed) return;
    }
  }

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const old = editing ? currentCards.find(c => c.token === editing) : null;
    const token = editing || generateToken();

    let photoBase64 = old?.photoBase64 || "";
    const photoFile = el("photo").files?.[0];
    if (photoFile) photoBase64 = await resizeImageToBase64(photoFile);

    const issueDate = el("issueDate").value;
    const expiryDate = addOneYear(issueDate);
    const adminEmail = auth.currentUser?.email || "";

    const payload = {
      name: el("name").value.trim(),
      designation: el("designation").value.trim(),
      employeeId,
      department: el("department").value.trim(),
      phone: el("phone").value.trim(),
      emergencyNumber: el("emergencyNumber").value.trim(),
      joiningDate: el("joiningDate").value,
      issueDate,
      expiryDate,
      expiryAt: Timestamp.fromDate(new Date(`${expiryDate}T23:59:59`)),
      shiftTimings: el("shiftTimings").value.trim(),
      homeAddress: el("homeAddress").value.trim(),
      bloodGroup: el("bloodGroup").value,
      photoBase64,
      status: old?.status === "canceled" ? "active" : (old?.status || "active"),
      createdAt: old?.createdAt || serverTimestamp(),
      issuedBy: old?.issuedBy || adminEmail,
      updatedAt: serverTimestamp(),
      updatedBy: adminEmail
    };

    await setDoc(doc(db, "cards", token), payload, { merge: true });

    selectedToken = token;
    showQr(token);
    showMessage("Card saved. Download the QR and place it on your Canva template.");
    await loadCards();
    fillForm({ ...payload, token });
  } catch (error) {
    console.error(error);
    showMessage(error.message || "Unable to save card.", true);
  } finally {
    submitBtn.disabled = false;
  }
});

el("deleteBtn").addEventListener("click", async () => {
  const token = el("editingToken").value.trim();
  if (!token) return;
  const name = el("name").value.trim();
  const ok = confirm(`PERMANENTLY delete ${name || "this card"}?\n\nThis removes the entire card document from Firebase. The QR will become invalid.`);
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "cards", token));
    resetForm();
    await loadCards();
    showMessage("Card data permanently deleted from Firestore.");
  } catch (error) {
    console.error(error);
    showMessage(error.message || "Delete failed.", true);
  }
});

function showMessage(text, isError = false) {
  formMessage.textContent = text;
  formMessage.className = `notice ${isError ? "error" : ""}`;
  setHidden(formMessage, false);
}

function showQr(token) {
  const verifyUrl = new URL("verify.html", window.location.href);
  verifyUrl.searchParams.set("card", token);

  el("qrCode").innerHTML = "";

  // High-resolution, rounded-module QR — generated well above display size
  // so the downloaded PNG stays crisp on a printed badge, not just on screen.
  activeQrCode = new QRCodeStyling({
    width: 1200,
    height: 1200,
    type: "canvas",
    data: verifyUrl.href,
    margin: 24,
    qrOptions: { errorCorrectionLevel: "H" },
    dotsOptions: { type: "extra-rounded", color: "#102f55" },
    cornersSquareOptions: { type: "extra-rounded", color: "#102f55" },
    cornersDotOptions: { type: "dot", color: "#f56a09" },
    backgroundOptions: { color: "#ffffff" },
    image: "assets/logo.webp",
    imageOptions: { crossOrigin: "anonymous", margin: 14, imageSize: 0.32 }
  });

  activeQrCode.append(el("qrCode"));

  el("qrLink").textContent = verifyUrl.href;
  setHidden(el("qrEmpty"), true);
  setHidden(el("qrArea"), false);
}

el("downloadQrBtn").addEventListener("click", () => {
  if (!activeQrCode) return;
  const employeeId = el("employeeId").value.trim() || "employee";
  activeQrCode.download({ name: `HAULXIFY-QR-${employeeId}`, extension: "png" });
});

el("copyLinkBtn").addEventListener("click", async () => {
  const url = el("qrLink").textContent.trim();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    const btn = el("copyLinkBtn");
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    showMessage("Couldn't copy the link — select and copy it manually.", true);
  }
});
