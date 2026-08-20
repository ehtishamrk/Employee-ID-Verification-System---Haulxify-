import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc,
  query, where, runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  el, setHidden, escapeHtml, dateToInputValue, addOneYear,
  generateToken, resizeImageToBase64, PASS_COUNT, padPassId, formatDateTime
} from "./common.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentCards = [];
let currentPasses = [];
let currentRole = null; // "admin" | "receptionist"
let selectedToken = "";
let activeQrCode = null; // employee-card QR instance, kept for the download button
const passQrInstances = {}; // one QRCodeStyling instance per pass tile

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
    el("loginError").textContent = "Sign-in failed. Check your credentials and confirm this account is authorized.";
    setHidden(el("loginError"), false);
  }
});

el("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentRole = null;
    setHidden(loginView, false);
    setHidden(appView, true);
    return;
  }

  try {
    const role = await resolveRole(user.uid);
    if (!role) {
      await signOut(auth);
      throw new Error("not-authorized");
    }
    currentRole = role;

    el("adminEmail").textContent = `${user.email || ""} (${role === "admin" ? "Admin" : "Reception"})`;
    setHidden(loginView, true);
    setHidden(appView, false);

    // Employee-card management stays admin-only; receptionists only see
    // the Visitor Passes tools. Both roles still need the employee list
    // loaded in the background for the "Issue a Pass" host search below.
    setHidden(el("employeeSection"), role !== "admin");

    await loadCards();
    if (role === "admin") await ensurePasses();
    await loadPasses();
    await loadActiveVisits();
  } catch {
    setHidden(el("loginError"), false);
    el("loginError").textContent = "This account isn't authorized for the Admin Portal.";
    setHidden(loginView, false);
    setHidden(appView, true);
  }
});

async function resolveRole(uid) {
  const adminSnap = await getDoc(doc(db, "admins", uid));
  if (adminSnap.exists()) return "admin";
  const recSnap = await getDoc(doc(db, "receptionists", uid));
  if (recSnap.exists()) return "receptionist";
  return null;
}

// ---------------------------------------------------------------------
// Employee cards (admin only) — unchanged from the original card system
// ---------------------------------------------------------------------
async function loadCards() {
  const snap = await getDocs(collection(db, "cards"));
  currentCards = snap.docs.map(d => ({ token: d.id, ...d.data() }));
  if (currentRole === "admin") {
    renderStats();
    renderCards();
  }
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
  const searchQuery = el("search").value.trim().toLowerCase();
  const filtered = currentCards.filter(c =>
    String(c.name || "").toLowerCase().includes(searchQuery) ||
    String(c.employeeId || "").toLowerCase().includes(searchQuery)
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

// ---------------------------------------------------------------------
// Visitor passes — 18 fixed physical badges, shared by admins + reception
// ---------------------------------------------------------------------
async function ensurePasses() {
  // Deterministic doc IDs ("01".."18") make this safe to re-run: creating
  // a doc that already exists with the same ID via setDoc/merge is a no-op
  // for existing fields, so this never resets a pass that's in use.
  const snap = await getDocs(collection(db, "passes"));
  const existingIds = new Set(snap.docs.map(d => d.id));
  const missing = [];
  for (let i = 1; i <= PASS_COUNT; i++) {
    const id = padPassId(i);
    if (!existingIds.has(id)) missing.push(id);
  }
  if (!missing.length) return;
  await Promise.all(missing.map(id =>
    setDoc(doc(db, "passes", id), { status: "free", activeVisitId: null, updatedAt: serverTimestamp() })
  ));
}

async function loadPasses() {
  const snap = await getDocs(collection(db, "passes"));
  currentPasses = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  renderPassGrid();
  renderIssuePassOptions();
}

const LOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;

function renderPassGrid() {
  if (!currentPasses.length) {
    el("passGrid").innerHTML = currentRole === "admin"
      ? '<div class="empty">Setting up the 18 visitor passes…</div>'
      : '<div class="empty">No visitor passes are set up yet. Ask an admin to sign in once to create them.</div>';
    return;
  }

  el("passGrid").innerHTML = currentPasses.map(p => `
    <div class="pass-tile ${p.status === "free" ? "is-free" : "is-occupied"}">
      <div class="pass-lock">${LOCK_ICON}</div>
      <div class="pass-number">#${escapeHtml(p.id)}</div>
      <span class="pass-tile-status">${p.status === "free" ? "Free" : "Occupied"}</span>
      <div class="qr-box" id="passQrBox-${p.id}" style="margin-bottom:10px"></div>
      <button class="btn small primary full" data-action="download-pass" data-pass-id="${p.id}" type="button">Download QR</button>
      ${currentRole === "admin" && p.status === "occupied"
        ? `<button class="btn small danger-outline full" data-action="force-free" data-pass-id="${p.id}" type="button" style="margin-top:6px">Force Free</button>`
        : ""}
    </div>
  `).join("");

  currentPasses.forEach(p => renderPassQr(p.id));

  el("passGrid").querySelectorAll('button[data-action="download-pass"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.passId;
      passQrInstances[id]?.download({ name: `HAULXIFY-VisitorPass-${id}`, extension: "png" });
    });
  });
  el("passGrid").querySelectorAll('button[data-action="force-free"]').forEach(btn => {
    btn.addEventListener("click", () => forceFreePass(btn.dataset.passId));
  });
}

function renderPassQr(passId) {
  const container = document.getElementById(`passQrBox-${passId}`);
  if (!container) return;
  const verifyUrl = new URL("verify.html", window.location.href);
  verifyUrl.searchParams.set("pass", passId);

  // Locked by design — the QR only ever encodes the pass number, never any
  // visitor data. Generated at print resolution (800x800) and simply
  // displayed smaller via CSS, so the same instance serves both the grid
  // preview and the "Download QR" button.
  const qr = new QRCodeStyling({
    width: 800,
    height: 800,
    type: "canvas",
    data: verifyUrl.href,
    margin: 20,
    qrOptions: { errorCorrectionLevel: "M" },
    dotsOptions: { type: "extra-rounded", color: "#102f55" },
    cornersSquareOptions: { type: "extra-rounded", color: "#102f55" },
    cornersDotOptions: { type: "dot", color: "#f56a09" },
    backgroundOptions: { color: "#ffffff" }
  });
  qr.append(container);
  passQrInstances[passId] = qr;
}

async function forceFreePass(passId) {
  const pass = currentPasses.find(p => p.id === passId);
  if (!pass) return;
  const ok = confirm(`Force pass #${passId} back to Free?\n\nOnly do this for a lost pass or a stuck record — it closes out any in-progress visit without a proper checkout time.`);
  if (!ok) return;

  try {
    if (pass.activeVisitId) {
      await updateDoc(doc(db, "visits", pass.activeVisitId), {
        status: "completed",
        timeOut: serverTimestamp(),
        completedBy: `${auth.currentUser?.email || ""} (force-freed)`
      }).catch(() => { /* visit doc may already be missing — non-fatal */ });
    }
    await updateDoc(doc(db, "passes", passId), {
      status: "free",
      activeVisitId: null,
      updatedAt: serverTimestamp()
    });
    await loadPasses();
    await loadActiveVisits();
  } catch (error) {
    console.error(error);
    alert(error.message || "Couldn't force-free this pass.");
  }
}

// ---- Active visits table ----
async function loadActiveVisits() {
  const snap = await getDocs(query(collection(db, "visits"), where("status", "==", "active")));
  const visits = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.timeIn?.toDate?.() || 0) - (b.timeIn?.toDate?.() || 0));

  if (!visits.length) {
    el("activeVisitsTable").innerHTML = '<div class="empty">No visitors currently checked in.</div>';
    return;
  }

  const rows = visits.map(v => `
    <tr>
      <td class="mono">#${escapeHtml(v.passId)}</td>
      <td>${escapeHtml(v.visitorName)}</td>
      <td>${escapeHtml(v.hostName || "")}</td>
      <td>${escapeHtml(v.purpose || "")}</td>
      <td>${formatDateTime(v.timeIn)}</td>
      <td class="row-actions">
        <button class="btn small" data-action="mark-exit" data-visit-id="${escapeHtml(v.id)}" data-pass-id="${escapeHtml(v.passId)}">Mark Exit</button>
      </td>
    </tr>
  `).join("");

  el("activeVisitsTable").innerHTML = `
    <table>
      <thead><tr><th>Pass</th><th>Visitor</th><th>Host</th><th>Purpose</th><th>Time In</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  el("activeVisitsTable").querySelectorAll('button[data-action="mark-exit"]').forEach(btn => {
    btn.addEventListener("click", () => openMarkExitModal(btn.dataset.visitId, btn.dataset.passId));
  });
}

function openAdminModal(html) {
  document.getElementById("adminModalContent").innerHTML = html;
  setHidden(el("adminModalOverlay"), false);
}
function closeAdminModal() {
  setHidden(el("adminModalOverlay"), true);
  document.getElementById("adminModalContent").innerHTML = "";
}
el("adminModalClose").addEventListener("click", closeAdminModal);
el("adminModalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "adminModalOverlay") closeAdminModal();
});

function nowLocalInputValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openMarkExitModal(visitId, passId) {
  openAdminModal(`
    <h2>Mark Visitor Exit</h2>
    <p class="muted">Pass #${escapeHtml(passId)} — confirm the visitor is leaving and free the pass.</p>
    <form id="adminMarkExitForm" class="form-grid">
      <label class="full">Time Out
        <input id="adminMeTimeOut" type="datetime-local" value="${nowLocalInputValue()}" required>
      </label>
      <div class="form-actions full">
        <button type="submit" class="btn primary full">Confirm Exit &amp; Free Pass</button>
      </div>
      <div id="adminMarkExitError" class="notice error hidden full"></div>
    </form>
  `);

  document.getElementById("adminMarkExitForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("adminMarkExitError");
    setHidden(errorEl, true);
    const submitBtn = event.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const timeOutValue = document.getElementById("adminMeTimeOut").value;
      await updateDoc(doc(db, "visits", visitId), {
        timeOut: Timestamp.fromDate(new Date(timeOutValue)),
        status: "completed",
        completedBy: auth.currentUser?.email || ""
      });
      await updateDoc(doc(db, "passes", passId), {
        status: "free",
        activeVisitId: null,
        updatedAt: serverTimestamp()
      });
      closeAdminModal();
      await loadPasses();
      await loadActiveVisits();
    } catch (error) {
      errorEl.textContent = error.message || "Couldn't mark this visit as exited.";
      setHidden(errorEl, false);
      submitBtn.disabled = false;
    }
  });
}

// ---- Manual "Issue a Pass" form (fallback path, no scanning required) ----
function renderIssuePassOptions() {
  const select = el("vpPassId");
  const free = currentPasses.filter(p => p.status === "free");
  select.innerHTML = free.length
    ? `<option value="">Select an available pass</option>` + free.map(p => `<option value="${p.id}">Pass #${p.id}</option>`).join("")
    : `<option value="">No passes free right now</option>`;
}

el("vpHostSearch").addEventListener("input", () => {
  const term = el("vpHostSearch").value.trim().toLowerCase();
  const results = el("vpHostResults");
  if (term.length < 2) { results.innerHTML = ""; return; }
  const matches = currentCards
    .filter(c => c.status === "active" && (c.name?.toLowerCase().includes(term) || c.employeeId?.toLowerCase().includes(term)))
    .slice(0, 6);
  results.innerHTML = matches.map(c => `
    <div class="host-result" data-token="${escapeHtml(c.token)}" data-name="${escapeHtml(c.name)}" data-dept="${escapeHtml(c.department || "")}">
      <span>${escapeHtml(c.name)} <small>${escapeHtml(c.department || "")}</small></span>
      <small>${escapeHtml(c.employeeId)}</small>
    </div>
  `).join("") || `<div class="host-result">No active employees match "${escapeHtml(el("vpHostSearch").value.trim())}"</div>`;

  results.querySelectorAll(".host-result[data-token]").forEach(row => {
    row.addEventListener("click", () => {
      el("vpHostToken").value = row.dataset.token;
      el("vpHostName").value = row.dataset.name;
      el("vpHostDept").value = row.dataset.dept;
      el("vpHostSearch").value = `${row.dataset.name} — ${row.dataset.dept}`;
      results.innerHTML = "";
    });
  });
});

el("issuePassFormAdmin").addEventListener("submit", async (event) => {
  event.preventDefault();
  const msgEl = el("issuePassAdminMessage");
  setHidden(msgEl, true);

  const passId = el("vpPassId").value;
  const hostToken = el("vpHostToken").value.trim();
  if (!passId) { msgEl.textContent = "Pick a pass number."; msgEl.className = "notice error"; setHidden(msgEl, false); return; }
  if (!hostToken) { msgEl.textContent = "Pick the host employee from the search results."; msgEl.className = "notice error"; setHidden(msgEl, false); return; }

  const submitBtn = event.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const passRef = doc(db, "passes", passId);
    const visitRef = doc(collection(db, "visits"));
    const payload = {
      passId,
      visitorName: el("vpVisitorName").value.trim(),
      idType: el("vpIdType").value,
      idNumber: el("vpIdNumber").value.trim(),
      phone: el("vpPhone").value.trim(),
      purpose: el("vpPurpose").value.trim(),
      hostToken,
      hostName: el("vpHostName").value.trim(),
      hostDepartment: el("vpHostDept").value.trim(),
      timeIn: serverTimestamp(),
      timeOut: null,
      status: "active",
      issuedBy: auth.currentUser?.email || ""
    };

    // The full SDK is available here (unlike the lite-SDK scan flow in
    // verify.html), so this manual/fallback path gets a real atomic
    // transaction: two people can't issue the same pass at once.
    await runTransaction(db, async (tx) => {
      const passSnap = await tx.get(passRef);
      if (!passSnap.exists() || passSnap.data().status !== "free") {
        throw new Error("This pass was just taken. Pick a different one.");
      }
      tx.set(visitRef, payload);
      tx.update(passRef, { status: "occupied", activeVisitId: visitRef.id, updatedAt: serverTimestamp() });
    });

    event.target.reset();
    el("vpHostToken").value = "";
    el("vpHostName").value = "";
    el("vpHostDept").value = "";
    el("vpHostResults").innerHTML = "";
    msgEl.textContent = `Pass #${passId} issued to ${payload.visitorName}. Hand them the matching physical pass.`;
    msgEl.className = "notice";
    setHidden(msgEl, false);

    await loadPasses();
    await loadActiveVisits();
  } catch (error) {
    console.error(error);
    msgEl.textContent = error.message || "Couldn't issue this pass.";
    msgEl.className = "notice error";
    setHidden(msgEl, false);
  } finally {
    submitBtn.disabled = false;
  }
});
