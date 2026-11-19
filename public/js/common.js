import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, OWNER_EMAILS } from "./firebase-config.js";

export const configured = !String(firebaseConfig.apiKey || "").includes("PEGAR");
export const app = configured ? initializeApp(firebaseConfig) : null;
export const db = app ? getFirestore(app) : null;
export const auth = app ? getAuth(app) : null;
export { OWNER_EMAILS };

export const STATUS_LABEL = {
  pendiente: "Recibido", preparando: "Preparando", listo: "Listo",
  entregado: "Entregado", cancelado: "Cancelado"
};

export const DEFAULT_CONFIG = { name: "Tacos Josué", minutesPerOrder: 5, currency: "$", useTables: false, tables: 10 };

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function money(n, currency = "$") {
  return currency + (Number(n) || 0).toFixed(2);
}

export function toMillis(ts) {
  if (!ts) return Date.now();
  if (typeof ts.toMillis === "function") return ts.toMillis();
  return Number(ts) || Date.now();
}

export const local = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
};

export function toast(msg) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2800);
}

export function notConfiguredHtml() {
  return `<div class="empty"><h2>Falta conectar Firebase</h2>
    <p>Abre <code>public/js/firebase-config.js</code> y pega los datos de tu proyecto de Firebase.
    La guía <code>GUIA.md</code> explica cómo.</p></div>`;
}
