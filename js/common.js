export function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
}

export function setHidden(node, hidden) {
  node.classList.toggle("hidden", hidden);
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function dateToInputValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addOneYear(dateString) {
  if (!dateString) return "";
  const d = new Date(`${dateString}T00:00:00`);
  d.setFullYear(d.getFullYear() + 1);
  return dateToInputValue(d);
}

export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Visitor pass system — shared constants so admin.js and the reception
// scan flow never drift out of sync on IDs or labels.
export const PASS_COUNT = 18;

export function padPassId(n) {
  return String(n).padStart(2, "0");
}

export const ID_TYPES = {
  cnic: "CNIC",
  license: "Driving License",
  passport: "Passport"
};

export function formatDateTime(value) {
  const date = value && typeof value.toDate === "function" ? value.toDate() : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

export async function resizeImageToBase64(file, maxSize = 400, quality = 0.78) {
  if (!file) return "";
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  if (dataUrl.length > 350_000) {
    throw new Error("Photo is still too large after resizing. Please use a smaller image.");
  }
  return dataUrl;
}
