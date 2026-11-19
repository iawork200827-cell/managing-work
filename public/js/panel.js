// Panel del dueño: pedidos, productos (disponible / agotado), ajustes y códigos QR.
import {
  collection, doc, onSnapshot, query, where, orderBy, writeBatch, updateDoc, addDoc, deleteDoc, setDoc, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  db, auth, configured, OWNER_EMAILS, $, esc, money, toMillis, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG
} from "./common.js";

const state = {
  user: null, tab: "pedidos", config: { ...DEFAULT_CONFIG }, products: [],
  active: new Map(), today: new Map(), editId: null, resetForms: false,
  seen: null, fresh: new Set(), soundOn: false, unsubs: []
};
const cur = () => state.config.currency || "$";
const isOwner = (u) => !!u && OWNER_EMAILS.map((e) => e.toLowerCase()).includes(String(u.email || "").toLowerCase());

function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

// ---------- sonido de pedido nuevo ----------
let audio = null;
function beep() {
  if (!state.soundOn || !audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = "sine"; o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
  g.gain.setValueAtTime(0.0001, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.3, audio.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.5);
  o.start(); o.stop(audio.currentTime + 0.5);
}

// ---------- datos ----------
function allOrders() {
  const m = new Map([...state.today, ...state.active]);
  return [...m.values()];
}

function listen() {
  const onErr = (e) => { console.error(e); notice("No se pudieron leer los datos. Revisa que tu correo esté en firestore.rules y firebase-config.js."); };
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const toOrder = (d) => { const x = d.data({ serverTimestamps: "estimate" }); return { id: d.id, ...x, createdAt: toMillis(x.createdAt) }; };

  state.unsubs.push(onSnapshot(doc(db, "config", "shop"), (s) => {
    if (s.exists()) state.config = { ...DEFAULT_CONFIG, ...s.data() };
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(collection(db, "products"), (s) => {
    state.products = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
  state.unsubs.push(onSnapshot(query(collection(db, "orders"), where("status", "in", ["pendiente", "preparando", "listo"])), (s) => {
    state.active = new Map(s.docs.map((d) => [d.id, toOrder(d)]));
    // Avisar de pedidos nuevos (después de la primera carga)
    const ids = new Set([...state.active.values()].filter((o) => o.status === "pendiente").map((o) => o.id));
    if (state.seen) {
      const nuevos = [...ids].filter((id) => !state.seen.has(id));
      if (nuevos.length) {
        nuevos.forEach((id) => state.fresh.add(id));
        toast(nuevos.length === 1 ? "Nuevo pedido" : `${nuevos.length} pedidos nuevos`);
        beep();
        document.title = "(Nuevo) Panel del dueño";
      }
    }
    state.seen = ids;
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

  const tabs = [["pedidos", "Pedidos"], ["productos", "Productos"], ["ajustes", "Ajustes"], ["qr", "Códigos QR"]];
  const pend = [...state.active.values()].filter((o) => o.status === "pendiente").length;
  let html = '<div class="tabs">' + tabs.map(([k, l]) =>
    `<button data-tab="${k}" class="${state.tab === k ? "on" : ""}">${l}${k === "pedidos" && pend ? ` (${pend})` : ""}</button>`).join("") + "</div>";
  if (state.tab === "pedidos") html += ordersHtml();
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

function ordersHtml() {
  const orders = allOrders();
  const todays = [...state.today.values()].filter((o) => o.status !== "cancelado");
  const sales = todays.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const inLine = orders.filter((o) => o.status === "pendiente" || o.status === "preparando").length;
  const per = Number(state.config.minutesPerOrder) || 5;
  let html = `<div class="stats">
    <div class="stat"><span class="label">En fila</span><b>${inLine}</b></div>
    <div class="stat"><span class="label">Órdenes hoy</span><b>${todays.length}</b></div>
    <div class="stat"><span class="label">Ventas hoy</span><b>${money(sales, cur())}</b></div>
    <div class="stat"><span class="label">Espera para nuevos</span><b>~${(inLine + 1) * per} min</b></div>
  </div><div class="board">`;
  const NEXT = { pendiente: ["preparando", "Empezar a preparar"], preparando: ["listo", "Marcar lista"], listo: ["entregado", "Entregada"] };
  for (const s of ["pendiente", "preparando", "listo"]) {
    const list = orders.filter((o) => o.status === s).sort((a, b) => a.createdAt - b.createdAt);
    html += `<div class="col"><div class="col-head ${s}"><h3>${STATUS_LABEL[s]}</h3><span class="mono muted">${list.length}</span></div>`;
    if (!list.length) html += `<div class="empty">${s === "pendiente" ? "Aquí aparecen los pedidos nuevos." : "Sin pedidos"}</div>`;
    for (const o of list) {
      const mins = Math.max(0, Math.round((Date.now() - o.createdAt) / 60000));
      const [to, label] = NEXT[s];
      html += `<div class="order ${state.fresh.has(o.id) ? "new" : ""}">
        <div class="row"><span class="mono" style="font-weight:700">#${esc(o.code)}</span>
          ${o.table ? `<span class="tag">Mesa ${esc(o.table)}</span>` : ""}
          <span class="muted mono">hace ${mins} min</span></div>
        <div class="row"><strong>${esc(o.customer)}</strong><span class="price">${money(o.total, cur())}</span></div>
        <ul>${(o.items || []).map((i) => `<li>${Number(i.qty) || 0} × ${esc(i.name)}</li>`).join("")}</ul>
        ${o.note ? `<div class="notice" style="margin:0">Nota: ${esc(o.note)}</div>` : ""}
        <div class="acts"><button class="primary" data-advance="${esc(o.id)}" data-to="${to}">${label}</button>
          ${s !== "listo" ? `<button class="danger" data-cancel="${esc(o.id)}">Cancelar</button>` : ""}</div>
      </div>`;
    }
    html += "</div>";
  }
  html += "</div>";
  const doneToday = [...state.today.values()].filter((o) => o.status === "entregado" || o.status === "cancelado").sort((a, b) => b.createdAt - a.createdAt);
  if (doneToday.length) {
    html += `<details style="margin-top:20px"><summary><strong>Historial de hoy (${doneToday.length})</strong></summary><div class="plist" style="margin-top:10px">`;
    for (const o of doneToday) {
      html += `<div class="prow"><div><span class="mono">#${esc(o.code)}</span> · ${esc(o.customer)} · <span class="muted">${new Date(o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
        <div class="price ${o.status === "cancelado" ? "muted" : ""}">${o.status === "cancelado" ? "Cancelado" : money(o.total, cur())}</div></div>`;
    }
    html += "</div></details>";
  }
  return html;
}

function productsHtml() {
  const e = state.editId ? state.products.find((p) => p.id === state.editId) : null;
  let html = `<form class="form" id="pform">
    <label>Nombre<input id="pName" required maxlength="80" value="${esc(e?.name)}"></label>
    <label>Precio<input id="pPrice" type="number" step="0.01" min="0" required value="${e ? esc(e.price) : ""}"></label>
    <label>Categoría<input id="pCat" list="catlist" maxlength="40" placeholder="Platillos, Bebidas…" value="${esc(e?.category)}"></label>
    <label>Descripción<input id="pDesc" maxlength="160" value="${esc(e?.description)}"></label>
    <datalist id="catlist">${[...new Set(state.products.map((p) => p.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="primary" type="submit">${e ? "Guardar cambios" : "Agregar producto"}</button>
      ${e ? '<button type="button" data-canceledit>Cancelar</button>' : ""}</div>
  </form>`;
  if (!state.products.length) {
    return html + `<div class="empty"><p>Todavía no tienes productos. Agrégalos con el formulario de arriba.</p>
      <button data-sample>Cargar menú de ejemplo</button></div>`;
  }
  const out = state.products.filter((p) => p.available === false).length;
  html += `<p class="muted" style="margin:0 0 10px">${state.products.length} productos · ${out} agotados. Toca <strong>Disponible / Agotado</strong> para bloquear un producto al instante.</p><div class="plist">`;
  const sorted = [...state.products].sort((a, b) => (a.category || "").localeCompare(b.category || "") || (a.order ?? 0) - (b.order ?? 0));
  for (const p of sorted) {
    const on = p.available !== false;
    html += `<div class="prow"><div><strong>${esc(p.name)}</strong> <span class="price muted">${money(p.price, cur())}</span>
        <div class="muted" style="font-size:.82rem">${esc(p.category || "Otros")}</div></div>
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
    <label>Minutos promedio por orden<input id="sMin" type="number" min="1" max="120" value="${esc(c.minutesPerOrder)}"></label>
    <label>Símbolo de moneda<input id="sCur" maxlength="4" value="${esc(c.currency)}"></label>
    <label class="check"><input id="sTables" type="checkbox" ${c.useTables ? "checked" : ""}> Llevo las órdenes a la mesa (pedir número de mesa)</label>
    <label>Número de mesas<input id="sTableCount" type="number" min="1" max="200" value="${esc(c.tables)}"></label>
    <div><button class="primary" type="submit">Guardar ajustes</button></div>
  </form>
  <p class="muted">El tiempo estimado que ve cada cliente es: (personas delante + 1) × minutos promedio por orden.</p>`;
}

function qrHtml() {
  const base = location.origin + "/";
  const tables = state.config.useTables ? Math.min(200, Math.max(1, Number(state.config.tables) || 1)) : 0;
  let cards = `<div class="qrcard"><div class="qr" data-url="${esc(base)}"></div><strong>${esc(state.config.name)}</strong><span>Escanea para ver el menú y ordenar</span></div>`;
  for (let i = 1; i <= tables; i++) {
    const url = base + "?mesa=" + i;
    cards += `<div class="qrcard"><div class="qr" data-url="${esc(url)}"></div><strong>Mesa ${i}</strong><span>Escanea para ordenar</span></div>`;
  }
  return `<div class="no-print" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <button class="primary" id="printBtn">Imprimir códigos</button>
      <span class="muted">Enlace del menú: <code>${esc(base)}</code></span></div>
    ${state.config.useTables ? "" : '<p class="muted no-print">¿Llevas las órdenes a la mesa? Actívalo en Ajustes y aquí aparecerá un código por mesa.</p>'}
    <div class="qrgrid">${cards}</div>`;
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
  return write(async () => {
    const b = writeBatch(db);
    b.update(doc(db, "orders", id), { status });
    if (status === "entregado" || status === "cancelado") b.delete(doc(db, "queue", id));
    else b.update(doc(db, "queue", id), { status });
    await b.commit();
    state.fresh.delete(id);
  }, status === "cancelado" ? "Pedido cancelado" : null);
}

const SAMPLE = [
  ["Tacos al pastor (3)", 75, "Platillos"], ["Quesadilla", 60, "Platillos"], ["Torta de milanesa", 90, "Platillos"],
  ["Agua de horchata", 35, "Bebidas"], ["Refresco", 30, "Bebidas"], ["Flan", 45, "Postres"]
];

// ---------- eventos ----------
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button"); if (!t) return;
  const d = t.dataset;
  if (d.tab) { state.tab = d.tab; state.resetForms = true; document.title = "Panel del dueño"; render(); return; }
  if (d.advance) { setStatus(d.advance, d.to); return; }
  if (d.cancel) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Seguro? Toca otra vez"; return; }
    setStatus(d.cancel, "cancelado"); return;
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
  if ("sample" in d) {
    write(async () => {
      const b = writeBatch(db);
      SAMPLE.forEach(([name, price, category], i) => b.set(doc(collection(db, "products")), { name, price, category, description: "Ejemplo", available: true, order: i }));
      await b.commit();
    }, "Menú de ejemplo cargado");
    return;
  }
  if (t.id === "printBtn") { window.print(); return; }
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
      category: $("pCat").value.trim() || "Otros", description: $("pDesc").value.trim()
    };
    if (!body.name) return;
    state.resetForms = true;
    if (state.editId) { const pid = state.editId; state.editId = null; write(() => updateDoc(doc(db, "products", pid), body), "Producto actualizado"); }
    else write(() => addDoc(collection(db, "products"), { ...body, available: true, order: Date.now() }), "Producto agregado");
    render();
  }
  if (id === "sform") {
    const body = {
      name: $("sName").value.trim() || "Tacos Josué",
      minutesPerOrder: Math.min(120, Math.max(1, Number($("sMin").value) || 5)),
      currency: $("sCur").value.trim() || "$",
      useTables: $("sTables").checked,
      tables: Math.min(200, Math.max(1, Number($("sTableCount").value) || 1))
    };
    write(() => setDoc(doc(db, "config", "shop"), body), "Ajustes guardados");
  }
});

// ---------- arranque ----------
render();
if (configured) {
  onAuthStateChanged(auth, (u) => {
    state.unsubs.forEach((f) => f()); state.unsubs = [];
    state.user = u; state.seen = null; state.active.clear(); state.today.clear();
    if (u && isOwner(u)) listen();
    render();
  });
  // Actualiza "hace X min" cada minuto
  setInterval(() => { if (state.user && state.tab === "pedidos") render(); }, 60000);
}
