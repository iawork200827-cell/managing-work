// Panel del administrador: pedidos y tiempos, mesas (cuentas abiertas), productos, ajustes, QR
// y botón para cerrar los pedidos del día.
import {
  collection, doc, onSnapshot, query, where, orderBy, writeBatch, updateDoc, addDoc, deleteDoc, setDoc, getDoc,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  db, auth, configured, OWNER_EMAILS, $, esc, money, toMillis, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG, isClosed, endOfToday, prepMinutes, newId, summaryHtml, tableLabel, tableIds, BAR_ID, PLATFORMS
} from "./common.js";

const state = {
  user: null, tab: "pedidos", config: { ...DEFAULT_CONFIG }, products: [], tables: [], secrets: {}, tabsOpen: {}, keys: {},
  active: new Map(), today: new Map(), editId: null, resetForms: false,
  seen: null, seenRefs: new Set(), fresh: new Set(), soundOn: false, unsubs: []
};
const cur = () => state.config.currency || "$";
const isOwner = (u) => !!u && OWNER_EMAILS.map((e) => e.toLowerCase()).includes(String(u.email || "").toLowerCase());
// Rol de quien usa el panel: "owner" (dueño) o "manager" (encargado: todo menos ver ventas y cambiar PIN)
const isMgr = () => state.role === "manager";
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const mins = (ms) => Math.max(0, Math.round(ms / 60000));

function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

// ---------- sonido de pedido nuevo ----------
let audio = null;
function beep() {
  if (!state.soundOn || !audio) return;
  [0, 0.25].forEach((t) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine"; o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
    const s = audio.currentTime + t;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.3, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.2);
    o.start(s); o.stop(s + 0.2);
  });
}

// ---------- datos ----------
function allOrders() { return [...new Map([...state.today, ...state.active]).values()]; }

function toOrder(d) {
  const x = d.data({ serverTimestamps: "estimate" });
  const o = { id: d.id, ...x, createdAt: toMillis(x.createdAt) };
  for (const k of ["preparandoAt", "listoAt", "entregadoAt"]) if (x[k]) o[k] = toMillis(x[k]);
  return o;
}

function listen() {
  const onErr = (e) => { console.error(e); notice("No se pudieron leer los datos. Revisa que tu correo esté en firestore.rules y firebase-config.js."); };
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  state.unsubs.push(onSnapshot(doc(db, "config", "shop"), (s) => {
    if (s.exists()) state.config = { ...DEFAULT_CONFIG, ...s.data() };
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(collection(db, "products"), (s) => {
    state.products = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(collection(db, "tables"), (s) => {
    state.tables = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
  // Claves de los QR de las mesas
  if (!isMgr()) state.unsubs.push(onSnapshot(doc(db, "staffConfig", "main"), (s) => {
    state.staff = s.exists() ? s.data() : null;
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(query(collection(db, "invoices"), orderBy("createdAt", "desc")), (s) => {
    const before = state.invoices ? new Set(state.invoices.map((i) => i.id)) : null;
    state.invoices = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (before && state.invoices.some((i) => !before.has(i.id))) { toast("Nueva solicitud de factura"); beep(); }
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(collection(db, "tableKeys"), (s) => {
    state.keys = Object.fromEntries(s.docs.map((d) => [d.id, d.data().key]));
    state.keysLoaded = true;
    if (state.tab === "qr") { ensureKeys(); render(); }
  }, onErr));
  state.unsubs.push(onSnapshot(query(collection(db, "tabs"), where("closed", "==", false)), (s) => {
    const before = new Set(Object.values(state.tabsOpen).filter((t) => t.billRequested).map((t) => t.id));
    state.tabsOpen = Object.fromEntries(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    const asked = Object.values(state.tabsOpen).filter((t) => t.billRequested && !before.has(t.id));
    if (state.seen && asked.length) { toast(`${tableLabel(asked[0].table)} pidió la cuenta`); beep(); }
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(query(collection(db, "orders"), where("status", "in", ["por_pagar", "pendiente", "preparando", "listo"])), (s) => {
    state.active = new Map(s.docs.map((d) => [d.id, toOrder(d)]));
    const ids = new Set([...state.active.values()].filter((o) => o.status === "pendiente" || o.status === "por_pagar").map((o) => o.id));
    const paidRefs = new Set([...state.active.values()].filter((o) => o.status === "por_pagar" && o.payRef).map((o) => o.id));
    if (state.seen) {
      const nuevos = [...ids].filter((id) => !state.seen.has(id));
      const avisos = [...paidRefs].filter((id) => !state.seenRefs.has(id));
      if (nuevos.length) {
        nuevos.forEach((id) => state.fresh.add(id));
        toast(nuevos.length === 1 ? "Nuevo pedido" : `${nuevos.length} pedidos nuevos`);
      } else if (avisos.length) toast("Un cliente avisó que ya transfirió");
      if (nuevos.length || avisos.length) { beep(); document.title = "(Nuevo) Panel"; }
    }
    state.seen = ids; state.seenRefs = paidRefs;
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(query(collection(db, "orders"), where("createdAt", ">=", Timestamp.fromDate(startOfDay)), orderBy("createdAt", "asc")), (s) => {
    state.today = new Map(s.docs.map((d) => [d.id, toOrder(d)]));
    render();
  }, onErr));
}

// ---------- render ----------
function render() {
  $("shopName").textContent = state.config.name || "Panel";
  const app = $("app");
  if (!configured) { app.innerHTML = notConfiguredHtml(); return; }
  if (!state.user) { app.innerHTML = loginHtml(); $("logoutBtn").hidden = true; $("soundBtn").hidden = true; return; }
  $("logoutBtn").hidden = false;
  if (!state.role) {
    app.innerHTML = state.user.isAnonymous
      ? `<div class="empty"><h2>Tu acceso es de mesero</h2><p>Usa la <a href="/empleados">página de empleados</a>. Si eres encargado, entra ahí con el PIN de encargado.</p></div>`
      : `<div class="empty"><h2>Esta cuenta no tiene acceso</h2><p>${esc(state.user.email)} no está en la lista de dueños de <code>firebase-config.js</code>.</p></div>`;
    return;
  }
  $("roleTag").textContent = isMgr() ? `Encargado: ${state.mgrName || ""}` : "Dueño";
  $("soundBtn").hidden = state.soundOn;

  const focusId = document.activeElement && document.activeElement.id;
  const keep = {};
  if (!state.resetForms) document.querySelectorAll("#app form input").forEach((i) => { if (i.id && i.type !== "checkbox") keep[i.id] = i.value; });
  state.resetForms = false;

  const pend = [...state.active.values()].filter((o) => o.status === "pendiente" || o.status === "por_pagar").length;
  const bills = Object.values(state.tabsOpen).filter((t) => t.billRequested).length;
  const openTables = Object.keys(state.tabsOpen).length;
  const tabs = [
    ["pedidos", `Pedidos${pend ? ` (${pend})` : ""}`],
    ["mesas", `Mesas${openTables ? ` (${openTables})` : ""}${bills ? " · cuenta" : ""}`],
    ...(isMgr() ? [] : [["ventas", "Ventas"]]), ["facturas", `Facturas${(state.invoices || []).filter((i) => !i.done).length ? ` (${(state.invoices || []).filter((i) => !i.done).length})` : ""}`],
    ["productos", "Productos"], ["ajustes", "Ajustes"], ["qr", "Códigos QR"]
  ];
  const closed = isClosed(state.config);
  let html = `<div class="closed-bar no-print ${closed ? "off" : ""}">
    <strong>${closed ? "Cerrado por hoy: no se reciben pedidos nuevos" : "Recibiendo pedidos"}</strong>
    <span style="display:flex;gap:6px;flex-wrap:wrap">
      <button id="deliveryBtn" class="toggle ${state.config.deliveryOn !== false ? "on" : "off"}">Domicilio: ${state.config.deliveryOn !== false ? "activo" : "apagado"}</button>
      <button id="dayBtn" class="${closed ? "primary" : "danger"}">${closed ? "Abrir pedidos" : "Cerrar pedidos por hoy"}</button>
    </span>
  </div>`;
  html += '<div class="tabs">' + tabs.map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? "on" : ""}">${l}</button>`).join("") + "</div>";
  if (state.tab === "pedidos") html += ordersHtml();
  if (state.tab === "mesas") html += tablesHtml();
  if (state.tab === "productos") html += productsHtml();
  if (state.tab === "ajustes") html += settingsHtml();
  if (state.tab === "qr") html += qrHtml();
  if (state.tab === "ventas" && !isMgr()) html += salesHtml();
  if (state.tab === "facturas") html += invoicesHtml();
  app.innerHTML = html;
  if (state.tab === "qr") drawQrs();

  for (const [id, v] of Object.entries(keep)) { const el = $(id); if (el) el.value = v; }
  if (focusId && $(focusId)) $(focusId).focus();
}

function loginHtml() {
  return `<form class="login" id="loginForm">
    <h2>Entrar al panel</h2>
    <label class="label" for="loginEmail">Correo</label>
    <input id="loginEmail" type="email" autocomplete="username" required>
    <label class="label" for="loginPass">Contraseña</label>
    <input id="loginPass" type="password" autocomplete="current-password" required>
    <button class="primary" type="submit">Entrar</button>
    <button type="button" id="forgotBtn">Olvidé mi contraseña</button>
    <p class="muted" style="margin:0;font-size:.85rem">¿Eres encargado? Escanea el QR de empleados y escribe el PIN de encargado.</p>
  </form>`;
}

function itemsByPlate(items) {
  const groups = {};
  (items || []).forEach((i) => (groups[i.plate || 1] ||= []).push(i));
  const keys = Object.keys(groups).sort((a, b) => a - b);
  const list = (arr) => `<ul>${arr.map((i) => `<li>${Number(i.qty) || 0} × ${esc(i.name)}</li>`).join("")}</ul>`;
  if (keys.length <= 1) return list(items || []);
  return keys.map((k) => `<div class="plate-label">Plato ${k}</div>${list(groups[k])}`).join("");
}

function whoLabel(o) {
  if (o.type === "plataforma") return `<span class="tag plat">${esc(PLATFORMS[o.platform] || o.platform)} #${esc(o.extRef)}</span> <strong>${esc(o.customer || "")}</strong>`;
  if (o.type === "mesa") return `<span class="tag">${esc(tableLabel(o.table))}</span>`;
  if (o.type === "casa") return `<span class="tag casa">${o.delivery === "domicilio" ? "Domicilio" : "Casa · recoge"}</span> <strong>${esc(o.customer)}</strong>`;
  return `<span class="tag">Para llevar</span> <strong>${esc(o.customer)}</strong>`;
}

function casaInfo(o) {
  if (o.type !== "casa") return "";
  return `<div class="muted" style="font-size:.88rem">Tel. <span class="mono">${esc(o.phone)}</span>${o.delivery === "domicilio" ? `<br>${esc(o.address)}` : ""}</div>`;
}

function payQueueHtml() {
  const list = allOrders().filter((o) => o.status === "por_pagar").sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) return "";
  let html = `<h3 style="margin:0 0 8px">Por confirmar pago (${list.length})</h3><div class="board" style="margin-bottom:18px">`;
  for (const o of list) {
    html += `<div class="order paywait ${o.payRef ? "new" : ""}">
      <div class="row"><span class="mono" style="font-weight:700">#${esc(o.code)}</span><span class="muted mono">hace ${mins(Date.now() - o.createdAt)} min</span></div>
      <div class="row"><span>${whoLabel(o)}</span><span class="price">${money(o.total, cur())}</span></div>
      ${casaInfo(o)}
      ${itemsByPlate(o.items)}
      <div class="${o.payRef ? "notice" : "muted"}" style="margin:0">${o.payRef ? `Dice que ya transfirió · ref: <strong>${esc(o.payRef)}</strong>` : "Todavía no avisa que pagó"}</div>
      <div class="acts"><button class="primary" data-confirmpay="${esc(o.id)}">Pago recibido: enviar a cocina</button>
        <button class="danger" data-cancel="${esc(o.id)}">Cancelar</button></div></div>`;
  }
  return html + "</div>";
}

// Tiempo real que tardó en estar listo (de recibido a listo)
const tookMin = (o) => (o.listoAt ? mins(o.listoAt - o.createdAt) : null);

function ordersHtml() {
  const orders = allOrders();
  const todays = [...state.today.values()].filter((o) => o.status !== "cancelado" && o.status !== "por_pagar");
  const sales = todays.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const inLine = orders.filter((o) => o.status === "pendiente" || o.status === "preparando");
  const took = todays.map(tookMin).filter((m) => m != null);
  const avg = took.length ? Math.round(took.reduce((a, b) => a + b, 0) / took.length) : null;
  const waitNew = Math.round(inLine.reduce((s, o) => s + (Number(o.minutes) || 5), 0) / Math.max(1, Number(state.config.capacity) || 1)) + prepMinutes(1, state.config);
  let html = `<div class="stats">
    <div class="stat"><span class="label">En fila</span><b>${inLine.length}</b></div>
    <div class="stat"><span class="label">Pedidos hoy</span><b>${todays.length}</b></div>
    ${isMgr() ? "" : `<div class="stat"><span class="label">Ventas hoy</span><b>${money(sales, cur())}</b></div>`}
    <div class="stat"><span class="label">Tiempo promedio real</span><b>${avg == null ? "—" : avg + " min"}</b></div>
    <div class="stat"><span class="label">Espera para nuevos</span><b>~${waitNew} min</b></div>
  </div>${payQueueHtml()}<div class="board">`;
  const NEXT = {
    pendiente: () => ["preparando", "Empezar a preparar"],
    preparando: () => ["listo", "Marcar listo"],
    listo: (o) => ["entregado", o.type === "mesa" ? "Servido en mesa" : o.type === "plataforma" ? "Entregado al repartidor" : o.type === "casa" ? (o.delivery === "domicilio" ? "Entregado en domicilio" : "Entregado") : "Entregado y cobrado"]
  };
  for (const s of ["pendiente", "preparando", "listo"]) {
    const list = orders.filter((o) => o.status === s).sort((a, b) => a.createdAt - b.createdAt);
    html += `<div class="col"><div class="col-head ${s}"><h3>${STATUS_LABEL[s]}</h3><span class="mono muted">${list.length}</span></div>`;
    if (!list.length) html += `<div class="empty">${s === "pendiente" ? "Aquí aparecen los pedidos nuevos." : "Sin pedidos"}</div>`;
    for (const o of list) {
      const elapsed = mins(Date.now() - o.createdAt);
      const late = s !== "listo" && elapsed > (Number(o.minutes) || 5);
      const [to, label] = NEXT[s](o);
      html += `<div class="order ${state.fresh.has(o.id) ? "new" : ""}">
        <div class="row"><span class="mono" style="font-weight:700">#${esc(o.code)}</span>
          <span class="mono ${late ? "late" : "muted"}">${s === "listo" ? `listo en ${tookMin(o) ?? elapsed} min` : `${elapsed} de ~${o.minutes || "?"} min`}</span></div>
        <div class="row"><span>${whoLabel(o)}</span><span class="price">${money(o.total, cur())}</span></div>
        ${casaInfo(o)}
        ${itemsByPlate(o.items)}
        ${o.takenBy ? `<div class="muted" style="font-size:.8rem">Tomó: ${esc(o.takenBy)}</div>` : ""}
        ${o.note ? `<div class="notice" style="margin:0">Nota: ${esc(o.note)}</div>` : ""}
        <div class="acts"><button class="primary" data-advance="${esc(o.id)}" data-to="${to}">${label}</button>
          ${s !== "listo" ? `<button class="danger" data-cancel="${esc(o.id)}">Cancelar</button>` : ""}</div>
      </div>`;
    }
    html += "</div>";
  }
  html += "</div>";
  const done = [...state.today.values()].filter((o) => o.status === "entregado" || o.status === "cancelado").sort((a, b) => b.createdAt - a.createdAt);
  if (done.length) {
    html += `<details style="margin-top:20px"><summary><strong>Historial de hoy (${done.length})</strong></summary><div class="plist" style="margin-top:10px">`;
    for (const o of done) {
      const t = tookMin(o);
      html += `<div class="prow"><div><span class="mono">#${esc(o.code)}</span> · ${o.type === "mesa" ? "Mesa " + esc(o.table) : esc(o.customer)} · <span class="muted">${fmtTime(o.createdAt)}${t != null ? ` · tardó ${t} min` : ""}</span></div>
        <div class="price ${o.status === "cancelado" ? "muted" : ""}">${o.status === "cancelado" ? "Cancelado" : money(o.total, cur())}</div></div>`;
    }
    html += "</div></details>";
  }
  return html;
}

// Cuentas abiertas: puede haber varias en la misma mesa
function openTabs() {
  return Object.values(state.tabsOpen).sort((a, b) =>
    (b.billRequested ? 1 : 0) - (a.billRequested ? 1 : 0) || Number(a.table) - Number(b.table) || toMillis(a.openedAt) - toMillis(b.openedAt));
}
function roundsOfTab(tab) {
  return allOrders().filter((o) => o.type === "mesa" && o.session === tab.id && o.status !== "cancelado").sort((a, b) => a.createdAt - b.createdAt);
}

function tablesHtml() {
  const tabs = openTabs();
  if (!tabs.length) return `<div class="empty">No hay cuentas abiertas. Cuando un cliente pida desde el QR de su mesa, aparecerá aquí.</div>`;
  const perTable = {};
  tabs.forEach((t) => (perTable[t.table] = (perTable[t.table] || 0) + 1));
  let html = '<div class="board">';
  for (const tab of tabs) {
    const rounds = roundsOfTab(tab);
    const total = rounds.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const pending = rounds.filter((r) => r.status !== "entregado").length;
    html += `<div class="order"><div class="row"><h3>${esc(tableLabel(tab.table))}${perTable[tab.table] > 1 ? ` <span class="tag">${perTable[tab.table]} cuentas</span>` : ""}</h3>${tab.billRequested ? '<span class="tag bill">Pidió la cuenta</span>' : ""}</div>
      <div class="row"><span class="muted">${tab.name ? `<strong>${esc(tab.name)}</strong> · ` : ""}Cuenta <span class="mono">${esc(tab.code)}</span>${tab.openedBy ? ` · abrió ${esc(tab.openedBy)}` : ""} · abierta ${tab.openedAt ? fmtTime(toMillis(tab.openedAt)) : ""} · ${rounds.length} ${rounds.length === 1 ? "ronda" : "rondas"}${pending ? ` · ${pending} en cocina` : ""}</span><span class="price">${money(total, cur())}</span></div>
      ${summaryHtml(rounds.map((r) => r.items), cur(), "Resumen de la cuenta")}
      <details><summary class="muted">Ver por ronda</summary>${rounds.map((r, i) => `<div class="round"><div class="row"><strong>Ronda ${i + 1}</strong><span class="muted">${STATUS_LABEL[r.status]}</span><span class="price">${money(r.total, cur())}</span></div>${itemsByPlate(r.items)}</div>`).join("")}</details>
      <div class="acts"><button class="primary" data-close="${esc(tab.id)}" data-method="efectivo">Cobrado en efectivo</button>
        <button data-close="${esc(tab.id)}" data-method="tarjeta">Cobrado con tarjeta</button></div></div>`;
  }
  return html + "</div>";
}

function productsHtml() {
  const e = state.editId ? state.products.find((p) => p.id === state.editId) : null;
  let html = `<form class="form" id="pform">
    <label>Nombre<input id="pName" required maxlength="80" value="${esc(e?.name)}"></label>
    <label>Precio<input id="pPrice" type="number" step="0.01" min="0" required value="${e ? esc(e.price) : ""}"></label>
    <label>Categoría<input id="pCat" list="catlist" maxlength="40" placeholder="Tacos, Platillos, Bebidas…" value="${esc(e?.category)}"></label>
    <label>Descripción<input id="pDesc" maxlength="160" value="${esc(e?.description)}"></label>
    <label>Carnes para escoger (separadas por coma)<input id="pOpts" maxlength="300" placeholder="Pastor, Bistec, Barbacoa…" value="${esc((e?.options || []).join(", "))}"></label>
    <datalist id="catlist">${[...new Set(state.products.map((p) => p.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="primary" type="submit">${e ? "Guardar cambios" : "Agregar producto"}</button>
      ${e ? '<button type="button" data-canceledit>Cancelar</button>' : ""}</div>
  </form>`;
  if (!state.products.length) {
    return html + `<div class="empty"><p>Todavía no tienes productos. Agrégalos con el formulario de arriba.</p>
      <button class="primary" data-sample>Cargar menú de Tacos Josué</button></div>`;
  }
  const out = state.products.filter((p) => p.available === false).length;
  // Carnes para escoger + carnes que van en el nombre del producto (ej. "Taco de arrachera")
  const allOpts = [...new Set([...MEATS, ...EXTRA_MEATS, ...state.products.flatMap((p) => p.options || [])])];
  const outOpts = new Set((state.config.outOptions || []).map((o) => String(o).toLowerCase()));
  html += `<div class="meatbox"><h3>Carnes</h3><p class="muted" style="margin:2px 0 8px">Toca una carne para marcarla como agotada en todo el menú. Con <strong>Arrachera</strong> se bloquean de un jalón todos los productos de arrachera.</p>
    <div class="opts">${allOpts.map((o) => { const off = outOpts.has(o.toLowerCase()); return `<button class="toggle ${off ? "off" : "on"}" data-meat="${esc(o)}" aria-pressed="${off}">${esc(o)}${off ? " · agotada" : ""}</button>`; }).join("")}</div>
    ${(outOpts.size || state.products.some((p) => p.available === false)) ? `<button style="margin-top:10px" class="primary" data-allon>Marcar todo como disponible</button>` : ""}
    ${state.products.some((p) => WITH_MEATS.includes(p.name) && !(p.options || []).length) ? `<button style="margin-top:10px" data-addmeats>Agregar carnes a tacos, burritos, quesadillas, gringas y tortas</button>` : ""}</div>`;
  html += `<div class="no-print" style="margin:0 0 10px"><button data-sample data-replace>Reemplazar todo con el menú de Tacos Josué</button></div>`;
  html += `<p class="muted" style="margin:0 0 10px">${state.products.length} productos · ${out} agotados. Toca <strong>Disponible / Agotado</strong> para bloquear un producto al instante.</p><div class="plist">`;
  const sorted = [...state.products].sort((a, b) => (a.category || "").localeCompare(b.category || "") || (a.order ?? 0) - (b.order ?? 0));
  for (const p of sorted) {
    const on = p.available !== false;
    const byMeat = on && [...outOpts].some((o) => p.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(o.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
    html += `<div class="prow"><div><strong>${esc(p.name)}</strong> <span class="price muted">${money(p.price, cur())}</span>
        <div class="muted" style="font-size:.82rem">${esc(p.category || "Otros")}${(p.options || []).length ? " · " + esc(p.options.join(", ")) : ""}${byMeat ? ' · <span class="late">agotado por la carne</span>' : ""}</div></div>
      <div class="acts">
        <button class="toggle ${on ? "on" : "off"}" data-toggle="${esc(p.id)}" aria-pressed="${!on}">${on ? "Disponible" : "Agotado"}</button>
        <button data-edit="${esc(p.id)}">Editar</button>
        <button class="danger" data-del="${esc(p.id)}">Borrar</button>
      </div></div>`;
  }
  return html + "</div>";
}

function settingsHtml() {
  const c = state.config;
  return `<form class="form" id="sform">
    <label>Nombre del negocio<input id="sName" maxlength="60" value="${esc(c.name)}"></label>
    <label>Símbolo de moneda<input id="sCur" maxlength="4" value="${esc(c.currency)}"></label>
    <label>Minutos por pedido chico<input id="sMinM" type="number" min="1" max="60" value="${esc(c.minMinutes)}"></label>
    <label>Minutos por pedido grande<input id="sMaxM" type="number" min="1" max="60" value="${esc(c.maxMinutes)}"></label>
    <label>Pedidos que preparan a la vez<input id="sCap" type="number" min="1" max="10" value="${esc(c.capacity)}"></label>
    <label>Número de mesas<input id="sTables" type="number" min="1" max="200" value="${esc(c.tables)}"></label>
    <label>Comisión de Uber Eats (%)<input id="sUberFee" type="number" min="0" max="60" step="0.1" value="${esc(c.uberFee ?? "")}" placeholder="Ej. 30"></label>
    <label>Comisión de DiDi Food (%)<input id="sDidiFee" type="number" min="0" max="60" step="0.1" value="${esc(c.didiFee ?? "")}" placeholder="Ej. 25"></label>
    <label class="check"><input id="sBar" type="checkbox" ${c.bar !== false ? "checked" : ""}> Tenemos barra (con su propio QR)</label>
    <label>Banco (para pedidos desde casa)<input id="sBank" maxlength="40" value="${esc(c.bank)}" placeholder="BBVA, Banorte…"></label>
    <label>Titular de la cuenta<input id="sHolder" maxlength="60" value="${esc(c.holder)}"></label>
    <label>CLABE (18 dígitos)<input id="sClabe" maxlength="22" inputmode="numeric" value="${esc(c.clabe)}"></label>
    ${isMgr() ? "" : `<label>PIN de meseros (4 a 8 números)<input id="sPin" maxlength="8" inputmode="numeric" autocomplete="off" placeholder="${state.staff && state.staff.pin ? "••••  (escribe uno nuevo para cambiarlo)" : "Ej. 2580"}"></label>
    <label>PIN de encargado (4 a 8 números, distinto)<input id="sMgrPin" maxlength="8" inputmode="numeric" autocomplete="off" placeholder="${state.staff && state.staff.mgrPin ? "••••  (escribe uno nuevo para cambiarlo)" : "Ej. 7391"}"></label>`}
    <div><button class="primary" type="submit">Guardar ajustes</button></div>
  </form>
  <p class="muted">Cada pedido tarda entre el mínimo y el máximo según cuántas piezas lleva (hasta 3 piezas = mínimo; +1 minuto por cada 2 piezas más).
  El tiempo que ve el cliente suma los pedidos que van antes que el suyo, repartidos entre los que la cocina prepara a la vez.</p>`;
}

function qrHtml() {
  const base = location.origin;
  let cards = `<div class="qrcard"><div class="qr" data-url="${esc(base + "/llevar")}"></div><strong>Para llevar</strong><span>Escanea para pedir</span></div>
    <div class="qrcard"><div class="qr" data-url="${esc(base + "/casa")}"></div><strong>Pide desde casa</strong><span>${esc(base.replace(/^https?:\/\//, "") + "/casa")}</span></div>`;
  for (const i of tableIds(state.config)) {
    const key = state.keys[String(i)];
    cards += key
      ? `<div class="qrcard"><div class="qr" data-url="${esc(base + "/mesa?m=" + i + "&k=" + key)}"></div><strong>${tableLabel(i)}</strong><span>Escanea para ordenar</span></div>`
      : `<div class="qrcard"><strong>${tableLabel(i)}</strong><span>Generando código…</span></div>`;
  }
  return `<div class="no-print" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <button class="primary" id="sheetBtn">Descargar códigos (imagen)</button>
      <button id="printBtn">Imprimir</button>
      <span class="muted">Estos son los códigos definitivos. Cada QR de mesa tiene una clave: solo quien lo escanea en la mesa puede abrir una cuenta.</span></div>
    <div id="sheetOut" class="no-print"></div>
    <div class="qrgrid">${cards}</div>
    <h2 style="margin:24px 0 8px">QR de empleados</h2>
    ${isMgr() ? `<p class="muted">El QR de empleados solo lo ve el dueño.</p>` : state.staff && state.staff.key
      ? `<p class="muted" style="margin:0 0 10px">Solo para tu personal: al escanearlo piden su nombre y el PIN de empleados. No lo pegues en las mesas. Para guardarlo, haz una captura de pantalla.</p>
         <div class="qrgrid"><div class="qrcard staffcard"><div class="qr" data-url="${esc(location.origin + "/empleados?k=" + state.staff.key)}"></div><strong>Empleados</strong><span>Requiere PIN</span></div></div>`
      : `<div class="empty">Primero pon un <strong>PIN de meseros</strong> en Ajustes y aquí aparecerá el QR.</div>`}`;
}

// Arma una hoja (tamaño carta/A4) con todos los QR en una imagen que se puede guardar e imprimir
function buildSheet() {
  // La hoja para imprimir NO lleva el QR de empleados
  const cards = [...document.querySelectorAll(".qrcard:not(.staffcard)")].filter((c) => c.querySelector(".qr canvas, .qr img"));
  if (!cards.length) { toast("Espera a que aparezcan los códigos"); return; }
  const W = 1240, cols = 2, cw = 560, ch = 660, gap = 40, top = 120;
  const rows = Math.ceil(cards.length / cols);
  const H = Math.max(1754, top + rows * (ch + gap) + 40);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#111111"; g.textAlign = "center";
  g.font = "bold 48px system-ui, -apple-system, sans-serif";
  g.fillText(state.config.name || "Tacos Josué", W / 2, 80);
  cards.forEach((card, i) => {
    const x = 40 + (i % cols) * (cw + gap), y = top + Math.floor(i / cols) * (ch + gap);
    g.strokeStyle = "#999999"; g.lineWidth = 2; g.setLineDash([12, 10]); g.strokeRect(x, y, cw, ch); g.setLineDash([]);
    const src = card.querySelector(".qr canvas") || card.querySelector(".qr img");
    const size = 440;
    g.imageSmoothingEnabled = false;
    g.drawImage(src, x + (cw - size) / 2, y + 40, size, size);
    g.fillStyle = "#111111";
    g.font = "bold 44px system-ui, -apple-system, sans-serif";
    g.fillText(card.querySelector("strong")?.textContent || "", x + cw / 2, y + size + 105);
    g.font = "28px system-ui, -apple-system, sans-serif"; g.fillStyle = "#444444";
    g.fillText(card.querySelector("span")?.textContent || "", x + cw / 2, y + size + 150);
  });
  const url = cv.toDataURL("image/png");
  const out = document.getElementById("sheetOut");
  out.innerHTML = `<div class="meatbox"><h3>Tus códigos QR</h3>
    <p class="muted" style="margin:4px 0 10px">En iPhone o Android: <strong>mantén presionada la imagen → Guardar en Fotos</strong>. Desde Fotos puedes imprimirla o mandarla a una papelería. En computadora, usa el botón Descargar.</p>
    <a class="dl" href="${url}" download="codigos-qr-tacos-josue.png">Descargar imagen</a>
    <img src="${url}" alt="Hoja con los códigos QR" style="display:block;width:100%;max-width:620px;margin-top:10px;border:1px solid var(--line);border-radius:8px"></div>`;
  out.scrollIntoView({ behavior: "smooth" });
}

// Crea la clave secreta de cada mesa que todavía no tenga
let ensuring = false;
async function ensureKeys() {
  if (ensuring || !state.keysLoaded) return;
  const missing = [];
  // Solo crea claves para mesas (y la barra) que no tengan; las existentes nunca se cambian
  for (const id of tableIds(state.config)) if (!state.keys[id]) missing.push(id);
  if (!missing.length) return;
  ensuring = true;
  try {
    const b = writeBatch(db);
    missing.forEach((id) => b.set(doc(db, "tableKeys", id), { key: newId(16), createdAt: serverTimestamp() }));
    await b.commit();
  } catch (e) { console.error(e); toast("No se pudieron crear los códigos de las mesas"); }
  ensuring = false;
}

function drawQrs() {
  document.querySelectorAll(".qr[data-url]").forEach((el) => {
    el.innerHTML = "";
    if (window.QRCode) new QRCode(el, { text: el.dataset.url, width: 160, height: 160, colorDark: "#111111", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    else el.textContent = el.dataset.url;
  });
}

// ---------- solicitudes de factura ----------
function invoicesHtml() {
  const list = state.invoices || [];
  if (!list.length) return '<div class="empty">Todavía no hay solicitudes de factura. Los clientes la piden desde su ticket o la cuenta de su mesa.</div>';
  let html = '<div class="plist">';
  for (const i of list) {
    const when = i.createdAt ? new Date(toMillis(i.createdAt)).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "";
    html += `<div class="prow ${i.done ? "voided" : ""}"><div>
        <div><strong>${esc(i.razon)}</strong> · <span class="mono">${esc(i.rfc)}</span> ${i.done ? '<span class="tag casa">Hecha</span>' : '<span class="tag">Pendiente</span>'}</div>
        <div class="muted" style="font-size:.85rem">${i.kind === "cuenta" ? "Mesa " + esc(i.table || "") + " · cuenta " : "Pedido #"}<span class="mono">${esc(i.code || "")}</span> · ${esc(when)}</div>
        <div style="font-size:.85rem">Correo: <span class="mono">${esc(i.email)}</span> · C.P. <span class="mono">${esc(i.cp)}</span></div>
        <div class="muted" style="font-size:.85rem">Régimen: ${esc(i.regimen)} · Uso CFDI: ${esc(i.uso)}</div></div>
      <div class="acts"><span class="price">${money(i.total, cur())}</span>
        <button data-invoice="${esc(i.id)}" data-done="${i.done ? "0" : "1"}">${i.done ? "Marcar pendiente" : "Marcar hecha"}</button></div></div>`;
  }
  return html + "</div>";
}

// ---------- ventas del día (con anular / restaurar) ----------
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let salesUnsub = null, salesLoadedFor = null;
function loadSalesDay(key) {
  if (salesLoadedFor === key) return;
  salesLoadedFor = key;
  if (salesUnsub) { salesUnsub(); salesUnsub = null; }
  state.salesOrders = null;
  if (key === dayKey(new Date())) return; // hoy: se usan los pedidos que ya están en vivo
  const [y, m, d] = key.split("-").map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0), to = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  salesUnsub = onSnapshot(query(collection(db, "orders"), where("createdAt", ">=", Timestamp.fromDate(from)), where("createdAt", "<", Timestamp.fromDate(to)), orderBy("createdAt", "asc")), (snap) => {
    state.salesOrders = snap.docs.map(toOrder);
    render();
  }, (e) => { console.error(e); toast("No se pudieron leer las ventas de ese día"); });
}

const METHOD_LABEL = { efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia", uber: "Uber Eats", didi: "DiDi Food" };
function methodOf(o) {
  if (o.type === "plataforma") return o.platform;
  if (o.payMethod) return o.payMethod;
  if (o.type === "llevar" && o.status === "entregado") return "efectivo"; // se paga al recoger
  return "";
}

// Junta los pedidos del día en ventas: cada cuenta de mesa es una sola venta
function salesOf(orders) {
  const groups = new Map();
  for (const o of orders) {
    if (o.status === "por_pagar") continue; // no es venta hasta confirmar el pago
    const key = o.type === "mesa" ? "tab:" + o.session : "order:" + o.id;
    const g = groups.get(key) || { key, type: o.type, orders: [], table: o.table, session: o.session, who: o.customer || "" };
    g.orders.push(o);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const live = g.orders.filter((o) => o.status !== "cancelado");
    const voided = live.length === 0;
    const total = (voided ? g.orders : live).reduce((s, o) => s + (Number(o.total) || 0), 0);
    const first = g.orders.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    // Uber Eats / DiDi Food ya vienen pagados por la plataforma
    const paid = live.length > 0 && live.every((o) => o.paid || o.type === "plataforma" || (o.type === "llevar" && o.status === "entregado"));
    const tabInfo = g.type === "mesa" ? state.tabsOpen[g.session] : null;
    return { ...g, voided, total, time: first.createdAt, method: methodOf(live[0] || g.orders[0]), paid, open: g.type === "mesa" && !!tabInfo, code: tabInfo ? tabInfo.code : first.code };
  }).sort((a, b) => b.time - a.time);
}

function salesHtml() {
  const key = state.salesDay || dayKey(new Date());
  loadSalesDay(key);
  const isToday = key === dayKey(new Date());
  const orders = isToday ? [...state.today.values()] : state.salesOrders;
  let html = `<div class="form no-print" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
    <label>Día<input id="salesDay" type="date" value="${esc(key)}" max="${esc(dayKey(new Date()))}"></label>
    <p class="muted" style="margin:0">Toca <strong>Anular</strong> en una venta para que ya no sume (por ejemplo, si se cobró por error). Puedes deshacerlo con <strong>Restaurar</strong>.</p></div>`;
  if (!orders) return html + '<p class="muted">Cargando ventas…</p>';
  const sales = salesOf(orders);
  const valid = sales.filter((v) => !v.voided);
  const sum = (arr) => arr.reduce((s, v) => s + v.total, 0);
  const byMethod = {};
  valid.filter((v) => v.paid).forEach((v) => { const m = v.method || "otro"; byMethod[m] = (byMethod[m] || 0) + v.total; });
  const pending = valid.filter((v) => !v.paid);
  html += `<div class="stats">
    <div class="stat"><span class="label">Total vendido</span><b>${money(sum(valid), cur())}</b></div>
    <div class="stat"><span class="label">Ventas</span><b>${valid.length}</b></div>
    ${["efectivo", "tarjeta", "transferencia"].map((m) => `<div class="stat"><span class="label">${METHOD_LABEL[m]}</span><b>${money(byMethod[m] || 0, cur())}</b></div>`).join("")}
    ${["uber", "didi"].map((m) => {
      const fee = Number(state.config[m + "Fee"]) || 0, gross = byMethod[m] || 0;
      return `<div class="stat"><span class="label">${METHOD_LABEL[m]}</span><b>${money(gross, cur())}</b>${fee ? `<span class="muted" style="font-size:.8rem">Te queda ${money(gross * (1 - fee / 100), cur())} (comisión ${fee}%)</span>` : ""}</div>`;
    }).join("")}
    <div class="stat"><span class="label">Por cobrar</span><b>${money(sum(pending), cur())}</b></div>
    <div class="stat"><span class="label">Anuladas</span><b>${sales.length - valid.length}</b></div>
  </div>`;
  if (!sales.length) return html + '<div class="empty">No hay ventas este día.</div>';
  html += '<div class="plist">';
  for (const v of sales) {
    const p0 = v.orders[0];
    const who = v.type === "plataforma" ? `<span class="tag plat">${esc(PLATFORMS[p0.platform] || "")} #${esc(p0.extRef || "")}</span> ${esc(v.who)}`
      : v.type === "mesa" ? `${esc(tableLabel(v.table))} · cuenta <span class="mono">${esc(v.code || "")}</span>` : `${v.type === "casa" ? "Desde casa" : "Para llevar"} · ${esc(v.who)} <span class="mono muted">#${esc(v.code || "")}</span>`;
    const state_ = v.voided ? '<span class="tag bill">Anulada</span>' : v.open ? '<span class="tag">Cuenta abierta</span>' : v.paid ? `<span class="tag casa">${METHOD_LABEL[v.method] || "Cobrada"}</span>` : '<span class="tag">Por cobrar</span>';
    html += `<div class="prow ${v.voided ? "voided" : ""}"><div><div>${who} ${state_}</div>
        <div class="muted" style="font-size:.82rem">${fmtTime(v.time)} · ${v.orders.length > 1 ? v.orders.length + " rondas" : "1 pedido"}</div>
        <details><summary class="muted" style="font-size:.82rem">Ver productos</summary>${summaryHtml(v.orders.filter((o) => v.voided || o.status !== "cancelado").map((o) => o.items), cur(), "Productos")}</details></div>
      <div class="acts"><span class="price">${money(v.total, cur())}</span>
        ${v.voided ? `<button data-restore="${esc(v.key)}">Restaurar</button>` : `<button class="danger" data-void="${esc(v.key)}">Anular</button>`}</div></div>`;
  }
  return html + "</div>";
}

function voidSale(key, restore) {
  const orders = state.salesDay && state.salesDay !== dayKey(new Date()) ? state.salesOrders || [] : [...state.today.values()];
  const v = salesOf(orders).find((x) => x.key === key);
  if (!v) return;
  return write(async () => {
    const b = writeBatch(db);
    for (const o of v.orders) {
      if (!restore) {
        if (o.status === "cancelado") continue;
        b.update(doc(db, "orders", o.id), { status: "cancelado", voided: true, prevStatus: o.status, voidedAt: serverTimestamp() });
        b.delete(doc(db, "queue", o.id));
        if (o.type === "mesa" && o.session) b.set(doc(db, "tabs", o.session, "rounds", o.id), { status: "cancelado" }, { merge: true });
      } else {
        if (!o.voided) continue;
        // Se restaura como entregada/cobrada para que vuelva a sumar (no regresa a la cocina)
        const back = o.prevStatus === "por_pagar" ? "por_pagar" : "entregado";
        b.update(doc(db, "orders", o.id), { status: back, voided: false });
        if (o.type === "mesa" && o.session) b.set(doc(db, "tabs", o.session, "rounds", o.id), { status: back }, { merge: true });
      }
    }
    await b.commit();
  }, restore ? "Venta restaurada" : "Venta anulada: ya no suma");
}

// ---------- escrituras ----------
async function write(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { console.error(e); toast(e && e.code === "permission-denied" ? "Tu cuenta no tiene permiso para este cambio." : "No se pudo guardar. Intenta otra vez."); }
}

function setStatus(id, status) {
  const o = allOrders().find((x) => x.id === id);
  return write(async () => {
    const b = writeBatch(db);
    const patch = { status };
    if (status !== "cancelado") patch[status + "At"] = serverTimestamp();
    if (status === "entregado" && o && o.type === "llevar") patch.paid = true;
    if (status === "entregado" && o && o.type === "plataforma") { patch.paid = true; patch.payMethod = o.platform; }
    b.update(doc(db, "orders", id), patch);
    if (o && o.type === "mesa" && o.session) b.set(doc(db, "tabs", o.session, "rounds", id), { status }, { merge: true });
    if (status === "entregado" || status === "cancelado") b.delete(doc(db, "queue", id));
    else b.update(doc(db, "queue", id), { status });
    await b.commit();
    state.fresh.delete(id);
  }, status === "cancelado" ? "Pedido cancelado" : null);
}

function closeTab(tabId, method) {
  const tab = state.tabsOpen[tabId];
  if (!tab) return;
  const rounds = roundsOfTab(tab);
  const total = rounds.reduce((s, r) => s + (Number(r.total) || 0), 0);
  return write(async () => {
    const b = writeBatch(db);
    b.set(doc(db, "tabs", tabId), { closed: true, billRequested: false, total, payMethod: method, closedAt: serverTimestamp() }, { merge: true });
    for (const r of rounds) {
      const patch = { paid: true, payMethod: method };
      if (r.status !== "entregado") {
        patch.status = "entregado"; patch.entregadoAt = serverTimestamp(); b.delete(doc(db, "queue", r.id));
        b.set(doc(db, "tabs", tabId, "rounds", r.id), { status: "entregado" }, { merge: true });
      }
      b.update(doc(db, "orders", r.id), patch);
    }
    await b.commit();
  }, `${tableLabel(tab.table)} (cuenta ${tab.code}) cobrada y cerrada`);
}

// Carnes que el cliente puede escoger en tacos, burritos, quesadillas, gringas y tortas.
const MEATS = ["Bistec", "Pastor", "Combinado", "Barbacoa", "Alambre", "Chorizo", "Tripa", "Hígado"];
const WITH_MEATS = ["Tacos", "Burritos", "Quesadilla", "Gringa", "Tortas"];
// Al marcar una de estas como agotada, se bloquean todos los productos que la llevan en el nombre
const EXTRA_MEATS = ["Arrachera"];

// Menú de Tacos Josué (tomado de su punto de venta). Se carga con un botón en Productos.
const SAMPLE = [
  ["Tacos", 17, "Tacos"], ["Taco de arrachera", 18, "Tacos"],
  ["Burritos", 20, "Burritos"], ["Burrito de arrachera", 25, "Burritos"],
  ["Quesadilla", 40, "Gringas y quesadillas"], ["Quesadilla de arrachera", 45, "Gringas y quesadillas"],
  ["Gringa", 50, "Gringas y quesadillas"], ["Gringa de arrachera", 55, "Gringas y quesadillas"],
  ["Tortas", 45, "Tortas"], ["Torta de arrachera", 50, "Tortas"],
  ["1 kg de arrachera", 320, "Por kilo"], ["1 kg de barbacoa", 300, "Por kilo"], ["1 kg de sazón", 260, "Por kilo"],
  ["Refresco y agua", 25, "Bebidas"], ["Agua de litro", 40, "Bebidas"], ["Refresco 1½ litros", 55, "Bebidas"]
];

// ---------- eventos ----------
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button"); if (!t) return;
  const d = t.dataset;
  if (d.tab) { state.tab = d.tab; state.resetForms = true; document.title = "Panel del dueño"; if (d.tab === "qr") ensureKeys(); render(); return; }
  if (t.id === "dayBtn") {
    const closed = isClosed(state.config);
    if (!closed && !t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Cerrar por hoy? Toca otra vez"; return; }
    write(() => setDoc(doc(db, "config", "shop"), { ...state.config, closedUntil: closed ? null : Timestamp.fromDate(endOfToday()) }),
      closed ? "Pedidos abiertos" : "Cerrado por hoy. Mañana se abre solo.");
    return;
  }
  if (d.advance) { setStatus(d.advance, d.to); return; }
  if (d.void) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Anular? Toca otra vez"; return; }
    voidSale(d.void, false); return;
  }
  if (d.restore) { voidSale(d.restore, true); return; }
  if (d.invoice) { write(() => updateDoc(doc(db, "invoices", d.invoice), { done: d.done === "1" }), d.done === "1" ? "Factura marcada como hecha" : null); return; }
  if (d.confirmpay) {
    const o = allOrders().find((x) => x.id === d.confirmpay);
    if (!o) return;
    write(async () => {
      const b = writeBatch(db);
      b.update(doc(db, "orders", o.id), { status: "pendiente", paid: true, payMethod: "transferencia", confirmedAt: serverTimestamp() });
      b.set(doc(db, "queue", o.id), { status: "pendiente", createdAt: serverTimestamp(), minutes: Number(o.minutes) || 5 });
      await b.commit();
    }, `Pedido #${o.code} enviado a cocina`);
    return;
  }
  if (t.id === "deliveryBtn") {
    const on = state.config.deliveryOn !== false;
    write(() => setDoc(doc(db, "config", "shop"), { ...state.config, deliveryOn: !on }), on ? "Domicilio apagado" : "Domicilio activo");
    return;
  }
  if (d.cancel) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Seguro? Toca otra vez"; return; }
    setStatus(d.cancel, "cancelado"); return;
  }
  if (d.close) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Confirmas? Toca otra vez"; return; }
    closeTab(d.close, d.method); return;
  }
  if (d.toggle) {
    const p = state.products.find((x) => x.id === d.toggle);
    const now = p.available === false;
    write(() => updateDoc(doc(db, "products", d.toggle), { available: now }), now ? `${p.name}: disponible` : `${p.name}: agotado`);
    return;
  }
  if (d.edit) { state.editId = d.edit; state.resetForms = true; render(); window.scrollTo({ top: 0 }); return; }
  if ("canceledit" in d) { state.editId = null; state.resetForms = true; render(); return; }
  if (d.del) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Borrar? Toca otra vez"; return; }
    write(() => deleteDoc(doc(db, "products", d.del)), "Producto borrado"); return;
  }
  if (d.meat) {
    const name = d.meat.toLowerCase();
    const cur = (state.config.outOptions || []).filter((o) => String(o).toLowerCase() !== name);
    const nowOut = cur.length === (state.config.outOptions || []).length;
    write(() => setDoc(doc(db, "config", "shop"), { ...state.config, outOptions: nowOut ? [...cur, d.meat] : cur }),
      nowOut ? `${d.meat}: agotada` : `${d.meat}: disponible`);
    return;
  }
  if ("allon" in d) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Todo disponible? Toca otra vez"; return; }
    write(async () => {
      const b = writeBatch(db);
      b.set(doc(db, "config", "shop"), { ...state.config, outOptions: [] });
      state.products.filter((p) => p.available === false).forEach((p) => b.update(doc(db, "products", p.id), { available: true }));
      await b.commit();
    }, "Todo el menú está disponible otra vez");
    return;
  }
  if ("addmeats" in d) {
    write(async () => {
      const b = writeBatch(db);
      state.products.filter((p) => WITH_MEATS.includes(p.name) && !(p.options || []).length).forEach((p) => b.update(doc(db, "products", p.id), { options: MEATS }));
      await b.commit();
    }, "Carnes agregadas");
    return;
  }
  if ("sample" in d) {
    if ("replace" in d && !t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "Se borran los productos actuales. ¿Seguro? Toca otra vez"; return; }
    write(async () => {
      const b = writeBatch(db);
      if ("replace" in d) state.products.forEach((p) => b.delete(doc(db, "products", p.id)));
      SAMPLE.forEach(([name, price, category], i) => b.set(doc(collection(db, "products")), { name, price, category, description: "", available: true, order: i, ...(WITH_MEATS.includes(name) ? { options: MEATS } : {}) }));
      await b.commit();
    }, "Menú cargado");
    return;
  }
  if (t.id === "printBtn") { try { window.print(); } catch (e) {} setTimeout(() => toast("Si no se abrió la impresión, usa \"Descargar códigos (imagen)\""), 800); return; }
  if (t.id === "sheetBtn") { buildSheet(); return; }
  if (t.id === "logoutBtn") { signOut(auth); return; }
  if (t.id === "soundBtn") {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); state.soundOn = true; beep(); toast("Sonido activado"); }
    catch (e) { toast("Este navegador no permite sonido"); }
    render(); return;
  }
  if (t.id === "forgotBtn") {
    const email = $("loginEmail").value.trim();
    if (!email) { toast("Escribe tu correo primero"); $("loginEmail").focus(); return; }
    sendPasswordResetEmail(auth, email).then(() => toast("Te enviamos un correo para cambiar tu contraseña"), () => toast("No se pudo enviar el correo"));
  }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "salesDay" && ev.target.value) { state.salesDay = ev.target.value; state.resetForms = true; render(); }
});

document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const id = ev.target.id;
  if (id === "loginForm") {
    signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPass").value)
      .catch(() => toast("Correo o contraseña incorrectos"));
  }
  if (id === "pform") {
    const body = {
      name: $("pName").value.trim(), price: Math.max(0, Number($("pPrice").value) || 0),
      category: $("pCat").value.trim() || "Otros", description: $("pDesc").value.trim(),
      options: [...new Set($("pOpts").value.split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 30)
    };
    if (!body.name) return;
    state.resetForms = true;
    if (state.editId) { const pid = state.editId; state.editId = null; write(() => updateDoc(doc(db, "products", pid), body), "Producto actualizado"); }
    else write(() => addDoc(collection(db, "products"), { ...body, available: true, order: Date.now() }), "Producto agregado");
    render();
  }
  if (id === "sform") {
    const minM = Math.min(60, Math.max(1, Number($("sMinM").value) || 5));
    const body = {
      ...state.config,
      name: $("sName").value.trim() || "Tacos Josué",
      currency: $("sCur").value.trim() || "$",
      minMinutes: minM,
      maxMinutes: Math.min(60, Math.max(minM, Number($("sMaxM").value) || 10)),
      capacity: Math.min(10, Math.max(1, Number($("sCap").value) || 1)),
      tables: Math.min(200, Math.max(1, Number($("sTables").value) || 1)),
      bar: $("sBar").checked,
      uberFee: Math.min(60, Math.max(0, Number($("sUberFee").value) || 0)),
      didiFee: Math.min(60, Math.max(0, Number($("sDidiFee").value) || 0)),
      bank: $("sBank").value.trim(),
      holder: $("sHolder").value.trim(),
      clabe: $("sClabe").value.replace(/\s/g, "")
    };
    if (body.clabe && !/^\d{18}$/.test(body.clabe)) { toast("La CLABE debe tener 18 dígitos"); return; }
    const pin = isMgr() ? "" : $("sPin").value.trim();
    const mgrPin = isMgr() ? "" : $("sMgrPin").value.trim();
    if ((pin && !/^\d{4,8}$/.test(pin)) || (mgrPin && !/^\d{4,8}$/.test(mgrPin))) { toast("Cada PIN debe tener de 4 a 8 números"); return; }
    const curPin = pin || (state.staff && state.staff.pin) || "", curMgr = mgrPin || (state.staff && state.staff.mgrPin) || "";
    if (curPin && curMgr && curPin === curMgr) { toast("El PIN de encargado debe ser distinto al de meseros"); return; }
    state.resetForms = true;
    write(async () => {
      await setDoc(doc(db, "config", "shop"), body);
      // Cambiar un PIN saca a quienes entraron con el anterior; el QR de empleados no cambia
      if (pin || mgrPin) await setDoc(doc(db, "staffConfig", "main"), { pin: curPin, mgrPin: curMgr, key: (state.staff && state.staff.key) || newId(16) });
    }, pin || mgrPin ? "Ajustes y PIN guardados" : "Ajustes guardados");
  }
});

// ---------- arranque ----------
render();
if (configured) {
  onAuthStateChanged(auth, async (u) => {
    state.unsubs.forEach((f) => f()); state.unsubs = [];
    state.user = u; state.seen = null; state.active.clear(); state.today.clear(); state.tables = [];
    state.secrets = {}; state.tabsOpen = {}; state.keys = {}; state.keysLoaded = false; state.staff = null; state.invoices = null;
    state.role = null;
    if (u && isOwner(u)) state.role = "owner";
    else if (u && u.isAnonymous) {
      // Encargado: entró en /empleados con el PIN de encargado
      const s = await getDoc(doc(db, "staffSessions", u.uid)).catch(() => null);
      if (s && s.exists() && s.data().role === "encargado") { state.role = "manager"; state.mgrName = s.data().name; if (state.tab === "ventas") state.tab = "pedidos"; }
    }
    if (state.role) listen();
    render();
  });
  // Actualiza los minutos transcurridos cada 30 segundos
  setInterval(() => { if (state.user && (state.tab === "pedidos" || state.tab === "mesas")) render(); }, 30000);
}
