// Panel del administrador: pedidos y tiempos, mesas (cuentas abiertas), productos, ajustes, QR
// y botón para cerrar los pedidos del día.
import {
  collection, doc, onSnapshot, query, where, orderBy, writeBatch, updateDoc, addDoc, deleteDoc, setDoc, getDoc, getDocs, deleteField, limit, increment,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  db, auth, configured, OWNER_EMAILS, $, esc, money, toMillis, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG, isClosed, endOfToday, prepMinutes, newId, summaryHtml, tableLabel, tableIds, BAR_ID, platesHtml, PLATFORMS, tipPickerHtml, tipAmount, normPhone, DAY_NAMES
} from "./common.js";

const state = {
  user: null, tab: "pedidos", tips: {}, config: { ...DEFAULT_CONFIG }, products: [], tables: [], secrets: {}, tabsOpen: {}, keys: {},
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
    const calls = Object.values(state.tabsOpen).filter((t) => t.call && t.call.reason).map((t) => t.id + toMillis(t.call.at));
    const newCall = calls.find((c) => !(state.seenCalls || new Set()).has(c));
    if (state.seenCalls && newCall) { toast("Una mesa está llamando al mesero"); beep(); }
    state.seenCalls = new Set(calls);
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
  if (!state.resetForms) document.querySelectorAll("#app form input").forEach((i) => { if (i.id && i.type !== "checkbox" && i.type !== "file") keep[i.id] = i.value; });
  state.resetForms = false;

  const pend = [...state.active.values()].filter((o) => o.status === "pendiente" || o.status === "por_pagar").length;
  const bills = Object.values(state.tabsOpen).filter((t) => t.billRequested).length;
  const openTables = Object.keys(state.tabsOpen).length;
  const tabs = [
    ["pedidos", `Pedidos${pend ? ` (${pend})` : ""}`],
    ["mesas", `Mesas${openTables ? ` (${openTables})` : ""}${bills ? " · cuenta" : ""}`],
    ...(isMgr() ? [] : [["ventas", "Ventas"], ["corte", "Corte de caja"], ["reportes", "Reportes"]]), ["facturas", `Facturas${(state.invoices || []).filter((i) => !i.done).length ? ` (${(state.invoices || []).filter((i) => !i.done).length})` : ""}`],
    ["productos", "Productos"], ["promos", "Promociones"], ["ajustes", "Ajustes"], ["qr", "Códigos QR"]
  ];
  const closed = isClosed(state.config);
  let html = `<div class="closed-bar no-print ${closed ? "off" : ""}">
    <strong>${closed ? "Cerrado por hoy: no se reciben pedidos nuevos" : "Recibiendo pedidos"}</strong>
    <span style="display:flex;gap:6px;flex-wrap:wrap">
      <button id="deliveryBtn" class="toggle ${state.config.deliveryOn !== false ? "on" : "off"}">Domicilio: ${state.config.deliveryOn !== false ? "activo" : "apagado"}</button>
      <button id="dayBtn" class="${closed ? "primary" : "danger"}">${closed ? "Abrir pedidos" : "Cerrar pedidos por hoy"}</button>
    </span>
  </div>`;
  const calling = Object.values(state.tabsOpen).filter((t) => t.call && t.call.reason);
  if (calling.length) html += `<div class="callbar">${calling.map((t) => `<div class="order"><div class="row"><strong>${esc(tableLabel(t.table))}${t.name ? " · " + esc(t.name) : ""}</strong><span class="tag bill">Llama al mesero: ${esc(t.call.reason)}</span><button data-callok="${esc(t.id)}">Atendido</button></div></div>`).join("")}</div>`;
  html += '<div class="tabs">' + tabs.map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? "on" : ""}">${l}</button>`).join("") + "</div>";
  if (state.tab === "pedidos") html += ordersHtml();
  if (state.tab === "mesas") html += tablesHtml();
  if (state.tab === "productos") html += productsHtml();
  if (state.tab === "ajustes") html += settingsHtml();
  if (state.tab === "qr") html += qrHtml();
  if (state.tab === "ventas" && !isMgr()) html += salesHtml();
  if (state.tab === "facturas") html += invoicesHtml();
  if (state.tab === "promos") html += promosHtml();
  if (state.tab === "corte" && !isMgr()) html += corteHtml();
  if (state.tab === "reportes" && !isMgr()) html += reportsHtml();
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

function itemsByPlate(items) { return platesHtml(items); }

function whoLabel(o) {
  if (o.type === "plataforma") return `<span class="tag plat">${esc(PLATFORMS[o.platform] || o.platform)} #${esc(o.extRef)}</span> <strong>${esc(o.customer || "")}</strong>`;
  if (o.type === "mesa") return `<span class="tag">${esc(tableLabel(o.table))}</span>`;
  if (o.type === "casa") return `<span class="tag casa">${o.delivery === "domicilio" ? "Domicilio" : "Casa · recoge"}</span> <strong>${esc(o.customer)}</strong>`;
  return `<span class="tag">Para llevar</span> <strong>${esc(o.customer)}</strong>`;
}

function casaInfo(o) {
  const sched = o.scheduledFor ? `<span class="tag pop">Para las ${esc(o.scheduledFor)}</span> ` : "";
  const loy = loyaltyBadge(o.phone);
  if (o.type !== "casa") return sched || loy ? `<div>${sched}${loy}</div>` : "";
  return `<div class="muted" style="font-size:.88rem">${sched}Tel. <span class="mono">${esc(o.phone)}</span>${o.delivery === "domicilio" ? `<br>${esc(o.address)}${o.zone ? ` · <strong>${esc(o.zone)}</strong>` : ""}${o.deliveryFee ? ` · envío ${money(o.deliveryFee, cur())}` : ""}` : ""} ${loy}</div>`;
}

// ---------- lealtad ----------
const loyOn = () => !!(state.config.loyalty && state.config.loyalty.on);
const loyEvery = () => Math.max(2, Number(state.config.loyalty && state.config.loyalty.every) || 10);
function loyaltyBadge(phone) {
  const p = normPhone(phone);
  if (!loyOn() || !p) return "";
  state.loy ||= {};
  if (!(p in state.loy)) { state.loy[p] = null; getDoc(doc(db, "loyalty", p)).then((s) => { state.loy[p] = s.exists() ? s.data() : { count: 0 }; render(); }).catch(() => {}); }
  const l = state.loy[p]; if (!l) return "";
  const n = Number(l.count) || 0;
  return n >= loyEvery()
    ? `<span class="tag pop">Tiene premio (${n} visitas)</span> <button data-redeem="${p}">Canjear premio</button>`
    : `<span class="tag">Lealtad ${n}/${loyEvery()}</span>`;
}
// Suma una visita a la tarjeta de lealtad del cliente (dentro del mismo batch del cobro/entrega)
function loyaltyBump(b, phone) {
  const p = normPhone(phone);
  if (!loyOn() || !p) return;
  b.set(doc(db, "loyalty", p), { count: increment(1), updatedAt: serverTimestamp() }, { merge: true });
  if (state.loy && state.loy[p]) state.loy[p] = { ...state.loy[p], count: (Number(state.loy[p].count) || 0) + 1 };
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
      ${summaryHtml(rounds.map((r) => r.items), cur(), "Resumen de la cuenta", rounds.reduce((a, r) => a + (Number(r.discount) || 0), 0))}
      <details><summary class="muted">Ver por ronda</summary>${rounds.map((r, i) => `<div class="round"><div class="row"><strong>Ronda ${i + 1}</strong><span class="muted">${STATUS_LABEL[r.status]}</span><span class="price">${money(r.total, cur())}</span></div>${itemsByPlate(r.items)}</div>`).join("")}</details>
      ${tab.phone ? `<div>${loyaltyBadge(tab.phone)}</div>` : ""}
      ${tipPickerHtml(tab.id, total, state.tips[tab.id], cur())}
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
    <label>Extras con precio (nombre:precio, separados por coma)<input id="pExtras" maxlength="300" placeholder="Extra queso:10, Aguacate:15" value="${esc((e?.extras || []).map((x) => x.name + ":" + x.price).join(", "))}"></label>
    <label>Foto (opcional)<input id="pPhoto" type="file" accept="image/*"></label>
    <label class="check"><input id="pPopular" type="checkbox" ${e?.popular ? "checked" : ""}> Marcar como "Lo más pedido"</label>
    ${e?.photo ? `<div class="check" style="display:flex;gap:8px;align-items:center"><img src="${esc(e.photo)}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px"><label class="check"><input id="pPhotoDel" type="checkbox"> Quitar foto</label></div>` : ""}
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
        <div class="muted" style="font-size:.82rem">${esc(p.category || "Otros")}${(p.options || []).length ? " · " + esc(p.options.join(", ")) : ""}${byMeat ? ' · <span class="late">agotado por la carne</span>' : ""}${(p.extras || []).length ? " · extras: " + esc(p.extras.map((x) => x.name).join(", ")) : ""}${p.photo ? " · con foto" : ""}${p.popular ? ' · <span class="tag pop">Lo más pedido</span>' : ""}</div></div>
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
    <fieldset style="grid-column:1/-1;border:1px solid var(--line);border-radius:10px;padding:10px"><legend class="label">Horario (si lo dejas vacío, siempre abierto)</legend>
      <div class="hours">${DAY_NAMES.map((n, i) => { const h = (c.hours || {})[String(i)] || {}; return `<div class="hrow"><span>${n}</span>
        <input id="h${i}o" type="time" value="${esc(h.open || "")}"> a <input id="h${i}c" type="time" value="${esc(h.close || "")}">
        <label class="check"><input id="h${i}x" type="checkbox" ${h.off ? "checked" : ""}> Cerrado</label></div>`; }).join("")}</div></fieldset>
    <label style="grid-column:1/-1">Zonas de domicilio (una por línea: Colonia | costo de envío | minutos extra)
      <textarea id="sZones" rows="4" placeholder="Centro | 0 | 10&#10;San Juan | 20 | 20">${esc((c.zones || []).map((z) => `${z.name} | ${z.fee || 0} | ${z.minutes || 0}`).join("\n"))}</textarea></label>
    <label class="check"><input id="sLoyOn" type="checkbox" ${c.loyalty && c.loyalty.on ? "checked" : ""}> Programa de lealtad (por teléfono)</label>
    <label>Visitas para el premio<input id="sLoyEvery" type="number" min="2" max="50" value="${esc((c.loyalty && c.loyalty.every) || 10)}"></label>
    <label>Premio<input id="sLoyReward" maxlength="80" value="${esc((c.loyalty && c.loyalty.reward) || "Una orden de tacos gratis")}"></label>
    <fieldset style="grid-column:1/-1;border:1px solid var(--line);border-radius:10px;padding:10px"><legend class="label">Página web (tacos-josue.web.app)</legend>
      <div class="form" style="border:0;padding:0;margin:0;background:none">
      ${[["wTag", "tagline", "Frase principal", "Tacos al pastor, bistec y más. Hechos al momento."], ["wAbout", "about", "Sobre nosotros (opcional)", "Desde 2015 en…"],
         ["wAddr", "address", "Dirección", "Calle, número, colonia, ciudad"], ["wMaps", "mapsUrl", "Enlace de Google Maps (opcional)", "https://maps.app.goo.gl/…"],
         ["wWa", "whatsapp", "WhatsApp (10 dígitos)", "5512345678"], ["wTel", "phone", "Teléfono", "55 1234 5678"],
         ["wIg", "instagram", "Instagram (enlace)", "https://instagram.com/tacosjosue"], ["wFb", "facebook", "Facebook (enlace)", "https://facebook.com/…"],
         ["wTt", "tiktok", "TikTok (enlace)", "https://tiktok.com/@…"]]
        .map(([id, k, l, ph]) => `<label>${l}<input id="${id}" maxlength="300" placeholder="${esc(ph)}" value="${esc((c.site || {})[k] || "")}"></label>`).join("")}
      </div></fieldset>
    <label>Fondo de caja (efectivo con el que abres)<input id="sFloat" type="number" min="0" step="1" value="${esc(c.cashFloat ?? "")}" placeholder="Ej. 500"></label>
    <label>Enlace para reseñas en Google (opcional)<input id="sGoogle" maxlength="300" placeholder="https://g.page/r/..." value="${esc(c.googleReviewUrl || "")}"></label>
    <label>Notas rápidas en la comida (separadas por coma)<input id="sNotes" maxlength="200" value="${esc((c.quickNotes && c.quickNotes.length ? c.quickNotes : ["Con todo", "Sin cebolla", "Sin cilantro", "Sin salsa"]).join(", "))}"></label>
    <label>Categoría que se sugiere antes de enviar<input id="sUpsell" maxlength="40" value="${esc(c.upsellCategory || "Bebidas")}"></label>
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

// ---------- datos por periodo (corte y reportes, solo dueño) ----------
async function loadRange(from) {
  const [o, t, r] = await Promise.all([
    getDocs(query(collection(db, "orders"), where("createdAt", ">=", Timestamp.fromDate(from)), orderBy("createdAt", "asc"))),
    getDocs(query(collection(db, "tabs"), where("closedAt", ">=", Timestamp.fromDate(from)))),
    getDocs(query(collection(db, "reviews"), where("createdAt", ">=", Timestamp.fromDate(from))))
  ]);
  return { orders: o.docs.map(toOrder), tabs: t.docs.map((d) => ({ id: d.id, ...d.data() })), reviews: r.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

// ---------- corte de caja ----------
async function refreshCorte() {
  const last = await getDocs(query(collection(db, "cortes"), orderBy("at", "desc"), limit(10)));
  state.cortes = last.docs.map((d) => ({ id: d.id, ...d.data() }));
  const from = state.cortes.length ? toMillis(state.cortes[0].at) : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  state.corteFrom = from;
  state.corteData = await loadRange(new Date(from));
  render();
}
function corteTotals(data) {
  const by = { efectivo: 0, tarjeta: 0, transferencia: 0, uber: 0, didi: 0 };
  for (const o of data.orders) {
    if (o.status === "cancelado" || o.status === "por_pagar") continue;
    const paid = o.paid || o.type === "plataforma" || (o.type === "llevar" && o.status === "entregado");
    if (!paid) continue;
    const m = o.type === "plataforma" ? o.platform : o.payMethod || (o.type === "llevar" ? "efectivo" : "");
    if (m in by) by[m] += Number(o.total) || 0;
  }
  const tips = { efectivo: 0, tarjeta: 0 }, tipsBy = {};
  for (const t of data.tabs) if (t.closed && t.tip) {
    if (t.payMethod in tips) tips[t.payMethod] += Number(t.tip) || 0;
    tipsBy[t.tipBy || "?"] = (tipsBy[t.tipBy || "?"] || 0) + (Number(t.tip) || 0);
  }
  return { by, tips, tipsBy };
}
function corteHtml() {
  if (!state.corteData) { if (!state.corteLoading) { state.corteLoading = true; refreshCorte().finally(() => (state.corteLoading = false)); } return '<p class="muted">Cargando…</p>'; }
  const { by, tips, tipsBy } = corteTotals(state.corteData);
  const fondo = Number(state.config.cashFloat) || 0;
  const expected = fondo + by.efectivo + tips.efectivo;
  const counted = state.corteCounted;
  const diff = counted === "" || counted == null ? null : Number(counted) - expected;
  const row = (l, v, strong) => `<div class="prow"><span>${strong ? `<strong>${l}</strong>` : l}</span><span class="price">${money(v, cur())}</span></div>`;
  let html = `<p class="muted">Desde ${new Date(state.corteFrom).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} (${state.cortes.length ? "último corte" : "inicio del día"}) hasta ahora. <button data-cortereload>Actualizar</button></p>
    <div class="plist">
      ${row("Fondo de caja (Ajustes)", fondo)}
      ${row("Ventas en efectivo", by.efectivo)}
      ${row("Propinas en efectivo", tips.efectivo)}
      ${row("Efectivo que debe haber", expected, true)}
    </div>
    <form class="form" id="corteForm" style="margin-top:12px">
      <label>Efectivo contado<input id="corteCounted" type="number" step="0.5" min="0" inputmode="decimal" value="${esc(counted ?? "")}"></label>
      <label>Notas (opcional)<input id="corteNote" maxlength="200"></label>
      <div>${diff == null ? "" : `<div class="${diff === 0 ? "promo-line" : "late"}" style="margin-bottom:8px">${diff === 0 ? "Cuadra exacto" : diff > 0 ? `Sobran ${money(diff, cur())}` : `Faltan ${money(-diff, cur())}`}</div>`}
      <button class="primary" type="submit">Hacer corte</button></div></form>
    <h3>Otros cobros (no son efectivo)</h3><div class="plist">
      ${row("Tarjeta", by.tarjeta)}${row("Propinas con tarjeta", tips.tarjeta)}${row("Transferencia", by.transferencia)}${row("Uber Eats", by.uber)}${row("DiDi Food", by.didi)}</div>
    ${Object.keys(tipsBy).length ? `<h3>Propinas por persona</h3><div class="plist">${Object.entries(tipsBy).map(([k, v]) => row(esc(k), v)).join("")}</div>` : ""}`;
  if (state.cortes.length) html += `<h3>Cortes anteriores</h3><div class="plist">${state.cortes.map((c) => `<div class="prow"><div>${new Date(toMillis(c.at)).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}${c.note ? ` · <span class="muted">${esc(c.note)}</span>` : ""}</div>
      <div class="acts"><span class="mono">Esperado ${money(c.expected, cur())} · contado ${money(c.counted, cur())}</span><span class="${c.diff === 0 ? "promo-line" : "late"}">${c.diff === 0 ? "cuadra" : (c.diff > 0 ? "+" : "−") + money(Math.abs(c.diff), cur())}</span></div></div>`).join("")}</div>`;
  return html;
}

// ---------- reportes ----------
async function refreshReports() {
  const days = state.repDays || 7;
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (days - 1));
  state.repData = await loadRange(from);
  render();
}
function bars(rows, fmt) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<div class="bars">${rows.map(([l, v]) => `<div class="bar"><span class="bl">${esc(l)}</span><span class="bt"><span style="width:${Math.round((v / max) * 100)}%"></span></span><span class="bv mono">${fmt(v)}</span></div>`).join("")}</div>`;
}
function reportsHtml() {
  const days = state.repDays || 7;
  let html = `<div class="tabs">${[[1, "Hoy"], [7, "7 días"], [30, "30 días"]].map(([d, l]) => `<button data-repdays="${d}" class="${days === d ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (!state.repData) { if (!state.repLoading) { state.repLoading = true; refreshReports().finally(() => (state.repLoading = false)); } return html + '<p class="muted">Cargando…</p>'; }
  const orders = state.repData.orders.filter((o) => o.status !== "cancelado" && o.status !== "por_pagar");
  const sales = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const tickets = new Set(orders.map((o) => (o.type === "mesa" ? "t" + o.session : o.id))).size;
  const prod = {}, meat = {}, hours = Array(24).fill(0), chan = {}, emp = {};
  for (const o of orders) {
    for (const i of o.items || []) {
      const base = i.option ? i.name.split(" de ")[0] : i.name.split(" + ")[0].split(" (")[0];
      prod[base] = prod[base] || { q: 0, m: 0 }; prod[base].q += i.qty; prod[base].m += i.qty * i.price;
      if (i.option) meat[i.option] = (meat[i.option] || 0) + i.qty;
    }
    hours[new Date(o.createdAt).getHours()]++;
    const c = o.type === "plataforma" ? (o.platform === "uber" ? "Uber Eats" : "DiDi Food") : { mesa: "Mesa / barra", llevar: "Para llevar", casa: "Desde casa" }[o.type] || o.type;
    chan[c] = (chan[c] || 0) + (Number(o.total) || 0);
    if (o.takenBy) emp[o.takenBy] = (emp[o.takenBy] || 0) + 1;
  }
  const revs = state.repData.reviews;
  const avg = revs.length ? revs.reduce((s, r) => s + r.stars, 0) / revs.length : 0;
  const tipsBy = corteTotals(state.repData).tipsBy;
  const top = Object.entries(prod).sort((a, b) => b[1].q - a[1].q).slice(0, 10);
  html += `<div class="stats">
    <div class="stat"><span class="label">Ventas</span><b>${money(sales, cur())}</b></div>
    <div class="stat"><span class="label">Tickets</span><b>${tickets}</b></div>
    <div class="stat"><span class="label">Ticket promedio</span><b>${money(tickets ? sales / tickets : 0, cur())}</b></div>
    <div class="stat"><span class="label">Calificación</span><b>${revs.length ? avg.toFixed(1) + " ★" : "—"}</b><span class="muted" style="font-size:.8rem">${revs.length} reseñas</span></div></div>
    <div class="board">
      <div class="col"><h3>Lo más vendido (piezas)</h3>${top.length ? bars(top.map(([k, v]) => [k, v.q]), (v) => v) : '<p class="muted">Sin ventas</p>'}</div>
      <div class="col"><h3>Carnes</h3>${Object.keys(meat).length ? bars(Object.entries(meat).sort((a, b) => b[1] - a[1]), (v) => v) : '<p class="muted">Sin datos</p>'}</div>
      <div class="col"><h3>Ventas por canal</h3>${Object.keys(chan).length ? bars(Object.entries(chan).sort((a, b) => b[1] - a[1]), (v) => money(v, cur())) : '<p class="muted">Sin datos</p>'}</div>
    </div>
    <h3>Horas pico (pedidos por hora)</h3>${bars(hours.map((v, h) => [`${String(h).padStart(2, "0")}:00`, v]).filter(([, v]) => v > 0), (v) => v)}
    <div class="board" style="margin-top:14px">
      <div class="col"><h3>Pedidos tomados por empleado</h3>${Object.keys(emp).length ? bars(Object.entries(emp).sort((a, b) => b[1] - a[1]), (v) => v) : '<p class="muted">Sin datos</p>'}</div>
      <div class="col"><h3>Propinas por persona</h3>${Object.keys(tipsBy).length ? bars(Object.entries(tipsBy), (v) => money(v, cur())) : '<p class="muted">Sin propinas</p>'}</div>
    </div>
    <h3>Reseñas recientes</h3>${revs.length ? `<div class="plist">${[...revs].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)).slice(0, 20).map((r) => `<div class="prow"><span>${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)} ${esc(r.comment || "")}</span><span class="muted">${new Date(toMillis(r.createdAt)).toLocaleDateString()}</span></div>`).join("")}</div>` : '<p class="muted">Todavía no hay reseñas.</p>'}`;
  return html;
}

// ---------- promociones ----------
const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
function promosHtml() {
  const promos = state.config.promos || [];
  const cats = [...new Set(state.products.map((p) => p.category || "Otros"))];
  const targetLabel = (t) => { const [k, v] = String(t).split(/:(.*)/s); if (k === "cat") return "Categoría " + v; const p = state.products.find((x) => x.id === v); return p ? p.name : "(producto borrado)"; };
  let html = `<form class="form" id="promoForm">
    <h3 style="grid-column:1/-1;margin:0">Nueva promoción</h3>
    <label>Nombre que ve el cliente<input id="prName" required maxlength="60" placeholder="Martes 2×1 en tacos"></label>
    <label>Tipo<select id="prKind"><option value="2x1">2×1 (de cada 2, uno gratis)</option><option value="pct">% de descuento</option></select></label>
    <label>¿En qué?<select id="prTarget">${cats.map((c) => `<option value="cat:${esc(c)}">Toda la categoría: ${esc(c)}</option>`).join("")}${state.products.map((p) => `<option value="prod:${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
    <label>% de descuento (si aplica)<input id="prPct" type="number" min="1" max="100" placeholder="10"></label>
    <label>Desde (hora)<input id="prFrom" type="time"></label>
    <label>Hasta (hora)<input id="prTo" type="time"></label>
    <div style="grid-column:1/-1" class="opts">${DAYS.map((d, i) => `<label class="check"><input type="checkbox" class="prDay" value="${i}"> ${d}</label>`).join("")}</div>
    <p class="muted" style="grid-column:1/-1;margin:0">Si no marcas días aplica todos los días; si no pones horas, todo el día. Para un combo (ej. 5 tacos + refresco), créalo como producto en Productos.</p>
    <div style="grid-column:1/-1"><button class="primary" type="submit">Agregar promoción</button></div></form>`;
  if (!promos.length) return html + '<div class="empty">No hay promociones todavía.</div>';
  html += '<div class="plist">';
  promos.forEach((p, i) => {
    html += `<div class="prow ${p.active === false ? "voided" : ""}"><div><strong>${esc(p.name)}</strong> <span class="tag">${p.kind === "2x1" ? "2×1" : (p.pct || 0) + "%"}</span>
      <div class="muted" style="font-size:.85rem">${esc(targetLabel(p.target))} · ${p.days && p.days.length ? p.days.map((d) => DAYS[d]).join(", ") : "Todos los días"} · ${p.from || p.to ? `${esc(p.from || "00:00")}–${esc(p.to || "24:00")}` : "todo el día"}</div></div>
      <div class="acts"><button class="toggle ${p.active === false ? "off" : "on"}" data-promotoggle="${i}">${p.active === false ? "Pausada" : "Activa"}</button>
        <button class="danger" data-promodel="${i}">Borrar</button></div></div>`;
  });
  return html + "</div>";
}
function savePromos(promos, msg) { return write(() => setDoc(doc(db, "config", "shop"), { ...state.config, promos }), msg); }

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

// Reduce la foto a 480 px (JPEG) para guardarla junto con el producto sin pesar mucho
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 480, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.75, out = c.toDataURL("image/jpeg", q);
      while (out.length > 180000 && q > 0.35) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la foto")); };
    img.src = url;
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
    if (status === "entregado" && o && o.type === "plataforma") { patch.paid = true; patch.payMethod = o.platform; }
    if (status === "entregado" && o && (o.type === "llevar" || o.type === "casa")) loyaltyBump(b, o.phone);
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
    const tip = tipAmount(total, state.tips[tabId]);
    b.set(doc(db, "tabs", tabId), { closed: true, billRequested: false, total, payMethod: method, closedAt: serverTimestamp(), tip, tipBy: isMgr() ? (state.mgrName || "Encargado") : "Dueño", call: deleteField() }, { merge: true });
    if (tab.phone && rounds.length) loyaltyBump(b, tab.phone);
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
  if (d.promotoggle) { const promos = [...(state.config.promos || [])]; const i = Number(d.promotoggle); promos[i] = { ...promos[i], active: promos[i].active === false }; savePromos(promos, promos[i].active ? "Promoción activada" : "Promoción pausada"); return; }
  if (d.promodel) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Borrar? Toca otra vez"; return; }
    const promos = [...(state.config.promos || [])]; promos.splice(Number(d.promodel), 1); savePromos(promos, "Promoción borrada"); return;
  }
  if (d.repdays) { state.repDays = Number(d.repdays); state.repData = null; render(); return; }
  if ("cortereload" in d) { state.corteData = null; render(); return; }
  if (d.redeem) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Ya se lo diste? Toca otra vez"; return; }
    const p = d.redeem;
    write(async () => { await setDoc(doc(db, "loyalty", p), { count: increment(-loyEvery()), redeemedAt: serverTimestamp() }, { merge: true }); state.loy[p] = null; delete state.loy[p]; }, "Premio canjeado").then(() => render());
    return;
  }
  if (d.callok) { write(() => updateDoc(doc(db, "tabs", d.callok), { call: deleteField() })); return; }
  if (d.tip) { state.tips[d.tip] = { pct: Number(d.pct) }; render(); return; }
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

document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.dataset && t.dataset.tipcustom) { state.tips[t.dataset.tipcustom] = { custom: t.value }; }
  if (t.id === "corteCounted") { state.corteCounted = t.value; }
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
  if (id === "corteForm") {
    const { by, tips } = corteTotals(state.corteData);
    const fondo = Number(state.config.cashFloat) || 0;
    const expected = Math.round((fondo + by.efectivo + tips.efectivo) * 100) / 100;
    const counted = Number($("corteCounted").value);
    if (!$("corteCounted").value || isNaN(counted)) { toast("Escribe el efectivo contado"); return; }
    state.resetForms = true;
    write(async () => {
      await addDoc(collection(db, "cortes"), { at: serverTimestamp(), from: Timestamp.fromMillis(state.corteFrom), expected, counted, diff: Math.round((counted - expected) * 100) / 100,
        byMethod: by, tips, note: $("corteNote").value.trim().slice(0, 200), by: "Dueño" });
      state.corteCounted = ""; state.corteData = null;
    }, "Corte de caja guardado").then(() => render());
    return;
  }
  if (id === "promoForm") {
    const kind = $("prKind").value, pct = Number($("prPct").value) || 0;
    if (kind === "pct" && (pct <= 0 || pct > 100)) { toast("Pon el % de descuento"); return; }
    const promo = { id: newId(8), name: $("prName").value.trim().slice(0, 60), kind, target: $("prTarget").value, pct: kind === "pct" ? pct : 0,
      days: [...document.querySelectorAll(".prDay:checked")].map((x) => Number(x.value)), from: $("prFrom").value, to: $("prTo").value, active: true };
    if (!promo.name) return;
    state.resetForms = true;
    savePromos([...(state.config.promos || []), promo], "Promoción agregada");
    return;
  }
  if (id === "pform") {
    const body = {
      name: $("pName").value.trim(), price: Math.max(0, Number($("pPrice").value) || 0),
      category: $("pCat").value.trim() || "Otros", description: $("pDesc").value.trim(),
      options: [...new Set($("pOpts").value.split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 30),
      // "Extra queso:10, Aguacate:15" -> [{name, price}]
      extras: $("pExtras").value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 15).map((x) => {
        const i = x.lastIndexOf(":");
        return i < 0 ? { name: x.replace(/[|+]/g, " ").trim(), price: 0 } : { name: x.slice(0, i).replace(/[|+]/g, " ").trim(), price: Math.max(0, Number(x.slice(i + 1)) || 0) };
      }).filter((x) => x.name),
      popular: $("pPopular").checked
    };
    if (!body.name) return;
    const file = $("pPhoto").files && $("pPhoto").files[0];
    const removePhoto = $("pPhotoDel") && $("pPhotoDel").checked;
    state.resetForms = true;
    const editId = state.editId; state.editId = null;
    write(async () => {
      if (file) body.photo = await resizePhoto(file);
      else if (removePhoto) body.photo = "";
      if (editId) await updateDoc(doc(db, "products", editId), body);
      else await addDoc(collection(db, "products"), { ...body, available: true, order: Date.now() });
    }, editId ? "Producto actualizado" : "Producto agregado");
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
      quickNotes: $("sNotes").value.split(",").map((x) => x.replace(/[|+]/g, " ").trim()).filter(Boolean).slice(0, 12),
      upsellCategory: $("sUpsell").value.trim() || "Bebidas",
      cashFloat: Math.max(0, Number($("sFloat").value) || 0),
      site: (() => {
        const m = { wTag: "tagline", wAbout: "about", wAddr: "address", wMaps: "mapsUrl", wWa: "whatsapp", wTel: "phone", wIg: "instagram", wFb: "facebook", wTt: "tiktok" };
        const out = {};
        for (const [id, k] of Object.entries(m)) {
          const v = $(id).value.trim().slice(0, 300);
          if (["mapsUrl", "instagram", "facebook", "tiktok"].includes(k) && v && !/^https:\/\//.test(v)) continue; // solo enlaces https
          out[k] = v;
        }
        return out;
      })(),
      hours: (() => {
        const out = {}; let any = false;
        for (let i = 0; i < 7; i++) {
          const o = $("h" + i + "o").value, cl = $("h" + i + "c").value, off = $("h" + i + "x").checked;
          if (o || cl || off) any = true;
          out[String(i)] = { open: o, close: cl, off };
        }
        return any ? out : null;
      })(),
      zones: $("sZones").value.split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0])
        .slice(0, 40).map(([name, fee, minutes]) => ({ name: name.slice(0, 60), fee: Math.max(0, Number(fee) || 0), minutes: Math.max(0, Number(minutes) || 0) })),
      loyalty: { on: $("sLoyOn").checked, every: Math.min(50, Math.max(2, Number($("sLoyEvery").value) || 10)), reward: $("sLoyReward").value.trim().slice(0, 80) || "Un premio" },
      googleReviewUrl: /^https:\/\//.test($("sGoogle").value.trim()) ? $("sGoogle").value.trim() : "",
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
