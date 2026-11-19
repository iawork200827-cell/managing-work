import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, OWNER_EMAILS } from "./firebase-config.js";

export const configured = !String(firebaseConfig.apiKey || "").includes("PEGAR");
export const app = configured ? initializeApp(firebaseConfig) : null;
// Detecta redes o navegadores (algunos iPhone, datos móviles) que bloquean la conexión en vivo
// y cambia a un modo compatible.
export const db = app ? initializeFirestore(app, { experimentalAutoDetectLongPolling: true }) : null;
export const auth = app ? getAuth(app) : null;
export { OWNER_EMAILS };

export const STATUS_LABEL = {
  por_pagar: "Por pagar", pendiente: "Recibido", preparando: "Preparando", listo: "Listo",
  entregado: "Entregado", cancelado: "Cancelado"
};

export const DEFAULT_CONFIG = {
  name: "Tacos Josué", currency: "$", tables: 4,
  minMinutes: 5, maxMinutes: 10, capacity: 1, closedUntil: null,
  deliveryOn: true, bank: "", holder: "", clabe: ""
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

// Muestra en pantalla cualquier error, para poder diagnosticar con una captura.
export function showErrorsOnPage() {
  const show = (msg) => {
    const n = document.getElementById("notice");
    if (!n) return;
    n.hidden = false;
    n.textContent = "Error: " + String(msg).slice(0, 300);
  };
  window.addEventListener("error", (e) => show(e.message || e.error));
  window.addEventListener("unhandledrejection", (e) => show((e.reason && (e.reason.code || e.reason.message)) || e.reason));
  return show;
}

// Junta los productos de uno o varios pedidos: "6 × Tacos de pastor  $102"
export function summarize(itemLists) {
  const map = new Map();
  for (const items of itemLists) for (const i of items || []) {
    const key = i.name + "|" + i.price + "|" + (i.toGo ? 1 : 0);
    const cur = map.get(key) || { name: i.name + (i.toGo ? " (para llevar)" : ""), price: Number(i.price) || 0, qty: 0 };
    cur.qty += Number(i.qty) || 0;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export function summaryHtml(itemLists, currency = "$", title = "Resumen de lo que pidieron", discount = 0) {
  const rows = summarize(itemLists);
  if (!rows.length) return "";
  const total = rows.reduce((s, r) => s + r.qty * r.price, 0) - (Number(discount) || 0);
  const pieces = rows.reduce((s, r) => s + r.qty, 0);
  return `<div class="summary"><div class="label">${esc(title)}</div>
    <table><tbody>${rows.map((r) => `<tr><td class="mono q">${r.qty} ×</td><td>${esc(r.name)}</td><td class="mono r">${money(r.qty * r.price, currency)}</td></tr>`).join("")}</tbody>
    <tfoot>${discount ? `<tr><td></td><td>Descuentos (promoción)</td><td class="mono r">−${money(discount, currency)}</td></tr>` : ""}<tr><td class="mono q">${pieces}</td><td>${pieces === 1 ? "pieza" : "piezas"} en total</td><td class="mono r">${money(total, currency)}</td></tr></tfoot></table></div>`;
}

// Nombre de una mesa para mostrar: "Mesa 3" o "Barra"
export const BAR_ID = "barra";
export function tableLabel(id) {
  return String(id) === BAR_ID ? "Barra" : "Mesa " + id;
}
// Mesas del negocio (1..N) más la barra
export function tableIds(config) {
  const n = Math.min(200, Math.max(0, Number(config && config.tables) || 0));
  const ids = Array.from({ length: n }, (_, i) => String(i + 1));
  if (!config || config.bar !== false) ids.push(BAR_ID);
  return ids;
}

// Plataformas de reparto
export const PLATFORMS = { uber: "Uber Eats", didi: "DiDi Food" };

// Lista de productos agrupada por plato; los platos para llevar se marcan claramente
export function platesHtml(items) {
  const groups = {};
  (items || []).forEach((i) => (groups[i.plate || 1] ||= []).push(i));
  const keys = Object.keys(groups).sort((a, b) => a - b);
  const list = (arr) => `<ul>${arr.map((i) => `<li>${Number(i.qty) || 0} × ${esc(i.name)}</li>`).join("")}</ul>`;
  const toGo = (arr) => arr.some((i) => i.toGo);
  if (keys.length <= 1) {
    const arr = items || [];
    return (toGo(arr) ? `<div class="plate-label togo">Para llevar</div>` : "") + list(arr);
  }
  return keys.map((k) => `<div class="plate-label ${toGo(groups[k]) ? "togo" : ""}">Plato ${k}${toGo(groups[k]) ? " · PARA LLEVAR" : ""}</div>${list(groups[k])}`).join("");
}

// ---------- propinas ----------
// choice = { pct: 0 | 10 | 15 | 20 } o { custom: número en pesos }
export function tipAmount(total, choice) {
  if (!choice) return 0;
  if (choice.custom != null && choice.custom !== "") return Math.max(0, Math.round((Number(choice.custom) || 0) * 100) / 100);
  return Math.round((Number(total) || 0) * (Number(choice.pct) || 0)) / 100;
}
export function tipPickerHtml(tabId, total, choice, currency = "$") {
  const c = choice || { pct: 0 };
  const pcts = [0, 10, 15, 20];
  return `<div class="tips"><span class="label">Propina</span>
    ${pcts.map((p) => `<button type="button" class="${c.custom == null && Number(c.pct || 0) === p ? "on" : ""}" data-tip="${esc(tabId)}" data-pct="${p}">${p ? p + "%" : "Sin propina"}</button>`).join("")}
    <input id="tipc-${esc(tabId)}" data-tipcustom="${esc(tabId)}" type="number" min="0" step="1" inputmode="decimal" placeholder="Otra $" value="${c.custom != null ? esc(c.custom) : ""}" style="width:90px">
    <span class="mono">${money(tipAmount(total, c), currency)}</span></div>`;
}
