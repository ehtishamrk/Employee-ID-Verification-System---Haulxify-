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
    el("loginError").textContent = "This account is not authorized as an HAULXIFY administrator.";
    setHidden(loginView, false);
    setHidden(appView, true);
  }
});

async function loadCards() {
  const snap = await getDocs(collection(db, "cards"));
  currentCards = snap.docs.map(d => ({ token: d.id, ...d.data() }));
  renderCards();
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
      <td>${escapeHtml(c.employeeId)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.department)}</td>
      <td><span class="badge ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
      <td>${escapeHtml(c.expiryDate || "")}</td>
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
        <th>Employee ID</th><th>Name</th><th>Department</th><th>Status</th><th>Expiry</th><th>Actions</th>
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
    await setDoc(doc(db, "cards", token), { status: next, updatedAt: serverTimestamp() }, { merge: true });
    await loadCards();
    return;
  }

  if (action === "cancel") {
    const ok = confirm(`Cancel card for ${card.name} (${card.employeeId})? The old QR will stop working.`);
    if (!ok) return;
    await setDoc(doc(db, "cards", token), { status: "canceled", updatedAt: serverTimestamp() }, { merge: true });
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
}

function resetForm() {
  form.reset();
  el("editingToken").value = "";
  el("issueDate").value = dateToInputValue(new Date());
  el("expiryDate").value = addOneYear(el("issueDate").value);
  setHidden(el("deleteBtn"), true);
  selectedToken = "";
  setHidden(el("qrArea"), true);
  setHidden(el("qrEmpty"), false);
  setHidden(formMessage, true);
}

el("resetBtn").addEventListener("click", resetForm);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setHidden(formMessage, true);

  try {
    const editing = el("editingToken").value.trim();
    const old = editing ? currentCards.find(c => c.token === editing) : null;
    const token = editing || generateToken();

    let photoBase64 = old?.photoBase64 || "";
    const photoFile = el("photo").files?.[0];
    if (photoFile) photoBase64 = await resizeImageToBase64(photoFile);

    const issueDate = el("issueDate").value;
    const expiryDate = addOneYear(issueDate);

    const payload = {
      name: el("name").value.trim(),
      designation: el("designation").value.trim(),
      employeeId: el("employeeId").value.trim(),
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
      updatedAt: serverTimestamp()
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
  new QRCode(el("qrCode"), {
    text: verifyUrl.href,
    width: 320,
    height: 320,
    colorDark: "#102f55",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });

  el("qrLink").textContent = verifyUrl.href;
  el("qrLink").dataset.href = verifyUrl.href;
  setHidden(el("qrEmpty"), true);
  setHidden(el("qrArea"), false);
}

el("downloadQrBtn").addEventListener("click", () => {
  const img = el("qrCode").querySelector("img");
  const canvas = el("qrCode").querySelector("canvas");
  const source = canvas ? canvas.toDataURL("image/png") : img?.src;
  if (!source) return;

  const a = document.createElement("a");
  a.href = source;
  a.download = `HAULXIFY-QR-${el("employeeId").value.trim() || "employee"}.png`;
  a.click();
});
