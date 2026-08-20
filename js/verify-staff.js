// Lazily loaded ONLY when someone taps "Staff sign-in" (card mode) or scans
// a visitor pass (pass mode always needs it — there's no public use for a
// pass view). Never imported from the eager critical path in verify.js.
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore-lite.js";

let mounted = false;
let auth = null;
let signedIn = false;
let currentEmail = "";
let pendingCallbacks = [];
let activeCardsCache = null;

let resolveAuthReady;
const authReady = new Promise((resolve) => { resolveAuthReady = resolve; });

async function resolveRole(db, uid) {
  const adminSnap = await getDoc(doc(db, "admins", uid));
  if (adminSnap.exists()) return "admin";
  const recSnap = await getDoc(doc(db, "receptionists", uid));
  if (recSnap.exists()) return "receptionist";
  return null;
}

function nowLocalInputValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function loadScriptOnce(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load scanner library"));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------------
// Staff bar (sign-in / sign-out UI, at the bottom of verify.html)
// ---------------------------------------------------------------------
export function mountStaffBar(ctx) {
  if (mounted) return;
  mounted = true;
  auth = getAuth(ctx.app);

  document.getElementById("staffForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("staffError");
    ctx.setHidden(errorEl, true);
    const email = document.getElementById("staffEmail").value.trim();
    const password = document.getElementById("staffPassword").value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged below resolves the rest (role check + UI update).
    } catch {
      errorEl.textContent = "Sign-in failed. Check your email and password.";
      ctx.setHidden(errorEl, false);
    }
  });

  document.getElementById("staffSignOut").addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      signedIn = false;
      currentEmail = "";
      renderSignedOutUI();
      resolveAuthReady();
      return;
    }
    const role = await resolveRole(ctx.db, user.uid);
    if (!role) {
      await signOut(auth);
      const errorEl = document.getElementById("staffError");
      errorEl.textContent = "This account isn't authorized for reception access.";
      ctx.setHidden(errorEl, false);
      signedIn = false;
      renderSignedOutUI();
      resolveAuthReady();
      return;
    }
    signedIn = true;
    currentEmail = user.email || "";
    renderSignedInUI();
    resolveAuthReady();
    const callbacks = pendingCallbacks;
    pendingCallbacks = [];
    callbacks.forEach((cb) => cb());
  });
}

function renderSignedInUI() {
  document.getElementById("staffToggle").classList.add("hidden");
  document.getElementById("staffForm").classList.add("hidden");
  document.getElementById("staffEmailLabel").textContent = currentEmail;
  document.getElementById("staffSignedIn").classList.remove("hidden");
}

function renderSignedOutUI() {
  document.getElementById("staffSignedIn").classList.add("hidden");
  const form = document.getElementById("staffForm");
  const toggle = document.getElementById("staffToggle");
  toggle.textContent = "Staff sign-in";
  // Only show the toggle link if the form isn't already open — otherwise
  // this fights with toggleSignInForm() when the first auth-state check
  // (confirming "not signed in yet") resolves right after someone opens
  // the form, and the link reappears redundantly above it.
  toggle.classList.toggle("hidden", !form.classList.contains("hidden"));
}

export function toggleSignInForm(forceOpen) {
  if (signedIn) return; // already showing the signed-in strip
  const form = document.getElementById("staffForm");
  const toggle = document.getElementById("staffToggle");
  const shouldShow = forceOpen || form.classList.contains("hidden");
  form.classList.toggle("hidden", !shouldShow);
  toggle.classList.toggle("hidden", shouldShow);
  if (shouldShow) document.getElementById("staffEmail").focus();
}

export function onSignedIn(callback) {
  if (signedIn) { callback(); return; }
  pendingCallbacks.push(callback);
}

// Only ever called after an explicit user action (tapping "Staff sign-in"),
// never automatically — see verify.js for why that matters.
export async function tryAutoReveal(ctx) {
  await authReady;
  if (!signedIn) return;
  const wrap = document.getElementById("staffActions");
  if (!wrap || !ctx.hostCard) return;
  wrap.innerHTML = `<button class="btn primary" type="button" id="issuePassFromCardBtn">Issue Visitor Pass for ${ctx.escapeHtml(ctx.hostCard.name)}</button>`;
  document.getElementById("issuePassFromCardBtn").addEventListener("click", () => {
    openIssuePassModal(ctx, {
      hostToken: ctx.hostCard.token,
      hostName: ctx.hostCard.name,
      hostDepartment: ctx.hostCard.department
    });
  });
  wrap.classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Visitor pass mode — load + render a specific pass after sign-in
// ---------------------------------------------------------------------
export async function loadPass(ctx, passId) {
  try {
    const passSnap = await getDoc(doc(ctx.db, "passes", passId));
    if (!passSnap.exists()) {
      renderPassMissing(ctx, passId);
      return;
    }
    const pass = passSnap.data();
    if (pass.status === "occupied" && pass.activeVisitId) {
      const visitSnap = await getDoc(doc(ctx.db, "visits", pass.activeVisitId));
      renderPassOccupied(ctx, passId, visitSnap.exists() ? { id: visitSnap.id, ...visitSnap.data() } : null);
    } else {
      renderPassFree(ctx, passId);
    }
  } catch (error) {
    console.error(error);
    ctx.showError("Couldn't load this pass. Check your connection and try again.");
  }
}

function renderPassMissing(ctx, passId) {
  ctx.el("passPanel").innerHTML = `
    <div class="pass-status-badge locked">Not Set Up</div>
    <h1>Pass #${ctx.escapeHtml(passId)}</h1>
    <p class="designation">This pass hasn't been created yet — set up the 18 passes from the Admin Portal.</p>
  `;
}

function renderPassFree(ctx, passId) {
  ctx.el("passPanel").innerHTML = `
    <div class="pass-status-badge free">Available</div>
    <h1>Visitor Pass #${ctx.escapeHtml(passId)}</h1>
    <p class="designation">Ready to issue to a new visitor</p>
    <button class="btn primary full" type="button" id="issueFromPassBtn">Issue This Pass</button>
  `;
  document.getElementById("issueFromPassBtn").addEventListener("click", () => {
    openIssuePassModal(ctx, { passId });
  });
}

function renderPassOccupied(ctx, passId, visit) {
  if (!visit) {
    ctx.el("passPanel").innerHTML = `
      <div class="pass-status-badge occupied">Checked In</div>
      <h1>Visitor Pass #${ctx.escapeHtml(passId)}</h1>
      <p class="designation">This pass shows occupied but its visit record is missing. Use "Force free" in the Admin Portal to reset it.</p>
    `;
    return;
  }
  ctx.el("passPanel").innerHTML = `
    <div class="pass-status-badge occupied">Checked In</div>
    <h1>${ctx.escapeHtml(visit.visitorName)}</h1>
    <p class="designation">Visitor Pass #${ctx.escapeHtml(passId)}</p>
    <div class="detail-grid">
      ${ctx.detail("purpose", "Purpose of Visit", visit.purpose)}
      ${ctx.detail("id", ctx.ID_TYPES[visit.idType] || "ID Number", visit.idNumber)}
      ${ctx.detail("phone", "Phone", visit.phone)}
      ${ctx.detail("host", "Visiting", visit.hostName)}
      ${ctx.detail("issued", "Time In", ctx.formatDateTime(visit.timeIn))}
    </div>
    <button class="btn primary full" type="button" id="markExitBtn">Mark Exit</button>
  `;
  document.getElementById("markExitBtn").addEventListener("click", () => {
    openMarkExitModal(ctx, passId, visit);
  });
}

// ---------------------------------------------------------------------
// Issue Pass modal
// ---------------------------------------------------------------------
async function getFreePassIds(db) {
  const snap = await getDocs(query(collection(db, "passes"), where("status", "==", "free")));
  return snap.docs.map((d) => d.id).sort();
}

async function getActiveCards(db) {
  if (activeCardsCache) return activeCardsCache;
  const snap = await getDocs(query(collection(db, "cards"), where("status", "==", "active")));
  activeCardsCache = snap.docs.map((d) => ({ token: d.id, ...d.data() }));
  return activeCardsCache;
}

async function openIssuePassModal(ctx, prefill) {
  let freePassIds = [];
  if (!prefill.passId) {
    freePassIds = await getFreePassIds(ctx.db);
  }

  const noPassesAvailable = !prefill.passId && freePassIds.length === 0;

  if (noPassesAvailable) {
    ctx.openModal(`
      <h2>Issue Visitor Pass</h2>
      <p class="notice error">No passes are free right now. Wait for one to be returned, or set up more from the Admin Portal.</p>
      <button class="btn ghost full" type="button" id="noPassCloseBtn">Close</button>
    `);
    document.getElementById("noPassCloseBtn").addEventListener("click", ctx.closeModal);
    return;
  }

  const passField = prefill.passId
    ? `<label class="full">Pass Number
        <input value="Pass #${ctx.escapeHtml(prefill.passId)}" disabled>
       </label>
       <input type="hidden" id="ipPassId" value="${ctx.escapeHtml(prefill.passId)}">`
    : `<label class="full">Pass Number *
        <select id="ipPassId" required>
          <option value="">Select an available pass</option>
          ${freePassIds.map((id) => `<option value="${id}">Pass #${id}</option>`).join("")}
        </select>
       </label>`;

  const hostField = prefill.hostToken
    ? `<label class="full">Host Employee</label>
       <div class="host-picked full">
         <span>${ctx.escapeHtml(prefill.hostName)} — ${ctx.escapeHtml(prefill.hostDepartment || "")}</span>
       </div>
       <input type="hidden" id="ipHostToken" value="${ctx.escapeHtml(prefill.hostToken)}">
       <input type="hidden" id="ipHostName" value="${ctx.escapeHtml(prefill.hostName)}">
       <input type="hidden" id="ipHostDept" value="${ctx.escapeHtml(prefill.hostDepartment || "")}">`
    : `<label class="full">Host Employee (who they're visiting) *
         <input id="ipHostSearch" placeholder="Search by name or employee ID" autocomplete="off" required>
       </label>
       <div id="hostResults" class="host-results-list full"></div>
       <input type="hidden" id="ipHostToken">
       <input type="hidden" id="ipHostName">
       <input type="hidden" id="ipHostDept">
       <button type="button" class="scan-toggle full" id="scanBadgeBtn">or scan the employee's badge</button>
       <div id="scanArea" class="full"></div>`;

  ctx.openModal(`
    <h2>Issue Visitor Pass</h2>
    <p class="muted">Capture the visitor's details, then hand them the matching physical pass.</p>
    <form id="issuePassForm" class="form-grid">
      <div id="passPickerWrap" class="full form-grid" style="padding:0">${passField}</div>
      <div id="hostPickerWrap" class="full form-grid" style="padding:0">${hostField}</div>

      <label class="full">Visitor Name *<input id="ipVisitorName" required maxlength="100"></label>
      <label>ID Type *
        <select id="ipIdType" required>
          <option value="cnic">CNIC</option>
          <option value="license">Driving License</option>
          <option value="passport">Passport</option>
        </select>
      </label>
      <label>ID Number *<input id="ipIdNumber" required maxlength="60"></label>
      <label class="full">Phone Number<input id="ipPhone" type="tel" maxlength="30"></label>
      <label class="full">Purpose of Visit *<input id="ipPurpose" required maxlength="150"></label>

      <div class="form-actions full">
        <button type="submit" class="btn primary full">Issue Pass</button>
      </div>
      <div id="issuePassError" class="notice error hidden full"></div>
    </form>
  `);

  if (!prefill.hostToken) {
    wireHostSearch(ctx);
  }

  document.getElementById("issuePassForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("issuePassError");
    ctx.setHidden(errorEl, true);

    const passId = document.getElementById("ipPassId")?.value?.trim() || "";
    const hostToken = document.getElementById("ipHostToken").value.trim();
    const hostName = document.getElementById("ipHostName").value.trim();
    const hostDepartment = document.getElementById("ipHostDept").value.trim();

    if (!passId) { errorEl.textContent = "Pick a pass number."; ctx.setHidden(errorEl, false); return; }
    if (!hostToken) { errorEl.textContent = "Pick the host employee from the search results."; ctx.setHidden(errorEl, false); return; }

    const submitBtn = event.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await issuePass(ctx, {
        passId,
        hostToken, hostName, hostDepartment,
        visitorName: document.getElementById("ipVisitorName").value.trim(),
        idType: document.getElementById("ipIdType").value,
        idNumber: document.getElementById("ipIdNumber").value.trim(),
        phone: document.getElementById("ipPhone").value.trim(),
        purpose: document.getElementById("ipPurpose").value.trim(),
      });
      showIssueConfirmation(ctx, passId, document.getElementById("ipVisitorName").value.trim());
    } catch (error) {
      errorEl.textContent = error.message || "Couldn't issue this pass. Try again.";
      ctx.setHidden(errorEl, false);
      submitBtn.disabled = false;
    }
  });
}

function wireHostSearch(ctx) {
  const input = document.getElementById("ipHostSearch");
  const results = document.getElementById("hostResults");

  input.addEventListener("input", async () => {
    const term = input.value.trim().toLowerCase();
    if (term.length < 2) { results.innerHTML = ""; return; }
    const cards = await getActiveCards(ctx.db);
    const matches = cards
      .filter((c) => c.name?.toLowerCase().includes(term) || c.employeeId?.toLowerCase().includes(term))
      .slice(0, 6);
    results.innerHTML = matches.map((c) => `
      <div class="host-result" data-token="${ctx.escapeHtml(c.token)}" data-name="${ctx.escapeHtml(c.name)}" data-dept="${ctx.escapeHtml(c.department || "")}">
        <span>${ctx.escapeHtml(c.name)} <small>${ctx.escapeHtml(c.department || "")}</small></span>
        <small>${ctx.escapeHtml(c.employeeId)}</small>
      </div>
    `).join("") || `<div class="host-result">No active employees match "${ctx.escapeHtml(input.value.trim())}"</div>`;

    results.querySelectorAll(".host-result[data-token]").forEach((row) => {
      row.addEventListener("click", () => {
        pickHost(ctx, row.dataset.token, row.dataset.name, row.dataset.dept);
      });
    });
  });

  document.getElementById("scanBadgeBtn")?.addEventListener("click", () => startBadgeScan(ctx));
}

let activeScanStop = null;

function pickHost(ctx, token, name, department) {
  // If a badge-scan camera session is still running (e.g. the receptionist
  // switched to typing a search instead of finishing the scan), stop it —
  // otherwise the camera hardware keeps running after its UI is gone.
  activeScanStop?.();
  document.getElementById("ipHostToken").value = token;
  document.getElementById("ipHostName").value = name;
  document.getElementById("ipHostDept").value = department || "";

  const wrap = document.getElementById("hostPickerWrap");
  wrap.innerHTML = `
    <label class="full">Host Employee</label>
    <div class="host-picked full">
      <span>${ctx.escapeHtml(name)} — ${ctx.escapeHtml(department || "")}</span>
      <button type="button" id="changeHostBtn">change</button>
    </div>
    <input type="hidden" id="ipHostToken" value="${ctx.escapeHtml(token)}">
    <input type="hidden" id="ipHostName" value="${ctx.escapeHtml(name)}">
    <input type="hidden" id="ipHostDept" value="${ctx.escapeHtml(department || "")}">
  `;
  document.getElementById("changeHostBtn").addEventListener("click", () => {
    const hostField = `
      <label class="full">Host Employee (who they're visiting) *
        <input id="ipHostSearch" placeholder="Search by name or employee ID" autocomplete="off" required>
      </label>
      <div id="hostResults" class="host-results-list full"></div>
      <input type="hidden" id="ipHostToken">
      <input type="hidden" id="ipHostName">
      <input type="hidden" id="ipHostDept">
      <button type="button" class="scan-toggle full" id="scanBadgeBtn">or scan the employee's badge</button>
      <div id="scanArea" class="full"></div>`;
    document.getElementById("hostPickerWrap").innerHTML = hostField;
    wireHostSearch(ctx);
  });
}

// Camera badge scan — optional shortcut, fully isolated: any failure here
// (no camera, permission denied, library fails to load) just leaves the
// search box as the working path. Nothing about issuing a pass depends on
// this succeeding.
async function startBadgeScan(ctx) {
  const scanArea = document.getElementById("scanArea");
  if (!navigator.mediaDevices?.getUserMedia) {
    scanArea.innerHTML = `<p class="scan-hint">Camera not available on this device — use search instead.</p>`;
    return;
  }

  scanArea.innerHTML = `
    <div class="scan-camera">
      <video id="scanVideo" autoplay playsinline muted></video>
      <div class="scan-frame"></div>
    </div>
    <p class="scan-hint">Point the camera at the employee's badge QR code</p>
  `;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    scanArea.innerHTML = `<p class="scan-hint">Camera permission denied — use search instead.</p>`;
    return;
  }

  try {
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js");
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    scanArea.innerHTML = `<p class="scan-hint">Couldn't load the scanner — use search instead.</p>`;
    return;
  }

  const video = document.getElementById("scanVideo");
  video.srcObject = stream;
  const canvas = document.createElement("canvas");
  const canvasCtx = canvas.getContext("2d");
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    activeScanStop = null;
  };
  activeScanStop = stop;

  const tick = () => {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(imageData.data, imageData.width, imageData.height);
      if (result?.data) {
        let token = null;
        try { token = new URL(result.data).searchParams.get("card"); } catch { /* not a URL */ }
        if (token) {
          stop();
          resolveScannedBadge(ctx, token);
          return;
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  document.getElementById("modalClose").addEventListener("click", stop, { once: true });
  document.getElementById("modalOverlay").addEventListener("click", stop, { once: true });
}

async function resolveScannedBadge(ctx, token) {
  const scanArea = document.getElementById("scanArea");
  if (scanArea) scanArea.innerHTML = `<p class="scan-hint">Badge scanned — looking them up…</p>`;
  try {
    const snap = await getDoc(doc(ctx.db, "cards", token));
    if (!snap.exists() || snap.data().status !== "active") {
      if (scanArea) scanArea.innerHTML = `<p class="scan-hint">That badge isn't a valid active employee card — use search instead.</p>`;
      return;
    }
    const card = snap.data();
    pickHost(ctx, token, card.name, card.department);
  } catch {
    if (scanArea) scanArea.innerHTML = `<p class="scan-hint">Couldn't read that badge — use search instead.</p>`;
  }
}

async function issuePass(ctx, payload) {
  // Firestore Lite doesn't support transactions, so this is an optimistic
  // check-then-write rather than a fully atomic compare-and-swap. Good
  // enough for a single reception desk; the Admin Portal's manual issue
  // form uses the full SDK with a real transaction for the belt-and-braces
  // case of two people issuing at the exact same instant.
  const passRef = doc(ctx.db, "passes", payload.passId);
  const passSnap = await getDoc(passRef);
  if (!passSnap.exists() || passSnap.data().status !== "free") {
    throw new Error("This pass was just taken. Pick a different pass and try again.");
  }

  const visitRef = doc(collection(ctx.db, "visits"));
  await setDoc(visitRef, {
    passId: payload.passId,
    visitorName: payload.visitorName,
    idType: payload.idType,
    idNumber: payload.idNumber,
    phone: payload.phone,
    purpose: payload.purpose,
    hostToken: payload.hostToken,
    hostName: payload.hostName,
    hostDepartment: payload.hostDepartment,
    timeIn: serverTimestamp(),
    timeOut: null,
    status: "active",
    issuedBy: currentEmail
  });
  await updateDoc(passRef, {
    status: "occupied",
    activeVisitId: visitRef.id,
    updatedAt: serverTimestamp()
  });
}

function showIssueConfirmation(ctx, passId, visitorName) {
  ctx.openModal(`
    <div class="confirm-panel">
      <div class="pass-status-badge free">Pass Issued</div>
      <div class="confirm-pass-number">#${ctx.escapeHtml(passId)}</div>
      <p>Give this physical pass to ${ctx.escapeHtml(visitorName)}. Time in has been recorded.</p>
      <button class="btn primary full" type="button" id="confirmDoneBtn">Done</button>
    </div>
  `);
  document.getElementById("confirmDoneBtn").addEventListener("click", () => {
    ctx.closeModal();
    if (ctx.passId) loadPass(ctx, ctx.passId);
  });
}

// ---------------------------------------------------------------------
// Mark Exit modal
// ---------------------------------------------------------------------
function openMarkExitModal(ctx, passId, visit) {
  ctx.openModal(`
    <h2>Mark Visitor Exit</h2>
    <p class="muted">Pass #${ctx.escapeHtml(passId)} — confirm the visitor is leaving and free the pass.</p>
    <div class="detail-grid">
      ${ctx.detail("host", "Visitor", visit.visitorName)}
      ${ctx.detail("issued", "Time In", ctx.formatDateTime(visit.timeIn))}
    </div>
    <form id="markExitForm" class="form-grid">
      <label class="full">Time Out
        <input id="meTimeOut" type="datetime-local" value="${nowLocalInputValue()}" required>
      </label>
      <div class="form-actions full">
        <button type="submit" class="btn primary full">Confirm Exit &amp; Free Pass</button>
      </div>
      <div id="markExitError" class="notice error hidden full"></div>
    </form>
  `);

  document.getElementById("markExitForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("markExitError");
    ctx.setHidden(errorEl, true);
    const submitBtn = event.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const timeOutValue = document.getElementById("meTimeOut").value;
      await markExit(ctx, passId, visit, new Date(timeOutValue));
      ctx.closeModal();
      loadPass(ctx, passId);
    } catch (error) {
      errorEl.textContent = error.message || "Couldn't mark this visit as exited. Try again.";
      ctx.setHidden(errorEl, false);
      submitBtn.disabled = false;
    }
  });
}

async function markExit(ctx, passId, visit, timeOutDate) {
  await updateDoc(doc(ctx.db, "visits", visit.id), {
    timeOut: Timestamp.fromDate(timeOutDate),
    status: "completed",
    completedBy: currentEmail
  });
  await updateDoc(doc(ctx.db, "passes", passId), {
    status: "free",
    activeVisitId: null,
    updatedAt: serverTimestamp()
  });
}
