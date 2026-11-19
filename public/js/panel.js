// Panel del administrador: pedidos y tiempos, mesas (cuentas abiertas), productos, ajustes, QR
// y botón para cerrar los pedidos del día.
import {
  collection, doc, onSnapshot, query, where, orderBy, writeBatch, updateDoc, addDoc, deleteDoc, setDoc,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  db, auth, configured, OWNER_EMAILS, $, esc, money, toMillis, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG, isClosed, endOfToday, prepMinutes, newId, summaryHtml
} from "./common.js";

const state = {
  user: null, tab: "pedidos", config: { ...DEFAULT_CONFIG }, products: [], tables: [], secrets: {}, tabsOpen: {}, keys: {},
  active: new Map(), today: new Map(), editId: null, resetForms: false,
  seen: null, seenRefs: new Set(), fresh: new Set(), soundOn: false, unsubs: []
};
const cur = () => state.config.currency || "$";
const isOwner = (u) => !!u && OWNER_EMAILS.map((e) => e.toLowerCase()).includes(String(u.email || "").toLowerCase());
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
  state.unsubs.push(onSnapshot(collection(db, "tableKeys"), (s) => {
    state.keys = Object.fromEntries(s.docs.map((d) => [d.id, d.data().key]));
    state.keysLoaded = true;
    if (state.tab === "qr") { ensureKeys(); render(); }
  }, onErr));
  state.unsubs.push(onSnapshot(query(collection(db, "tabs"), where("closed", "==", false)), (s) => {
    const before = new Set(Object.values(state.tabsOpen).filter((t) => t.billRequested).map((t) => t.id));
    state.tabsOpen = Object.fromEntries(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    const asked = Object.values(state.tabsOpen).filter((t) => t.billRequested && !before.has(t.id));
    if (state.seen && asked.length) { toast(`Mesa ${asked[0].table} pidió la cuenta`); beep(); }
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
  if (!isOwner(state.user)) {
    app.innerHTML = `<div class="empty"><h2>Esta cuenta no tiene acceso</h2><p>${esc(state.user.email)} no está en la lista de dueños de <code>firebase-config.js</code>.</p></div>`;
    return;
  }
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
  if (o.type === "mesa") return `<span class="tag">Mesa ${esc(o.table)}</span>`;
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
    <div class="stat"><span class="label">Ventas hoy</span><b>${money(sales, cur())}</b></div>
    <div class="stat"><span class="label">Tiempo promedio real</span><b>${avg == null ? "—" : avg + " min"}</b></div>
    <div class="stat"><span class="label">Espera para nuevos</span><b>~${waitNew} min</b></div>
  </div>${payQueueHtml()}<div class="board">`;
  const NEXT = {
    pendiente: () => ["preparando", "Empezar a preparar"],
    preparando: () => ["listo", "Marcar listo"],
    listo: (o) => ["entregado", o.type === "mesa" ? "Servido en mesa" : o.type === "casa" ? (o.delivery === "domicilio" ? "Entregado en domicilio" : "Entregado") : "Entregado y cobrado"]
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
    html += `<div class="order"><div class="row"><h3>Mesa ${esc(tab.table)}${perTable[tab.table] > 1 ? ` <span class="tag">${perTable[tab.table]} cuentas</span>` : ""}</h3>${tab.billRequested ? '<span class="tag bill">Pidió la cuenta</span>' : ""}</div>
      <div class="row"><span class="muted">Cuenta <span class="mono">${esc(tab.code)}</span> · abierta ${tab.openedAt ? fmtTime(toMillis(tab.openedAt)) : ""} · ${rounds.length} ${rounds.length === 1 ? "ronda" : "rondas"}${pending ? ` · ${pending} en cocina` : ""}</span><span class="price">${money(total, cur())}</span></div>
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
    <label>Banco (para pedidos desde casa)<input id="sBank" maxlength="40" value="${esc(c.bank)}" placeholder="BBVA, Banorte…"></label>
    <label>Titular de la cuenta<input id="sHolder" maxlength="60" value="${esc(c.holder)}"></label>
    <label>CLABE (18 dígitos)<input id="sClabe" maxlength="22" inputmode="numeric" value="${esc(c.clabe)}"></label>
    <div><button class="primary" type="submit">Guardar ajustes</button></div>
  </form>
  <p class="muted">Cada pedido tarda entre el mínimo y el máximo según cuántas piezas lleva (hasta 3 piezas = mínimo; +1 minuto por cada 2 piezas más).
  El tiempo que ve el cliente suma los pedidos que van antes que el suyo, repartidos entre los que la cocina prepara a la vez.</p>`;
}

function qrHtml() {
  const base = location.origin;
  const tables = Math.min(200, Math.max(0, Number(state.config.tables) || 0));
  let cards = `<div class="qrcard"><div class="qr" data-url="${esc(base + "/llevar")}"></div><strong>Para llevar</strong><span>Escanea para pedir</span></div>
    <div class="qrcard"><div class="qr" data-url="${esc(base + "/casa")}"></div><strong>Pide desde casa</strong><span>${esc(base.replace(/^https?:\/\//, "") + "/casa")}</span></div>`;
  for (let i = 1; i <= tables; i++) {
    const key = state.keys[String(i)];
    cards += key
      ? `<div class="qrcard"><div class="qr" data-url="${esc(base + "/mesa?m=" + i + "&k=" + key)}"></div><strong>Mesa ${i}</strong><span>Escanea para ordenar</span></div>`
      : `<div class="qrcard"><strong>Mesa ${i}</strong><span>Generando código…</span></div>`;
  }
  return `<div class="no-print" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <button class="primary" id="sheetBtn">Descargar códigos (imagen)</button>
      <button id="printBtn">Imprimir</button>
      <span class="muted">Estos son los códigos definitivos. Cada QR de mesa tiene una clave: solo quien lo escanea en la mesa puede abrir una cuenta.</span></div>
    <div id="sheetOut" class="no-print"></div>
    <div class="qrgrid">${cards}</div>`;
}

// Arma una hoja (tamaño carta/A4) con todos los QR en una imagen que se puede guardar e imprimir
function buildSheet() {
  const cards = [...document.querySelectorAll(".qrcard")].filter((c) => c.querySelector(".qr canvas, .qr img"));
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
  const n = Math.min(200, Math.max(0, Number(state.config.tables) || 0));
  const missing = [];
  // Solo crea claves para mesas que no tengan; las existentes nunca se cambian
  for (let i = 1; i <= n; i++) if (!state.keys[String(i)]) missing.push(String(i));
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
  }, `Mesa ${tab.table} (cuenta ${tab.code}) cobrada y cerrada`);
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
      bank: $("sBank").value.trim(),
      holder: $("sHolder").value.trim(),
      clabe: $("sClabe").value.replace(/\s/g, "")
    };
    if (body.clabe && !/^\d{18}$/.test(body.clabe)) { toast("La CLABE debe tener 18 dígitos"); return; }
    write(() => setDoc(doc(db, "config", "shop"), body), "Ajustes guardados");
  }
});

// ---------- arranque ----------
render();
if (configured) {
  onAuthStateChanged(auth, (u) => {
    state.unsubs.forEach((f) => f()); state.unsubs = [];
    state.user = u; state.seen = null; state.active.clear(); state.today.clear(); state.tables = [];
    state.secrets = {}; state.tabsOpen = {}; state.keys = {}; state.keysLoaded = false;
    if (u && isOwner(u)) listen();
    render();
  });
  // Actualiza los minutos transcurridos cada 30 segundos
  setInterval(() => { if (state.user && (state.tab === "pedidos" || state.tab === "mesas")) render(); }, 30000);
}
