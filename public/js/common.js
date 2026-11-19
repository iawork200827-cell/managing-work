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

export const DEFAULT_CONFIG = {
  name: "Tacos Josué", currency: "$", tables: 4,
  minMinutes: 5, maxMinutes: 10, capacity: 1, closedUntil: null
};

// Minutos de preparación de un pedido según su tamaño:
// hasta 3 piezas = mínimo; +1 min por cada 2 piezas extra; nunca más del máximo.
export function prepMinutes(units, config = DEFAULT_CONFIG) {
  const min = Number(config.minMinutes) || 5;
  const max = Math.max(min, Number(config.maxMinutes) || 10);
  const extra = Math.floor(Math.max(0, (Number(units) || 0) - 3) / 2);
  return Math.min(max, min + extra);
}

// Tiempo estimado para un pedido: lo que falta de los pedidos de adelante
// (repartido entre los pedidos que la cocina hace a la vez) + su propio tiempo.
export function estimate(queue, myId, myMinutes, config = DEFAULT_CONFIG) {
  const list = [...queue].sort((a, b) => a.createdAt - b.createdAt);
  const idx = myId ? list.findIndex((q) => q.id === myId) : -1;
  const ahead = idx < 0 ? list : list.slice(0, idx);
  const cap = Math.max(1, Number(config.capacity) || 1);
  const before = ahead.reduce((s, q) => s + (Number(q.minutes) || Number(config.minMinutes) || 5), 0) / cap;
  return { ahead: ahead.length, minutes: Math.round(before + (Number(myMinutes) || prepMinutes(1, config))) };
}

export function isClosed(config) {
  const until = config && config.closedUntil;
  if (!until) return false;
  return toMillis(until) > Date.now();
}

export function endOfToday() {
  const d = new Date(); d.setHours(23, 59, 59, 999); return d;
}

export function newId(len = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = new Uint32Array(len); crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join("");
}

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function money(n, currency = "$") {
  return currency + (Number(n) || 0).toFixed(2);
}

export function toMillis(ts) {
  if (!ts) return Date.now();
  if (ts instanceof Date) return ts.getTime();
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
