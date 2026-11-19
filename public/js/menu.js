// Vista del cliente. Funciona en tres modos según la página:
//  - mesa.html   → cuenta abierta por mesa, rondas separadas por platos, se paga al final.
//  - llevar.html → pedido para llevar en el local, con fila y tiempo estimado; se paga al recoger.
//  - casa.html   → pedido desde casa (domicilio o recoger); se paga antes por transferencia.
import {
  collection, doc, onSnapshot, query, where, writeBatch, setDoc, getDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, configured, $, esc, money, toMillis, local, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG, prepMinutes, estimate, isClosed, newId, showErrorsOnPage, summaryHtml
} from "./common.js";

const showError = showErrorsOnPage();

const MODE = ["mesa", "casa"].includes(document.body.dataset.mode) ? document.body.dataset.mode : "llevar";
const ORDER_KEY = MODE === "casa" ? "comanda.myOrder.casa" : "comanda.myOrder";
const params = new URLSearchParams(location.search);
const tableParam = (params.get("m") || params.get("mesa") || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 10);
// Clave secreta que viene en el QR impreso de la mesa
const keyParam = (params.get("k") || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 40);
if (tableParam && keyParam) local.set("comanda.key." + tableParam, keyParam);
const JOIN_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => { const a = new Uint32Array(6); crypto.getRandomValues(a); return Array.from(a, (n) => JOIN_CHARS[n % JOIN_CHARS.length]).join(""); };

const state = {
  config: { ...DEFAULT_CONFIG },
  products: [],
  queue: [],
  loaded: false,
  sending: false,
  catFilter: "Todo",
  note: "",
  // Carrito: lista de platos; cada plato es { productId: cantidad }
  plates: [{}],
  cur: 0,
  pick: {},
  // Para llevar y desde casa
  customer: local.get("comanda.name") || "",
  myOrderId: local.get(ORDER_KEY),
  myOrder: null,
  phone: local.get("comanda.phone") || "",
  address: local.get("comanda.address") || "",
  delivery: local.get("comanda.delivery") || "domicilio",
  payRef: "",
  checkout: false,
  // Mesa
  table: tableParam,
  tableKey: tableParam ? (keyParam || local.get("comanda.key." + tableParam) || "") : "",
  tableDoc: null,   // estado público de la mesa (abierta / cerrada)
  tab: null,        // la cuenta de este celular (si tiene)
  rounds: [],
  joinCode: "",
  mySession: tableParam ? local.get("comanda.session." + tableParam) : null
};

const cur = () => state.config.currency || "$";
const closed = () => isClosed(state.config);
function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

// ---------- carrito ----------
// Cada plato guarda { "productoId" o "productoId::Carne": cantidad }
const SEP = "::";
const splitKey = (k) => { const i = k.indexOf(SEP); return i < 0 ? [k, ""] : [k.slice(0, i), k.slice(i + SEP.length)]; };
const outOptions = () => new Set((state.config.outOptions || []).map((o) => String(o).toLowerCase()));
function optionsOf(p) {
  const out = outOptions();
  return (Array.isArray(p.options) ? p.options : []).filter((o) => o && !out.has(String(o).toLowerCase()));
}
function hasOptions(p) { return Array.isArray(p.options) && p.options.length > 0; }
function validKey(key) {
  const [id, opt] = splitKey(key);
  const p = state.products.find((x) => x.id === id);
  if (!p || p.available === false) return null;
  if (hasOptions(p) && !optionsOf(p).includes(opt)) return null;
  return { p, opt };
}
function cartItems() {
  const out = [];
  let num = 0;
  state.plates.forEach((plate) => {
    // Los platos vacíos no cuentan: se numeran seguidos (Plato 1, 2, 3…)
    const hasItems = Object.entries(plate).some(([k, q]) => q > 0 && validKey(k));
    if (hasItems) num++;
    const i = num - 1;
    for (const [key, qty] of Object.entries(plate)) {
      const v = validKey(key);
      if (!v || qty <= 0) continue;
      const item = { id: v.p.id, name: v.opt ? `${v.p.name} de ${v.opt.toLowerCase()}` : v.p.name, price: Number(v.p.price) || 0, qty, plate: i + 1 };
      if (v.opt) item.option = v.opt;
      out.push(item);
    }
  });
  return out;
}
const cartUnits = () => cartItems().reduce((s, i) => s + i.qty, 0);
const cartTotal = () => cartItems().reduce((s, i) => s + i.price * i.qty, 0);
function cleanCart() {
  for (const plate of state.plates) {
    for (const key of Object.keys(plate)) if (!validKey(key) || plate[key] <= 0) delete plate[key];
  }
}
// Carne elegida en cada producto (por defecto la primera disponible)
function pickFor(p) {
  const opts = optionsOf(p);
  if (!opts.length) return "";
  if (!opts.includes(state.pick[p.id])) state.pick[p.id] = opts[0];
  return state.pick[p.id];
}

// ---------- piezas de la vista ----------
function statusSteps(status) {
  const steps = ["pendiente", "preparando", "listo"];
  const idx = steps.indexOf(status);
  const done = status === "entregado" || status === "cancelado";
  return `<div class="steps">${steps.map((s, i) => `<span class="step ${i <= idx && !done ? "on" : ""}">${STATUS_LABEL[s]}</span>`).join("")}</div>`;
}

function itemsByPlate(items) {
  const groups = {};
  (items || []).forEach((i) => (groups[i.plate || 1] ||= []).push(i));
  const keys = Object.keys(groups).sort((a, b) => a - b);
  if (keys.length <= 1) return `<ul>${(items || []).map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join("")}</ul>`;
  return keys.map((k) => `<div class="plate-label">Plato ${k}</div><ul>${groups[k].map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join("")}</ul>`).join("");
}

function etaFor(o) {
  return estimate(state.queue, o.id, o.minutes, state.config);
}

const deliveryOn = () => state.config.deliveryOn !== false;

function bankHtml(o) {
  const c = state.config;
  const row = (label, val, copy) => val ? `<div class="bankrow"><span class="label">${label}</span><span class="mono">${esc(val)}</span>${copy ? `<button data-copy="${esc(val)}">Copiar</button>` : ""}</div>` : "";
  if (!c.clabe) return `<p>Escríbenos para darte los datos de pago. El pedido entra a cocina cuando confirmemos tu pago.</p>`;
  return `<div class="bank">
    ${row("Monto", money(o.total, cur()), false)}
    ${row("Banco", c.bank, false)}
    ${row("Titular", c.holder, false)}
    ${row("CLABE", c.clabe, true)}
    ${row("Concepto", "Pedido " + o.code, true)}
  </div>`;
}

function payStep(o) {
  if (o.payRef) return `<div class="full"><h2>Estamos confirmando tu pago</h2>
    <p class="muted" style="margin:4px 0 0">Referencia: ${esc(o.payRef)}. En cuanto lo confirmemos, tu pedido entra a cocina y aquí verás el tiempo estimado.</p></div>`;
  return `<div class="full"><h2>Paga tu pedido por transferencia</h2>
    <p class="muted" style="margin:4px 0 8px">Tu pedido entra a cocina cuando confirmemos el pago.</p>
    ${bankHtml(o)}
    <form id="payForm" class="payform">
      <label class="label" for="payRef">Ya transferí: número de referencia o rastreo</label>
      <input id="payRef" maxlength="60" required value="${esc(state.payRef)}" placeholder="Ej. 0123456 o tu nombre">
      <button class="primary" type="submit">Avisar que ya pagué</button>
    </form></div>`;
}

function takeoutTicket(o) {
  const ready = o.status === "listo";
  const done = o.status === "entregado" || o.status === "cancelado";
  const toHome = o.type === "casa" && o.delivery === "domicilio";
  const q = etaFor(o);
  let main;
  if (o.status === "por_pagar") main = payStep(o);
  else if (ready) main = toHome
    ? `<div class="full"><h2>¡Tu pedido va en camino!</h2><p class="muted" style="margin:4px 0 0">Llega a: ${esc(o.address)}</p></div>`
    : `<div class="full"><h2>¡Tu pedido está listo!</h2><p class="muted" style="margin:4px 0 0">Pasa a recogerlo al mostrador.</p></div>`;
  else if (o.status === "cancelado") main = `<div class="full"><h2>Tu pedido fue cancelado.</h2><p class="muted" style="margin:4px 0 0">Pregunta en el mostrador si tienes dudas.</p></div>`;
  else if (o.status === "entregado") main = `<div class="full"><h2>Pedido entregado. ¡Buen provecho!</h2></div>`;
  else main = `<div><div class="label">Pedidos delante de ti</div><div class="big">${q.ahead}</div></div>
      <div><div class="label">${toHome ? "Sale a domicilio en" : "Tiempo estimado"}</div><div class="big">~${q.minutes} min</div></div>`;
  const payNote = o.paid ? "Pagado" : o.type === "casa" ? "Pago por transferencia" : "Pagas al recoger";
  return `<div class="ticket ${ready ? "ready" : ""}" aria-live="polite">
    <div><div class="label">Tu pedido</div><div class="big">#${esc(o.code)}</div><div class="muted">${esc(o.customer)}</div></div>
    ${main}
    ${o.status === "por_pagar" ? "" : `<div class="full">${statusSteps(o.status)}</div>`}
    <div class="full">${summaryHtml([o.items], cur(), "Tu pedido")}
      <div class="muted" style="margin-top:6px">${payNote}${o.type === "casa" ? (o.delivery === "domicilio" ? " · A domicilio" : " · Pasas a recoger") : ""}</div></div>
    ${done ? `<div class="full"><button data-neworder>Hacer otro pedido</button></div>` : ""}
  </div>`;
}

// ¿Este celular es parte de la cuenta abierta de la mesa?
const inTab = () => !!(state.mySession && state.tab && !state.tab.closed);
// Mesa ocupada por otra cuenta a la que este celular no se ha unido
const tableTaken = () => !inTab() && state.tableDoc && state.tableDoc.status === "abierta";

function tableHeader() {
  const t = state.tab;
  // La cuenta anterior de este celular ya se pagó: avisamos, pero puede unirse a la nueva o abrir otra
  const paidBefore = !!(state.mySession && t && t.closed);
  const paidNote = paidBefore
    ? `<div class="notice">Tu cuenta anterior de esta mesa ya está pagada. ¡Gracias! ${tableTaken() ? "Si alguien de tu mesa ya abrió otra cuenta, escribe su código abajo." : state.tableKey ? "Si quieren pedir algo más, agréguenlo y se abre una cuenta nueva." : "Para pedir otra vez, escanea el QR de la mesa."}
        ${state.rounds.length ? `<details style="margin-top:6px"><summary>Ver lo que pagaron</summary>${summaryHtml(state.rounds.filter((r) => r.status !== "cancelado").map((r) => r.items), cur(), "Cuenta pagada")}</details>` : ""}</div>`
    : "";
  return paidNote + tableHeaderBody(t);
}

function tableHeaderBody(t) {
  if (tableTaken()) {
    return `<form class="ticket" id="joinForm"><div class="full"><h2>Esta mesa ya tiene una cuenta abierta</h2>
      <p class="muted" style="margin:4px 0 8px">Para pedir a la misma cuenta, escribe el <strong>código de mesa</strong> que aparece en el celular de alguien de tu mesa.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="joinCode" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="Ej. K7P2QX" style="flex:1 1 140px;width:auto;text-transform:uppercase;font-family:var(--mono)" value="${esc(state.joinCode)}">
        <button class="primary" type="submit">Unirme</button></div></div></form>`;
  }
  if (!inTab() && !state.tableKey) {
    return `<div class="notice">Para pedir, <strong>escanea el código QR que está en tu mesa</strong>.</div>`;
  }
  if (!inTab()) return "";
  const rounds = state.rounds.filter((r) => r.status !== "cancelado").sort((a, b) => a.createdAt - b.createdAt);
  const total = rounds.reduce((s, r) => s + (Number(r.total) || 0), 0);
  let html = `<div class="ticket"><div><div class="label">Mesa ${esc(state.table)}</div><div class="big">${money(total, cur())}</div>
    <div class="muted">${rounds.length} ${rounds.length === 1 ? "ronda" : "rondas"}</div></div>
    <div><div class="label">Código de mesa</div><div class="big">${esc(t.code)}</div>
    <div class="muted">Compártelo con tu mesa para que pidan desde sus celulares.</div></div>`;
  const active = rounds.filter((r) => r.status === "pendiente" || r.status === "preparando");
  if (active.length) {
    const q = etaFor(active[active.length - 1]);
    html += `<div><div class="label">Tu última ronda llega en</div><div class="big">~${q.minutes} min</div></div>`;
  } else if (rounds.some((r) => r.status === "listo")) {
    html += `<div><div class="label">Estado</div><h2>¡Ya va para tu mesa!</h2></div>`;
  }
  if (rounds.length) {
    html += `<div class="full">${summaryHtml(rounds.map((r) => r.items), cur(), "Resumen de lo que ha pedido la mesa")}</div>`;
    html += `<div class="full"><details><summary class="muted">Ver por ronda</summary>`;
    rounds.forEach((r, i) => {
      html += `<div class="round"><div class="row"><strong>Ronda ${i + 1}</strong><span class="tag">${STATUS_LABEL[r.status] || r.status}</span><span class="price">${money(r.total, cur())}</span></div>${itemsByPlate(r.items)}</div>`;
    });
    html += `</details></div><div class="full" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">`;
    html += t.billRequested ? `<span class="tag">Ya pediste la cuenta. En un momento te atienden.</span>` : `<button data-bill>Pedir la cuenta</button>`;
    html += `</div>`;
  }
  return html + `</div>`;
}

function tablePicker() {
  return `<form class="login" id="tableForm"><h2>¿En qué mesa estás?</h2>
    <label class="label" for="tableNum">Número de mesa</label>
    <input id="tableNum" inputmode="numeric" maxlength="10" required>
    <button class="primary" type="submit">Continuar</button>
    <p class="muted" style="margin:0">Normalmente viene en el código QR de tu mesa.</p></form>`;
}

// ---------- render ----------
function render() {
  const name = state.config.name || "Menú";
  $("shopName").textContent = name;
  document.title = name + ({ mesa: " · Mesa", llevar: " · Para llevar", casa: " · Pedir desde casa" })[MODE];
  $("eyebrow").textContent = MODE === "mesa" ? (state.table ? `Mesa ${state.table} · ordena desde tu celular` : "Pedido en mesa")
    : MODE === "casa" ? (deliveryOn() ? "Pide desde casa · domicilio gratis o recoger" : "Pide desde casa · pasa a recoger") : "Pedido para llevar";
  const app = $("app");
  if (!configured) { app.innerHTML = notConfiguredHtml(); return; }
  if (MODE === "mesa" && !state.table) { app.innerHTML = tablePicker(); $("cartbar").hidden = true; return; }

  let html = "";
  if (closed()) html += `<div class="notice"><strong>Hoy ya no estamos recibiendo pedidos.</strong> ¡Te esperamos mañana!</div>`;
  if (MODE !== "mesa" && state.myOrder) html += takeoutTicket(state.myOrder);
  if (MODE === "casa" && state.checkout && cartUnits() && !closed()) { app.innerHTML = html + checkoutHtml(); $("cartbar").hidden = true; return; }
  if (MODE === "mesa") html += tableHeader();

  if (!state.loaded) { app.innerHTML = html + '<p class="muted">Cargando el menú…</p>'; renderCart(); return; }
  if (!state.products.length) { app.innerHTML = html + '<div class="empty">El menú todavía no tiene productos.</div>'; renderCart(); return; }

  if (MODE === "mesa") {
    html += `<div class="plates" role="tablist" aria-label="Platos">` +
      state.plates.map((p, i) => {
        const n = Object.values(p).reduce((a, b) => a + b, 0);
        return `<button data-plate="${i}" class="${i === state.cur ? "on" : ""}">Plato ${i + 1}${n ? ` · ${n}` : ""}</button>`;
      }).join("") +
      (state.plates.length < 20 ? `<button data-addplate>+ Otro plato</button>` : "") + `</div>
      <p class="muted" style="margin:6px 0 0;font-size:.85rem">Separa tu pedido en platos para servirlo como quieras. Todo va a la misma cuenta de la mesa.</p>`;
  }

  const cats = ["Todo", ...new Set(state.products.map((p) => p.category || "Otros"))];
  html += '<div class="cats">' + cats.map((c) => `<button data-cat="${esc(c)}" class="${c === state.catFilter ? "on" : ""}">${esc(c)}</button>`).join("") + "</div>";

  const groups = {};
  state.products
    .filter((p) => state.catFilter === "Todo" || (p.category || "Otros") === state.catFilter)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((p) => (groups[p.category || "Otros"] ||= []).push(p));
  const plate = state.plates[state.cur];
  const off = closed();
  for (const [cat, items] of Object.entries(groups)) {
    html += `<section class="section"><h2>${esc(cat)}</h2>`;
    for (const p of items) {
      const out = p.available === false;
      const withOpts = hasOptions(p);
      const opts = optionsOf(p);
      const noneLeft = withOpts && !opts.length;
      const opt = pickFor(p);
      const key = opt ? p.id + SEP + opt : p.id;
      const n = plate[key] || 0;
      // Lo que ya lleva este plato de este producto, por carne
      const chosen = withOpts ? Object.entries(plate).filter(([k, q]) => q > 0 && splitKey(k)[0] === p.id).map(([k, q]) => `${q} ${splitKey(k)[1].toLowerCase()}`) : [];
      const canAdd = !out && !off && !noneLeft;
      html += `<div class="item ${out || noneLeft ? "out" : ""}">
        <div><h3>${esc(p.name)}</h3>${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}
          <div class="price" style="margin-top:6px">${money(p.price, cur())}</div>
          ${withOpts && canAdd ? `<div class="opts" role="radiogroup" aria-label="Carne para ${esc(p.name)}">${opts.map((o) => `<button role="radio" aria-checked="${o === opt}" class="${o === opt ? "on" : ""}" data-pick="${esc(p.id)}" data-opt="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}
          ${chosen.length ? `<div class="muted chosen">En este plato: ${esc(chosen.join(", "))}</div>` : ""}</div>
        <div>${out || noneLeft ? '<span class="out-tag">Agotado</span>' : off ? "" :
          `<div class="qty">${n ? `<button aria-label="Quitar ${esc(p.name)}${opt ? " de " + esc(opt) : ""}" data-dec="${esc(key)}">−</button><span class="mono">${n}</span>` : ""}
           <button class="${n ? "" : "primary"}" aria-label="Agregar ${esc(p.name)}${opt ? " de " + esc(opt) : ""}" data-inc="${esc(key)}">+</button></div>`}</div>
      </div>`;
    }
    html += "</section>";
  }
  app.innerHTML = html;
  renderCart();
}

function renderCart() {
  const bar = $("cartbar");
  const units = cartUnits();
  if (!units || closed()) { bar.hidden = true; return; }
  const active = document.activeElement && document.activeElement.id;
  bar.hidden = false;
  if (MODE === "casa") {
    if (state.checkout) { bar.hidden = true; return; }
    bar.innerHTML = `<div class="in"><span class="sum">${units} ${units === 1 ? "pieza" : "piezas"} · ${money(cartTotal(), cur())}</span>
      <button class="primary" data-checkout>Continuar</button></div>`;
    return;
  }
  const label = MODE === "mesa" ? "Enviar a cocina" : "Enviar pedido";
  bar.innerHTML = `<div class="in">
    <span class="sum">${units} ${units === 1 ? "pieza" : "piezas"} · ${money(cartTotal(), cur())}</span>
    ${MODE === "llevar" ? `<input id="custName" placeholder="Tu nombre" autocomplete="given-name" maxlength="60" value="${esc(state.customer)}" aria-label="Tu nombre">` : ""}
    <input id="custNote" placeholder="Nota (sin cebolla, salsa aparte…)" maxlength="200" value="${esc(state.note)}" aria-label="Nota para la cocina">
    <button class="primary" id="placeOrder" ${state.sending ? "disabled" : ""}>${label}</button>
  </div>
  ${MODE === "llevar" ? `<div class="in muted" style="font-size:.82rem;margin-top:6px">Pagas al recoger tu pedido.</div>` : ""}`;
  if (active && $(active)) $(active).focus();
}

// ---------- mesa: abrir o unirse a la cuenta ----------
async function ensureTableSession() {
  if (inTab()) return state.mySession;
  if (tableTaken()) { const e = new Error("taken"); e.code = "taken"; throw e; }
  if (!state.tableKey) { const e = new Error("nokey"); e.code = "nokey"; throw e; }
  const session = newId(24);
  const code = newCode();
  const b = writeBatch(db);
  b.set(doc(db, "tableSecrets", state.table), { session, key: state.tableKey, openedAt: serverTimestamp() });
  b.set(doc(db, "tables", state.table), { status: "abierta", openedAt: serverTimestamp() });
  b.set(doc(db, "tabs", session), { table: state.table, openedAt: serverTimestamp(), code, closed: false, billRequested: false });
  b.set(doc(db, "joins", state.table + "-" + code), { session, table: state.table, createdAt: serverTimestamp() });
  try {
    await b.commit();
  } catch (e) {
    // Otra persona abrió la mesa al mismo tiempo, o el QR es viejo
    const t = await getDoc(doc(db, "tables", state.table)).catch(() => null);
    if (t && t.exists() && t.data().status === "abierta") { const err = new Error("taken"); err.code = "taken"; throw err; }
    const err = new Error("badkey"); err.code = "badkey"; throw err;
  }
  setSession(session);
  return session;
}

function setSession(session) {
  state.mySession = session;
  local.set("comanda.session." + state.table, session);
  watchTab(session);
}

async function joinTable(code) {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 6) { toast("El código tiene 6 letras o números"); return; }
  try {
    const j = await getDoc(doc(db, "joins", state.table + "-" + c));
    if (!j.exists()) { toast("Ese código no es de esta mesa. Revísalo."); return; }
    const t = await getDoc(doc(db, "tabs", j.data().session));
    if (!t.exists() || t.data().closed) { toast("Esa cuenta ya se cerró."); return; }
    state.joinCode = "";
    setSession(j.data().session);
    toast("¡Listo! Ya estás en la cuenta de la mesa");
  } catch (e) { console.error(e); toast("No se pudo revisar el código. Intenta otra vez."); }
}

// ---------- enviar ----------
async function placeOrder() {
  if (closed()) { toast("Hoy ya no estamos recibiendo pedidos"); return; }
  const items = cartItems();
  if (!items.length) { toast("Los productos que elegiste se agotaron"); cleanCart(); render(); return; }
  const name = state.customer.trim();
  if (MODE !== "mesa" && !name) { toast("Escribe tu nombre para poder llamarte"); $("custName")?.focus(); return; }
  const delivery = MODE === "casa" ? (deliveryOn() ? state.delivery : "recoger") : null;
  if (MODE === "casa") {
    if (state.phone.replace(/\D/g, "").length < 7) { toast("Escribe tu teléfono"); $("custPhone")?.focus(); return; }
    if (delivery === "domicilio" && state.address.trim().length < 5) { toast("Escribe tu dirección completa"); $("custAddr")?.focus(); return; }
  }

  state.sending = true; renderCart();
  try {
    const units = items.reduce((s, i) => s + i.qty, 0);
    const ref = doc(collection(db, "orders"));
    const minutes = prepMinutes(units, state.config);
    const order = {
      type: MODE, items, minutes, status: MODE === "casa" ? "por_pagar" : "pendiente", paid: false, createdAt: serverTimestamp(),
      code: ref.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase(),
      total: Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100
    };
    const plates = new Set(items.map((i) => i.plate)).size;
    if (plates > 1) order.plates = plates;
    if (state.note.trim()) order.note = state.note.trim().slice(0, 200);
    if (MODE !== "mesa") order.customer = name.slice(0, 60);
    if (MODE === "casa") {
      order.phone = state.phone.trim().slice(0, 20);
      order.delivery = delivery;
      if (delivery === "domicilio") order.address = state.address.trim().slice(0, 200);
    }
    if (MODE === "mesa") {
      order.table = state.table;
      order.session = await ensureTableSession();
    }
    const batch = writeBatch(db);
    batch.set(ref, order);
    if (MODE === "mesa") {
      // Copia de la ronda para que la mesa vea su cuenta
      const round = { items, total: order.total, status: "pendiente", createdAt: serverTimestamp(), minutes };
      if (order.plates) round.plates = order.plates;
      batch.set(doc(db, "tabs", order.session, "rounds", ref.id), round);
    }
    // Los pedidos desde casa entran a la fila hasta que se confirma el pago
    if (MODE !== "casa") batch.set(doc(db, "queue", ref.id), { status: "pendiente", createdAt: serverTimestamp(), minutes });
    await batch.commit();

    state.plates = [{}]; state.cur = 0; state.note = ""; state.checkout = false;
    if (MODE === "casa") {
      local.set("comanda.phone", state.phone.trim());
      local.set("comanda.delivery", delivery);
      if (delivery === "domicilio") local.set("comanda.address", state.address.trim());
    }
    if (MODE !== "mesa") { local.set("comanda.name", name); watchMyOrder(ref.id); toast(MODE === "casa" ? "Pedido recibido. Ahora paga para que lo preparemos." : "¡Pedido enviado!"); }
    else toast("¡Ronda enviada a cocina!");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    console.error(e);
    const msg = e && e.code === "taken" ? "Esta mesa ya tiene una cuenta abierta. Escribe el código de tu mesa para unirte."
      : e && e.code === "nokey" ? "Escanea el código QR que está en tu mesa para pedir."
      : e && e.code === "badkey" ? "Este QR ya no es válido. Pide al mesero el QR actual de la mesa."
      : closed() ? "Hoy ya no estamos recibiendo pedidos" : "No se pudo enviar. Revisa tu internet e intenta otra vez.";
    toast(msg);
  } finally {
    state.sending = false; render();
  }
}

// ---------- seguimiento ----------
let unsubOrder = null;
function watchMyOrder(id) {
  if (unsubOrder) unsubOrder();
  state.myOrderId = id; local.set(ORDER_KEY, id);
  if (!id) { state.myOrder = null; render(); return; }
  unsubOrder = onSnapshot(doc(db, "orders", id), (s) => {
    state.myOrder = s.exists() ? { id: s.id, ...s.data() } : null;
    if (!s.exists()) local.set(ORDER_KEY, null);
    render();
  }, () => { state.myOrder = null; render(); });
}

let unsubTab = null, unsubRounds = null, tabSession = null;
function watchTab(session) {
  if (session === tabSession) return;
  if (unsubTab) unsubTab();
  if (unsubRounds) unsubRounds();
  tabSession = session; state.tab = null; state.rounds = [];
  if (!session) { unsubTab = unsubRounds = null; render(); return; }
  unsubTab = onSnapshot(doc(db, "tabs", session), (s) => {
    state.tab = s.exists() ? s.data() : null;
    render();
  }, (e) => console.error(e));
  unsubRounds = onSnapshot(collection(db, "tabs", session, "rounds"), (s) => {
    state.rounds = s.docs.map((d) => { const x = d.data({ serverTimestamps: "estimate" }); return { id: d.id, ...x, createdAt: toMillis(x.createdAt) }; });
    render();
  }, (e) => console.error(e));
}

// ---------- eventos ----------
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button"); if (!t) return;
  const d = t.dataset;
  const plate = state.plates[state.cur];
  if (d.cat) { state.catFilter = d.cat; render(); return; }
  if (d.pick) { state.pick[d.pick] = d.opt; render(); return; }
  if (d.inc) { plate[d.inc] = (plate[d.inc] || 0) + 1; render(); return; }
  if (d.dec) { plate[d.dec] = (plate[d.dec] || 0) - 1; if (plate[d.dec] <= 0) delete plate[d.dec]; render(); return; }
  if (d.plate) { state.cur = Number(d.plate); render(); return; }
  if ("addplate" in d) {
    if (state.plates.length >= 20) { toast("Máximo 20 platos por ronda"); return; }
    state.plates.push({});
    state.cur = state.plates.length - 1;
    toast(`Plato ${state.cur + 1}: agrega lo que va en este plato`);
    render(); return;
  }
  if (t.id === "placeOrder" && MODE !== "casa") { placeOrder(); return; }
  if ("checkout" in d) { state.checkout = true; window.scrollTo({ top: 0 }); render(); return; }
  if ("back" in d) { state.checkout = false; render(); return; }
  if (d.delivery) { state.delivery = d.delivery; render(); return; }
  if (d.copy) {
    const v = d.copy;
    Promise.resolve().then(() => navigator.clipboard.writeText(v)).then(() => toast("Copiado"), () => toast(v));
    return;
  }
  if ("neworder" in d) { watchMyOrder(null); return; }
  if ("bill" in d) {
    updateDoc(doc(db, "tabs", state.mySession), { billRequested: true })
      .then(() => toast("Listo, en un momento te traen la cuenta"), () => toast("No se pudo pedir la cuenta. Avísale al mesero."));
  }
});
document.addEventListener("input", (ev) => {
  const id = ev.target.id;
  if (id === "custName") state.customer = ev.target.value;
  if (id === "custNote") state.note = ev.target.value;
  if (id === "custPhone") state.phone = ev.target.value;
  if (id === "custAddr") state.address = ev.target.value;
  if (id === "payRef") state.payRef = ev.target.value;
  if (id === "joinCode") state.joinCode = ev.target.value;
});
document.addEventListener("submit", (ev) => {
  if (ev.target.id === "casaForm") { ev.preventDefault(); placeOrder(); return; }
  if (ev.target.id === "joinForm") { ev.preventDefault(); joinTable(state.joinCode); return; }
  if (ev.target.id === "payForm") {
    ev.preventDefault();
    const ref = state.payRef.trim().slice(0, 60);
    if (!ref || !state.myOrderId) return;
    updateDoc(doc(db, "orders", state.myOrderId), { payRef: ref })
      .then(() => toast("Gracias. Estamos confirmando tu pago."), () => toast("No se pudo enviar. Intenta otra vez."));
    return;
  }
  if (ev.target.id !== "tableForm") return;
  ev.preventDefault();
  const v = $("tableNum").value.replace(/[^0-9A-Za-z]/g, "").slice(0, 10);
  if (!v) return;
  location.search = "?m=" + encodeURIComponent(v);
});

// ---------- arranque ----------
function start() {
  render();
  if (!configured) return;
  if (MODE === "mesa" && !state.table) return;
  const timer = setTimeout(() => { if (!state.loaded) notice("El menú tarda en cargar. Revisa tu conexión a internet. (sin respuesta de la base de datos)"); }, 10000);
  const onErr = (e) => { console.error(e); notice("No se pudo leer el menú: " + (e && (e.code || e.message) || e) + ". Recarga la página."); };
  // Si algo falla al dibujar, que se vea el error en lugar de quedarse cargando
  const safe = (fn) => (...a) => { try { fn(...a); } catch (e) { console.error(e); showError(e && e.message || e); } };

  onSnapshot(doc(db, "config", "shop"), safe((s) => {
    if (s.exists()) state.config = { ...DEFAULT_CONFIG, ...s.data() };
    cleanCart();
    render();
  }), onErr);

  onSnapshot(collection(db, "products"), safe((s) => {
    state.products = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    cleanCart();
    state.loaded = true; clearTimeout(timer); notice("");
    render();
  }), onErr);

  onSnapshot(query(collection(db, "queue"), where("status", "in", ["pendiente", "preparando"])), safe((s) => {
    state.queue = s.docs.map((d) => { const x = d.data({ serverTimestamps: "estimate" }); return { id: d.id, minutes: x.minutes, createdAt: toMillis(x.createdAt) }; });
    render();
  }), onErr);

  if (MODE !== "mesa" && state.myOrderId) watchMyOrder(state.myOrderId);
  if (MODE === "mesa") {
    onSnapshot(doc(db, "tables", state.table), safe((s) => {
      state.tableDoc = s.exists() ? s.data() : null;
      render();
    }), onErr);
    if (state.mySession) watchTab(state.mySession);
  }
}
start();
