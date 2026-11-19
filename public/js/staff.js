// Modo empleado: se entra con el QR de empleados + PIN.
// Puede tomar pedidos de mesa (abrir cuentas o agregar a las abiertas), para llevar / por teléfono,
// cobrar y cerrar cuentas, confirmar pagos desde casa y avanzar pedidos en cocina.
// No ve ventas del día ni pedidos terminados.
import {
  collection, doc, onSnapshot, query, where, writeBatch, setDoc, getDoc, updateDoc, deleteField, increment, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { signInAnonymously, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  db, auth, configured, OWNER_EMAILS, $, esc, money, toMillis, local, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG, prepMinutes, newId, showErrorsOnPage, summaryHtml, isClosed, tableLabel, tableIds, BAR_ID, platesHtml, PLATFORMS, tipPickerHtml, tipAmount, normPhone
} from "./common.js";
import { buildItems, isOut as isOutP, totals, productCard, selectionFor, handleSelectClick } from "./cart.js";

showErrorsOnPage();
const params = new URLSearchParams(location.search);
const keyParam = (params.get("k") || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 40);
if (keyParam) local.set("comanda.staffKey", keyParam);

const JOIN_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => { const a = new Uint32Array(6); crypto.getRandomValues(a); return Array.from(a, (n) => JOIN_CHARS[n % JOIN_CHARS.length]).join(""); };
const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const SEP = "::";
const splitKey = (k) => { const i = k.indexOf(SEP); return i < 0 ? [k, ""] : [k.slice(0, i), k.slice(i + SEP.length)]; };

const state = {
  key: keyParam || local.get("comanda.staffKey") || "",
  name: local.get("comanda.staffName") || "",
  user: null, ok: false, checking: true,
  view: "mesas", config: { ...DEFAULT_CONFIG }, products: [],
  tabs: {}, rounds: {}, active: [],
  // Pedido que se está capturando
  target: null, plates: [{}], toGo: [], cur: 0, sel: {}, tips: {}, seenCalls: null, pick: {}, note: "", customer: "", phone: "", extRef: "", sending: false,
  openFor: null, openName: "", unsubs: []
};
const cur = () => state.config.currency || "$";
function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

// ---------- menú (lógica compartida con la vista del cliente, en cart.js) ----------
const isOut = (p) => isOutP(p, state.config);
const cartItems = () => buildItems(state.plates, state.toGo, state.products, state.config, !!(state.target && state.target.type === "mesa"));
const cartTotals = () => totals(cartItems(), state.products, state.config);

// ---------- vistas ----------
function render() {
  const focusId = document.activeElement && document.activeElement.id;
  renderInner();
  const el = focusId && $(focusId);
  if (el && el.tagName === "INPUT") { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} }
}

function renderInner() {
  $("shopName").textContent = state.config.name || "Tacos Josué";
  const app = $("app");
  if (!configured) { app.innerHTML = notConfiguredHtml(); return; }
  if (state.checking) { app.innerHTML = '<p class="muted">Entrando…</p>'; return; }
  if (!state.ok) { app.innerHTML = loginHtml(); $("who").hidden = true; return; }
  $("who").hidden = false;
  $("whoName").textContent = state.name + (state.isManager ? " (encargado)" : "");
  $("panelLink").hidden = !(state.isManager || state.name === "Dueño");
  if (state.target) { app.innerHTML = builderHtml(); renderBar(); return; }
  $("cartbar").hidden = true;
  const pend = state.active.filter((o) => o.status === "pendiente" || o.status === "por_pagar").length;
  const calling = Object.values(state.tabs).filter((t) => t.call && t.call.reason);
  let html = calling.length ? `<div class="callbar">${calling.map((t) => `<div class="order"><div class="row"><strong>${esc(tableLabel(t.table))}${t.name ? " · " + esc(t.name) : ""}</strong><span class="tag bill">Llama: ${esc(t.call.reason)}</span><button data-callok="${esc(t.id)}">Atendido</button></div></div>`).join("")}</div>` : "";
  html += `<div class="tabs">
    <button data-view="mesas" class="${state.view === "mesas" ? "on" : ""}">Mesas</button>
    <button data-view="llevar" class="${state.view === "llevar" ? "on" : ""}">Para llevar · Uber · DiDi</button>
    <button data-view="cocina" class="${state.view === "cocina" ? "on" : ""}">Cocina${pend ? ` (${pend})` : ""}</button>
    <button data-view="reparto" class="${state.view === "reparto" ? "on" : ""}">Domicilios${deliveries().length ? ` (${deliveries().length})` : ""}</button></div>`;
  if (isClosed(state.config)) html += `<div class="notice">Los pedidos están cerrados por hoy.</div>`;
  if (state.view === "mesas") html += tablesHtml();
  if (state.view === "llevar") html += takeoutHtml();
  if (state.view === "cocina") html += kitchenHtml();
  if (state.view === "reparto") html += deliveryHtml();
  app.innerHTML = html;
}

function loginHtml() {
  if (!state.key) return `<div class="empty"><h2>Escanea el QR de empleados</h2><p>Pídele al dueño el código QR para empleados.</p></div>`;
  return `<form class="login" id="loginForm">
    <h2>Entrar como empleado</h2>
    <label class="label" for="staffName">Tu nombre</label>
    <input id="staffName" required maxlength="40" autocomplete="name" value="${esc(state.name)}">
    <label class="label" for="staffPin">PIN de empleados</label>
    <input id="staffPin" required inputmode="numeric" maxlength="8" autocomplete="off" type="password">
    <button class="primary" type="submit">Entrar</button>
  </form>`;
}

const tabRounds = (id) => (state.rounds[id] || []).filter((r) => r.status !== "cancelado").sort((a, b) => a.createdAt - b.createdAt);
const tabTotal = (id) => tabRounds(id).reduce((s, r) => s + (Number(r.total) || 0), 0);

function tablesHtml() {
  let html = '<div class="board">';
  for (const t of tableIds(state.config)) {
    const tabs = Object.values(state.tabs).filter((x) => x.table === t).sort((a, b) => toMillis(a.openedAt) - toMillis(b.openedAt));
    html += `<div class="col"><div class="col-head"><h3>${tableLabel(t)}</h3><span class="muted">${tabs.length ? tabs.length + (tabs.length === 1 ? " cuenta" : " cuentas") : "libre"}</span></div>`;
    for (const tab of tabs) {
      const rounds = tabRounds(tab.id);
      html += `<div class="order"><div class="row"><strong>${esc(tab.name || "Cuenta")}</strong><span class="mono muted">${esc(tab.code)}</span>${tab.billRequested ? '<span class="tag bill">Pidió la cuenta</span>' : ""}</div>
        ${rounds.length ? summaryHtml(rounds.map((r) => r.items), cur(), "Lo que han pedido", rounds.reduce((a, r) => a + (Number(r.discount) || 0), 0)) : '<p class="muted" style="margin:0">Sin pedidos todavía</p>'}
        <div class="acts"><button class="primary" data-addto="${esc(tab.id)}">Agregar pedido</button>
          ${rounds.length ? `<button data-close="${esc(tab.id)}" data-method="efectivo">Cobrar efectivo</button><button data-close="${esc(tab.id)}" data-method="tarjeta">Cobrar tarjeta</button>` : ""}</div>
        ${rounds.length ? tipPickerHtml(tab.id, tabTotal(tab.id), state.tips[tab.id], cur()) : ""}</div>`;
    }
    if (state.openFor === t) {
      html += `<form class="order" id="openForm"><label class="label" for="openName">Nombre del cliente (opcional)</label>
        <input id="openName" maxlength="40" value="${esc(state.openName)}" placeholder="Ej. Familia López">
        <div class="acts"><button class="primary" type="submit">Abrir cuenta</button><button type="button" data-cancelopen>Cancelar</button></div></form>`;
    } else html += `<button data-open="${t}">+ Abrir cuenta en ${tableLabel(t)}</button>`;
    html += "</div>";
  }
  return html + "</div>";
}

function takeoutHtml() {
  const mine = state.active.filter((o) => o.type === "llevar" || o.type === "plataforma").sort((a, b) => a.createdAt - b.createdAt);
  let html = `<div class="acts" style="margin-bottom:12px"><button class="primary" data-newtakeout>+ Para llevar / teléfono</button>
    <button data-newplatform="uber">+ Uber Eats</button><button data-newplatform="didi">+ DiDi Food</button></div>`;
  if (!mine.length) return html + '<div class="empty">No hay pedidos para llevar ni de plataformas en curso.</div>';
  html += '<div class="plist">';
  for (const o of mine) html += `<div class="prow"><div>${o.type === "plataforma" ? `<span class="tag plat">${esc(PLATFORMS[o.platform])} #${esc(o.extRef)}</span> ` : ""}<strong>${esc(o.customer || "")}</strong> <span class="mono muted">#${esc(o.code)}</span>${o.phone ? ` · <span class="mono">${esc(o.phone)}</span>` : ""}
      <div class="muted" style="font-size:.82rem">${STATUS_LABEL[o.status]} · hace ${Math.max(0, Math.round((Date.now() - o.createdAt) / 60000))} min</div></div>
      <div class="price">${money(o.total, cur())}</div></div>`;
  return html + "</div>";
}

// ---------- repartidor ----------
const deliveries = () => state.active.filter((o) => o.type === "casa" && o.delivery === "domicilio" && o.status !== "por_pagar").sort((a, b) => a.createdAt - b.createdAt);
function deliveryHtml() {
  const list = deliveries();
  if (!list.length) return '<div class="empty">No hay pedidos a domicilio en curso.</div>';
  return '<div class="board">' + list.map((o) => {
    const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(o.address + (o.zone ? ", " + o.zone : ""));
    return `<div class="order ${o.status === "listo" ? "new" : ""}"><div class="row"><span class="mono" style="font-weight:700">#${esc(o.code)}</span><span class="tag">${STATUS_LABEL[o.status]}</span></div>
      <div><strong>${esc(o.customer)}</strong>${o.scheduledFor ? ` <span class="tag pop">Para las ${esc(o.scheduledFor)}</span>` : ""}</div>
      <div>${esc(o.address)}${o.zone ? ` · <strong>${esc(o.zone)}</strong>` : ""}</div>
      <div class="acts"><a class="switch-link" href="${esc(maps)}" target="_blank" rel="noopener">Abrir en el mapa</a>
        <span class="mono">Tel. ${esc(o.phone)}</span></div>
      ${itemsByPlate(o.items)}
      <div class="row"><span class="muted">${o.paid ? "Ya pagó (transferencia)" : "Cobrar al entregar"}</span><span class="price">${money(o.total, cur())}</span></div>
      ${o.status === "listo" ? `<div class="acts"><button class="primary" data-advance="${esc(o.id)}" data-to="entregado">Entregado</button></div>` : '<p class="muted" style="margin:0">Todavía en cocina</p>'}</div>`;
  }).join("") + "</div>";
}

function itemsByPlate(items) { return platesHtml(items); }

function kitchenHtml() {
  const NEXT = {
    pendiente: () => ["preparando", "Empezar a preparar"],
    preparando: () => ["listo", "Marcar listo"],
    listo: (o) => ["entregado", o.type === "mesa" ? "Servido en mesa" : o.type === "plataforma" ? "Entregado al repartidor" : o.type === "casa" ? "Entregado" : "Entregado y cobrado"]
  };
  const who = (o) => o.type === "plataforma" ? `<span class="tag plat">${esc(PLATFORMS[o.platform])} #${esc(o.extRef)}</span> <strong>${esc(o.customer || "")}</strong>` : o.type === "mesa" ? `<span class="tag">${esc(tableLabel(o.table))}</span>` : o.type === "casa" ? `<span class="tag casa">${o.delivery === "domicilio" ? "Domicilio" : "Casa · recoge"}</span> <strong>${esc(o.customer)}</strong>` : `<span class="tag">Para llevar</span> <strong>${esc(o.customer)}</strong>`;
  let html = "";
  const unpaid = state.active.filter((o) => o.status === "por_pagar");
  if (unpaid.length) {
    html += `<h3 style="margin:0 0 8px">Por confirmar pago (${unpaid.length})</h3><div class="board" style="margin-bottom:18px">`;
    for (const o of unpaid) html += `<div class="order paywait"><div class="row"><span class="mono">#${esc(o.code)}</span><span class="price">${money(o.total, cur())}</span></div>
      <div>${who(o)}</div><div class="${o.payRef ? "notice" : "muted"}" style="margin:0">${o.payRef ? "Ref: <strong>" + esc(o.payRef) + "</strong>" : "Todavía no avisa que pagó"}</div>
      <div class="acts"><button class="primary" data-confirmpay="${esc(o.id)}">Pago recibido</button></div></div>`;
    html += "</div>";
  }
  html += '<div class="board">';
  for (const s of ["pendiente", "preparando", "listo"]) {
    const list = state.active.filter((o) => o.status === s).sort((a, b) => a.createdAt - b.createdAt);
    html += `<div class="col"><div class="col-head ${s}"><h3>${STATUS_LABEL[s]}</h3><span class="mono muted">${list.length}</span></div>`;
    if (!list.length) html += `<div class="empty">Sin pedidos</div>`;
    for (const o of list) {
      const [to, label] = NEXT[s](o);
      const el = Math.max(0, Math.round((Date.now() - o.createdAt) / 60000));
      html += `<div class="order"><div class="row"><span class="mono" style="font-weight:700">#${esc(o.code)}</span><span class="mono ${el > (o.minutes || 5) && s !== "listo" ? "late" : "muted"}">${el} de ~${o.minutes || "?"} min</span></div>
        <div>${who(o)}${o.scheduledFor ? ` <span class="tag pop">Para las ${esc(o.scheduledFor)}</span>` : ""}</div>${itemsByPlate(o.items)}${o.note ? `<div class="notice" style="margin:0">Nota: ${esc(o.note)}</div>` : ""}
        ${o.takenBy ? `<div class="muted" style="font-size:.8rem">Tomó: ${esc(o.takenBy)}</div>` : ""}
        <div class="acts"><button class="primary" data-advance="${esc(o.id)}" data-to="${to}">${label}</button>
          ${s !== "listo" ? `<button class="danger" data-cancel="${esc(o.id)}">Cancelar</button>` : ""}</div></div>`;
    }
    html += "</div>";
  }
  return html + "</div>";
}

function builderHtml() {
  const t = state.target;
  const title = t.type === "mesa" ? `Pedido para ${esc(tableLabel(t.table))} · ${esc(t.name || "cuenta " + t.code)}`
    : t.type === "plataforma" ? `Pedido de ${esc(PLATFORMS[t.platform])}` : "Pedido para llevar / teléfono";
  let html = `<button data-back>← Volver</button><h2 style="margin:12px 0 8px">${title}</h2>`;
  if (t.type === "plataforma") html += `<div class="form"><label>Número de pedido en ${esc(PLATFORMS[t.platform])}<input id="extRef" maxlength="30" autocomplete="off" value="${esc(state.extRef)}"></label>
    <label>Nombre del cliente (opcional)<input id="custName" maxlength="60" value="${esc(state.customer)}"></label></div>
    <p class="muted" style="margin:0 0 8px">Captura los productos tal como vienen en la app. Ya están pagados por la plataforma.</p>`;
  if (t.type === "llevar") html += `<div class="form"><label>Nombre del cliente<input id="custName" maxlength="60" value="${esc(state.customer)}"></label>
    <label>Teléfono (opcional)<input id="custPhone" type="tel" maxlength="20" value="${esc(state.phone)}"></label></div>`;
  html += `<div class="plates">${state.plates.map((p, i) => { const n = Object.values(p).reduce((a, b) => a + b, 0); return `<button data-plate="${i}" class="${i === state.cur ? "on" : ""}">Plato ${i + 1}${state.toGo[i] ? " (llevar)" : ""}${n ? ` · ${n}` : ""}</button>`; }).join("")}<button data-addplate>+ Otro plato</button></div>`;
  if (t.type === "mesa") html += `<div style="margin-top:8px"><button data-togo class="toggle ${state.toGo[state.cur] ? "off" : "on"}">${state.toGo[state.cur] ? `Plato ${state.cur + 1}: PARA LLEVAR ✓` : `Plato ${state.cur + 1}: comer aquí`}</button></div>`;
  const groups = {};
  [...state.products].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach((p) => (groups[p.category || "Otros"] ||= []).push(p));
  const plate = state.plates[state.cur];
  for (const [cat, items] of Object.entries(groups)) {
    html += `<section class="section"><h2>${esc(cat)}</h2>`;
    for (const p of items) html += productCard(p, { config: state.config, plate, sel: selectionFor(state.sel, p, state.config), canAdd: true, cur: cur() });
    html += "</section>";
  }
  return html;
}

function renderBar() {
  const bar = $("cartbar");
  const items = cartItems();
  const units = items.reduce((s, i) => s + i.qty, 0);
  if (!units) { bar.hidden = true; return; }
  const active = document.activeElement && document.activeElement.id;
  bar.hidden = false;
  const tt = cartTotals();
  bar.innerHTML = (tt.discount ? `<div class="in"><div class="promo-line">${tt.discounts.map((d) => `${esc(d.name)}: −${money(d.amount, cur())}`).join(" · ")}</div></div>` : "") + `<div class="in"><span class="sum">${units} ${units === 1 ? "pieza" : "piezas"} · ${money(tt.total, cur())}</span>
    <input id="custNote" placeholder="Nota para cocina" maxlength="200" value="${esc(state.note)}">
    <button class="primary" id="sendOrder" ${state.sending ? "disabled" : ""}>Enviar a cocina</button></div>`;
  if (active && $(active)) $(active).focus();
}

// Suma una visita a la tarjeta de lealtad del cliente
function loyaltyBump(b, phone) {
  const p = normPhone(phone);
  if (!(state.config.loyalty && state.config.loyalty.on) || !p) return;
  b.set(doc(db, "loyalty", p), { count: increment(1), updatedAt: serverTimestamp() }, { merge: true });
}

// ---------- escrituras ----------
async function write(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); return true; }
  catch (e) { console.error(e); toast(e && e.code === "permission-denied" ? "Sin permiso. Vuelve a entrar con el PIN." : "No se pudo guardar. Intenta otra vez."); return false; }
}

async function openTab(table, name) {
  const session = newId(24), code = newCode();
  const b = writeBatch(db);
  b.set(doc(db, "tabSecrets", session), { table, key: "staff", openedAt: serverTimestamp() });
  const tab = { table, openedAt: serverTimestamp(), code, closed: false, billRequested: false, openedBy: state.name.slice(0, 40) };
  if (name) tab.name = name.slice(0, 40);
  b.set(doc(db, "tabs", session), tab);
  b.set(doc(db, "joins", table + "-" + code), { session, table, createdAt: serverTimestamp() });
  const ok = await write(() => b.commit(), `Cuenta abierta en ${tableLabel(table)} · código ${code}`);
  if (ok) { state.openFor = null; state.openName = ""; startOrder({ type: "mesa", table, session, code, name }); }
}

function startOrder(target) {
  state.target = target; state.plates = [{}]; state.toGo = []; state.cur = 0; state.note = ""; state.customer = ""; state.phone = ""; state.extRef = "";
  window.scrollTo({ top: 0 }); render();
}

async function sendOrder() {
  const t = state.target; const items = cartItems();
  if (!items.length) return;
  if (t.type === "llevar" && !state.customer.trim()) { toast("Escribe el nombre del cliente"); $("custName")?.focus(); return; }
  if (t.type === "plataforma" && !state.extRef.trim()) { toast("Escribe el número de pedido de la app"); $("extRef")?.focus(); return; }
  state.sending = true; renderBar();
  const ref = doc(collection(db, "orders"));
  const units = items.reduce((s, i) => s + i.qty, 0);
  const minutes = prepMinutes(units, state.config);
  const order = {
    type: t.type, items, minutes, status: "pendiente", paid: false, createdAt: serverTimestamp(),
    code: ref.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase(),
    total: cartTotals().total,
    takenBy: state.name.slice(0, 40)
  };
  const tt = cartTotals();
  if (tt.discount) { order.discount = tt.discount; order.promos = tt.discounts.map((d) => d.name.slice(0, 60)); }
  const plates = new Set(items.map((i) => i.plate)).size;
  if (plates > 1) order.plates = plates;
  if (state.note.trim()) order.note = state.note.trim().slice(0, 200);
  if (t.type === "llevar") { order.customer = state.customer.trim().slice(0, 60); if (state.phone.trim()) order.phone = state.phone.trim().slice(0, 20); }
  if (t.type === "mesa") { order.table = t.table; order.session = t.session; }
  if (t.type === "plataforma") { order.platform = t.platform; order.extRef = state.extRef.trim().slice(0, 30); if (state.customer.trim()) order.customer = state.customer.trim().slice(0, 60); }
  const b = writeBatch(db);
  b.set(ref, order);
  b.set(doc(db, "queue", ref.id), { status: "pendiente", createdAt: serverTimestamp(), minutes });
  if (t.type === "mesa") {
    const round = { items, total: order.total, status: "pendiente", createdAt: serverTimestamp(), minutes };
    if (order.discount) round.discount = order.discount;
    if (order.plates) round.plates = order.plates;
    b.set(doc(db, "tabs", t.session, "rounds", ref.id), round);
  }
  const ok = await write(() => b.commit(), "Pedido enviado a cocina");
  state.sending = false;
  if (ok) { state.target = null; state.view = t.type === "mesa" ? "mesas" : "llevar"; }
  render();
}

function setStatus(o, status) {
  return write(async () => {
    const b = writeBatch(db);
    const patch = { status, handledBy: state.name.slice(0, 40) };
    if (status !== "cancelado") patch[status + "At"] = serverTimestamp(); else patch.cancelledBy = state.name.slice(0, 40);
    if (status === "entregado" && o.type === "llevar") { patch.paid = true; patch.payMethod = "efectivo"; }
    if (status === "entregado" && o.type === "plataforma") { patch.paid = true; patch.payMethod = o.platform; }
    if (status === "entregado" && (o.type === "llevar" || o.type === "casa")) loyaltyBump(b, o.phone);
    b.update(doc(db, "orders", o.id), patch);
    if (o.type === "mesa" && o.session) b.set(doc(db, "tabs", o.session, "rounds", o.id), { status }, { merge: true });
    if (status === "entregado" || status === "cancelado") b.delete(doc(db, "queue", o.id));
    else b.update(doc(db, "queue", o.id), { status });
    await b.commit();
  }, status === "cancelado" ? "Pedido cancelado" : null);
}

function closeTab(tabId, method) {
  const tab = state.tabs[tabId]; if (!tab) return;
  const rounds = tabRounds(tabId);
  const total = rounds.reduce((s, r) => s + (Number(r.total) || 0), 0);
  return write(async () => {
    const b = writeBatch(db);
    b.update(doc(db, "tabs", tabId), { closed: true, billRequested: false, total, payMethod: method, closedAt: serverTimestamp(), closedBy: state.name.slice(0, 40),
      tip: tipAmount(total, state.tips[tabId]), tipBy: state.name.slice(0, 40), call: deleteField() });
    if (tab.phone && rounds.length) loyaltyBump(b, tab.phone);
    for (const r of rounds) {
      const patch = { paid: true, payMethod: method };
      if (r.status !== "entregado") {
        patch.status = "entregado"; patch.entregadoAt = serverTimestamp();
        b.delete(doc(db, "queue", r.id));
        b.set(doc(db, "tabs", tabId, "rounds", r.id), { status: "entregado" }, { merge: true });
      }
      b.update(doc(db, "orders", r.id), patch);
    }
    await b.commit();
  }, `${tableLabel(tab.table)} cobrada (${money(total, cur())})`);
}

// ---------- eventos ----------
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button"); if (!t) return;
  const d = t.dataset;
  const plate = state.plates[state.cur];
  if (d.view) { state.view = d.view; render(); return; }
  if (d.callok) { write(() => updateDoc(doc(db, "tabs", d.callok), { call: deleteField() })); return; }
  if (d.tip) { state.tips[d.tip] = { pct: Number(d.pct) }; render(); return; }
  if (d.open) { state.openFor = d.open; state.openName = ""; render(); $("openName")?.focus(); return; }
  if ("cancelopen" in d) { state.openFor = null; render(); return; }
  if (d.addto) { const tab = state.tabs[d.addto]; startOrder({ type: "mesa", table: tab.table, session: tab.id, code: tab.code, name: tab.name }); return; }
  if ("newtakeout" in d) { startOrder({ type: "llevar" }); return; }
  if (d.newplatform) { startOrder({ type: "plataforma", platform: d.newplatform }); return; }
  if ("back" in d) { state.target = null; render(); return; }
  if (handleSelectClick(d, state.sel, state.products, state.config)) { render(); return; }
  if (d.inc) { plate[d.inc] = (plate[d.inc] || 0) + 1; render(); return; }
  if (d.dec) { plate[d.dec] = (plate[d.dec] || 0) - 1; if (plate[d.dec] <= 0) delete plate[d.dec]; render(); return; }
  if (d.plate) { state.cur = Number(d.plate); render(); return; }
  if ("togo" in d) { state.toGo[state.cur] = !state.toGo[state.cur]; render(); return; }
  if ("addplate" in d) { state.plates.push({}); state.cur = state.plates.length - 1; render(); return; }
  if (t.id === "sendOrder") { sendOrder(); return; }
  if (d.advance) { const o = state.active.find((x) => x.id === d.advance); if (o) setStatus(o, d.to); return; }
  if (d.cancel) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Seguro? Toca otra vez"; return; }
    const o = state.active.find((x) => x.id === d.cancel); if (o) setStatus(o, "cancelado"); return;
  }
  if (d.confirmpay) {
    const o = state.active.find((x) => x.id === d.confirmpay); if (!o) return;
    write(async () => {
      const b = writeBatch(db);
      b.update(doc(db, "orders", o.id), { status: "pendiente", paid: true, payMethod: "transferencia", confirmedAt: serverTimestamp(), handledBy: state.name.slice(0, 40) });
      b.set(doc(db, "queue", o.id), { status: "pendiente", createdAt: serverTimestamp(), minutes: Number(o.minutes) || 5 });
      await b.commit();
    }, `Pedido #${o.code} enviado a cocina`);
    return;
  }
  if (d.close) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Confirmas el cobro? Toca otra vez"; return; }
    closeTab(d.close, d.method); return;
  }
  if (t.id === "logoutBtn") {
    local.set("comanda.staffName", null);
    signOut(auth).then(() => location.reload());
  }
});
document.addEventListener("input", (ev) => {
  const id = ev.target.id;
  if (id === "custNote") state.note = ev.target.value;
  if (id === "custName") state.customer = ev.target.value;
  if (id === "custPhone") state.phone = ev.target.value;
  if (id === "extRef") state.extRef = ev.target.value;
  if (id === "openName") state.openName = ev.target.value;
  if (ev.target.dataset && ev.target.dataset.tipcustom) state.tips[ev.target.dataset.tipcustom] = { custom: ev.target.value };
});
document.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (ev.target.id === "openForm") { openTab(state.openFor, state.openName.trim()); return; }
  if (ev.target.id === "loginForm") {
    const name = $("staffName").value.trim(), pin = $("staffPin").value.trim();
    if (!name || !pin) return;
    const ref = doc(db, "staffSessions", state.user.uid);
    try {
      // Primero como mesero; si no es el PIN de meseros, se prueba como encargado
      try { await setDoc(ref, { pin, key: state.key, name, role: "mesero", createdAt: serverTimestamp() }); }
      catch (e1) {
        await setDoc(ref, { pin, key: state.key, name, role: "encargado", createdAt: serverTimestamp() });
        local.set("comanda.staffName", name);
        toast("Bienvenido, encargado " + name);
        location.href = "/panel";
        return;
      }
      state.name = name; local.set("comanda.staffName", name);
      toast("Bienvenido, " + name);
      startListening();
    } catch (e) { console.error(e); toast("PIN incorrecto o QR de empleados no válido"); }
  }
});

// ---------- datos ----------
function startListening() {
  state.unsubs.forEach((f) => f()); state.unsubs = [];
  const denied = (e) => {
    console.error(e);
    if (e && e.code === "permission-denied") { state.ok = false; state.checking = false; render(); }
  };
  // Esta lectura solo la puede hacer un empleado con el PIN vigente: sirve para saber si ya entró
  state.unsubs.push(onSnapshot(query(collection(db, "tabs"), where("closed", "==", false)), (s) => {
    state.ok = true; state.checking = false;
    const ids = new Set(s.docs.map((d) => d.id));
    state.tabs = Object.fromEntries(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    const calls = Object.values(state.tabs).filter((t) => t.call && t.call.reason).map((t) => t.id + toMillis(t.call.at));
    if (state.seenCalls && calls.some((c) => !state.seenCalls.has(c))) { toast("Una mesa está llamando al mesero"); try { navigator.vibrate && navigator.vibrate(300); } catch (e) {} }
    state.seenCalls = new Set(calls);
    // Rondas de cada cuenta abierta (para los totales)
    for (const id of ids) if (!roundUnsubs[id]) {
      roundUnsubs[id] = onSnapshot(collection(db, "tabs", id, "rounds"), (r) => {
        state.rounds[id] = r.docs.map((x) => { const v = x.data({ serverTimestamps: "estimate" }); return { id: x.id, ...v, createdAt: toMillis(v.createdAt) }; });
        render();
      });
    }
    for (const id of Object.keys(roundUnsubs)) if (!ids.has(id)) { roundUnsubs[id](); delete roundUnsubs[id]; delete state.rounds[id]; }
    render();
  }, denied));
  state.unsubs.push(onSnapshot(query(collection(db, "orders"), where("status", "in", ["por_pagar", "pendiente", "preparando", "listo"])), (s) => {
    state.active = s.docs.map((d) => { const x = d.data({ serverTimestamps: "estimate" }); return { id: d.id, ...x, createdAt: toMillis(x.createdAt) }; });
    render();
  }, denied));
}
const roundUnsubs = {};

render();
if (configured) {
  onSnapshot(doc(db, "config", "shop"), (s) => { if (s.exists()) state.config = { ...DEFAULT_CONFIG, ...s.data() }; render(); });
  onSnapshot(collection(db, "products"), (s) => { state.products = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); });
  onAuthStateChanged(auth, async (u) => {
    if (!u) { try { await signInAnonymously(auth); } catch (e) { console.error(e); notice("No se pudo iniciar el modo empleado. Avísale al dueño."); state.checking = false; render(); } return; }
    state.user = u;
    // El dueño (con su correo) entra directo a tomar pedidos
    if (!u.isAnonymous && OWNER_EMAILS.map((e) => e.toLowerCase()).includes(String(u.email || "").toLowerCase())) {
      state.name = "Dueño"; startListening(); return;
    }
    const sess = await getDoc(doc(db, "staffSessions", u.uid)).catch(() => null);
    if (sess && sess.exists()) { state.name = sess.data().name || state.name; state.isManager = sess.data().role === "encargado"; startListening(); }
    else { state.checking = false; render(); }
  });
  setInterval(() => { if (state.ok && state.view === "cocina" && !state.target) render(); }, 30000);
}
