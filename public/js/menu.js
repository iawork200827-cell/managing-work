// Vista del cliente. Funciona en tres modos según la página:
//  - mesa.html   → cuenta abierta por mesa, rondas separadas por platos, se paga al final.
//  - llevar.html → pedido para llevar en el local, con fila y tiempo estimado; se paga al recoger.
//  - casa.html   → pedido desde casa (domicilio o recoger); se paga antes por transferencia.
import {
  collection, doc, onSnapshot, query, where, writeBatch, setDoc, getDoc, updateDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, configured, $, esc, money, toMillis, local, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG, prepMinutes, estimate, isClosed, newId, showErrorsOnPage, summaryHtml, tableLabel, tableIds, BAR_ID, platesHtml
} from "./common.js";
import {
  buildItems, cleanPlates, validKey as vKey, isOut as isOutP, totals, productCard, selectionFor, handleSelectClick, promoLabels
} from "./cart.js";

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
  toGo: [],   // toGo[i] = el plato i es para llevar
  cur: 0,
  pick: {},
  sel: {},          // carne, extras y notas escogidos por producto
  upsell: false,    // mostrando la sugerencia de bebida
  upsellDone: false,
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
  tab: null,        // la cuenta de este celular (si tiene)
  rounds: [],
  joinCode: "",
  tabName: local.get("comanda.name") || "",
  invoiceOpen: false,
  inv: { rfc: "", razon: "", email: "", cp: "", regimen: "", uso: "G03 - Gastos en general" },
  mySession: tableParam ? local.get("comanda.session." + tableParam) : null
};

const cur = () => state.config.currency || "$";
const closed = () => isClosed(state.config);
function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

// ---------- carrito (lógica compartida en cart.js) ----------
const isOut = (p) => isOutP(p, state.config);
const cartItems = () => buildItems(state.plates, state.toGo, state.products, state.config, MODE === "mesa");
const cartUnits = () => cartItems().reduce((s, i) => s + i.qty, 0);
const cartTotals = () => totals(cartItems(), state.products, state.config);
const cartTotal = () => cartTotals().total;
const cleanCart = () => cleanPlates(state.plates, state.products, state.config);
// Categoría que se sugiere antes de enviar ("¿Le agregas una bebida?")
const upsellCat = () => state.config.upsellCategory || "Bebidas";
function upsellOptions() {
  const items = cartItems();
  const has = items.some((i) => { const p = state.products.find((x) => x.id === i.id); return p && (p.category || "Otros") === upsellCat(); });
  if (has) return [];
  return state.products.filter((p) => (p.category || "Otros") === upsellCat() && !isOut(p)).slice(0, 4);
}
function upsellHtml() {
  // Una vez abierta la sugerencia se queda visible (aunque ya agregaran una bebida) para poder enviar
  const list = state.products.filter((p) => (p.category || "Otros") === upsellCat() && !isOut(p)).slice(0, 4);
  if (!list.length) return "";
  const plate = state.plates[state.cur];
  return `<div class="upsell"><strong>¿Le agregas algo de tomar?</strong>
    <div class="opts">${list.map((p) => { const key = p.id + "|||"; const n = plate[key] || 0; return `<button data-inc="${esc(key)}">${esc(p.name)} ${money(p.price, cur())}${n ? ` · ${n}` : ""}</button>`; }).join("")}</div>
    <div style="margin-top:8px"><button class="primary" data-upsellsend>${MODE === "casa" ? "Continuar" : "Enviar así"}</button></div></div>`;
}
function totalsHtml() {
  const t = cartTotals();
  if (!t.discount) return "";
  return `<div class="promo-line">${t.discounts.map((d) => `${esc(d.name)}: −${money(d.amount, cur())}`).join(" · ")}</div>`;
}

// ---------- piezas de la vista ----------
function statusSteps(status) {
  const steps = ["pendiente", "preparando", "listo"];
  const idx = steps.indexOf(status);
  const done = status === "entregado" || status === "cancelado";
  return `<div class="steps">${steps.map((s, i) => `<span class="step ${i <= idx && !done ? "on" : ""}">${STATUS_LABEL[s]}</span>`).join("")}</div>`;
}

function itemsByPlate(items) { return platesHtml(items); }

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
    <div class="full">${summaryHtml([o.items], cur(), "Tu pedido", Number(o.discount) || 0)}
      <div class="muted" style="margin-top:6px">${payNote}${o.type === "casa" ? (o.delivery === "domicilio" ? " · A domicilio" : " · Pasas a recoger") : ""}</div></div>
    ${o.status !== "por_pagar" && o.status !== "cancelado" ? `<div class="full">${invoiceHtml(o.id)}</div>` : ""}
    ${done ? `<div class="full"><button data-neworder>Hacer otro pedido</button></div>` : ""}
  </div>`;
}

// ¿Este celular es parte de una cuenta abierta de la mesa?
const inTab = () => !!(state.mySession && state.tab && !state.tab.closed);

function tableHeader() {
  const t = state.tab;
  // La cuenta anterior de este celular ya se pagó
  const paidBefore = !!(state.mySession && t && t.closed);
  const paidNote = paidBefore
    ? `<div class="notice">Tu cuenta anterior de esta mesa ya está pagada. ¡Gracias!
        ${state.rounds.length ? `<details style="margin-top:6px"><summary>Ver lo que pagaron</summary>${summaryHtml(state.rounds.filter((r) => r.status !== "cancelado").map((r) => r.items), cur(), "Cuenta pagada")}</details>` : ""}</div>`
    : "";
  return paidNote + (inTab() ? tabTicket(t) : chooseTab());
}

// Este celular todavía no está en una cuenta: unirse a una con código o abrir una nueva
function chooseTab() {
  return `<div class="ticket">
    <form class="full" id="joinForm"><h2>Pedir en la ${esc(tableLabel(state.table))}</h2>
      <p class="muted" style="margin:4px 0 8px">¿Alguien de tu mesa ya abrió una cuenta? Escribe su <strong>código de mesa</strong> para pedir en la misma cuenta.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="joinCode" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="Ej. K7P2QX" style="flex:1 1 140px;width:auto;text-transform:uppercase;font-family:var(--mono)" value="${esc(state.joinCode)}">
        <button class="primary" type="submit">Unirme</button></div>
    </form>
    <div class="full" style="border-top:1px solid var(--line);padding-top:12px">
      ${state.tableKey
        ? `<p class="muted" style="margin:0 0 8px">¿Es la primera cuenta de la mesa o quieren <strong>pagar aparte</strong>? Abre una cuenta nueva y comparte su código.</p>
           <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="tabName" maxlength="40" autocomplete="name" placeholder="Tu nombre (opcional)" style="flex:1 1 160px;width:auto" value="${esc(state.tabName)}">
           <button data-newtab>Abrir cuenta nueva</button></div>`
        : `<p class="muted" style="margin:0">Para abrir una cuenta nueva, <strong>escanea el código QR que está en tu mesa</strong>.</p>`}
    </div></div>`;
}

// ---------- factura ----------
const REGIMENES = ["601 - General de Ley Personas Morales", "603 - Personas Morales con Fines no Lucrativos", "605 - Sueldos y Salarios",
  "606 - Arrendamiento", "612 - Personas Físicas con Actividades Empresariales y Profesionales", "616 - Sin obligaciones fiscales",
  "621 - Incorporación Fiscal", "626 - Régimen Simplificado de Confianza"];
const USOS = ["G03 - Gastos en general", "G01 - Adquisición de mercancías", "S01 - Sin efectos fiscales", "CP01 - Pagos"];
const invoiceKey = (ref) => "comanda.factura." + ref;

function invoiceHtml(ref) {
  if (local.get(invoiceKey(ref))) return `<div class="notice" style="margin:0">Ya pediste factura de esta cuenta. Te llegará al correo que nos diste.</div>`;
  if (!state.invoiceOpen) return `<button data-invoiceopen>Pedir factura</button>`;
  const i = state.inv;
  return `<form id="invForm" class="form" style="margin:0;grid-column:1/-1">
    <h3 style="grid-column:1/-1;margin:0">Datos para tu factura</h3>
    <label>RFC<input id="invRfc" required maxlength="13" autocapitalize="characters" style="text-transform:uppercase" value="${esc(i.rfc)}"></label>
    <label>Nombre o razón social<input id="invRazon" required maxlength="150" value="${esc(i.razon)}"></label>
    <label>Correo<input id="invEmail" required type="email" maxlength="120" value="${esc(i.email)}"></label>
    <label>Código postal fiscal<input id="invCp" required inputmode="numeric" maxlength="5" value="${esc(i.cp)}"></label>
    <label>Régimen fiscal<select id="invRegimen" required><option value="">Elige…</option>${REGIMENES.map((r) => `<option ${r === i.regimen ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
    <label>Uso del CFDI<select id="invUso">${USOS.map((u) => `<option ${u === i.uso ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
    <div style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap"><button class="primary" type="submit">Enviar datos</button><button type="button" data-invoiceclose>Cancelar</button></div>
  </form>`;
}

async function sendInvoice(ref, kind, total, code) {
  const i = state.inv;
  const rfc = i.rfc.trim().toUpperCase();
  if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) { toast("Revisa el RFC (12 o 13 caracteres)"); $("invRfc")?.focus(); return; }
  if (!/^\d{5}$/.test(i.cp.trim())) { toast("El código postal tiene 5 números"); $("invCp")?.focus(); return; }
  if (!i.regimen) { toast("Elige tu régimen fiscal"); return; }
  try {
    const data = { ref, kind, code: code || "", rfc, razon: i.razon.trim().slice(0, 150), email: i.email.trim().slice(0, 120), cp: i.cp.trim(),
      regimen: i.regimen, uso: i.uso, total: Number(total) || 0, createdAt: serverTimestamp(), done: false };
    if (kind === "cuenta") data.table = state.table;
    await addDoc(collection(db, "invoices"), data);
    local.set(invoiceKey(ref), "1");
    state.invoiceOpen = false;
    toast("Listo, recibimos tus datos para la factura");
    render();
  } catch (e) { console.error(e); toast("No se pudo enviar. Revisa los datos e intenta otra vez."); }
}

function tabTicket(t) {
  const rounds = state.rounds.filter((r) => r.status !== "cancelado").sort((a, b) => a.createdAt - b.createdAt);
  const total = rounds.reduce((s, r) => s + (Number(r.total) || 0), 0);
  let html = `<div class="ticket"><div><div class="label">${esc(tableLabel(state.table))} · tu cuenta</div><div class="big">${money(total, cur())}</div>
    <div class="muted">${rounds.length} ${rounds.length === 1 ? "ronda" : "rondas"}</div></div>
    <div><div class="label">Código de la cuenta</div><div class="big">${esc(t.code)}</div>
    <div class="muted">Compártelo con quien vaya a pedir en esta misma cuenta.</div></div>`;
  const active = rounds.filter((r) => r.status === "pendiente" || r.status === "preparando");
  if (active.length) {
    const q = etaFor(active[active.length - 1]);
    html += `<div><div class="label">Tu última ronda llega en</div><div class="big">~${q.minutes} min</div></div>`;
  } else if (rounds.some((r) => r.status === "listo")) {
    html += `<div><div class="label">Estado</div><h2>¡Ya va para tu mesa!</h2></div>`;
  }
  if (rounds.length) {
    html += `<div class="full">${summaryHtml(rounds.map((r) => r.items), cur(), "Resumen de lo que han pedido en esta cuenta", rounds.reduce((a, r) => a + (Number(r.discount) || 0), 0))}</div>`;
    html += `<div class="full"><details><summary class="muted">Ver por ronda</summary>`;
    rounds.forEach((r, i) => {
      html += `<div class="round"><div class="row"><strong>Ronda ${i + 1}</strong><span class="tag">${STATUS_LABEL[r.status] || r.status}</span><span class="price">${money(r.total, cur())}</span></div>${itemsByPlate(r.items)}</div>`;
    });
    html += `</details></div>`;
  }
  html += `<div class="full" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">`;
  if (rounds.length) html += t.billRequested ? `<span class="tag">Ya pediste la cuenta. En un momento te atienden.</span>` : `<button data-bill>Pedir la cuenta</button>`;
  html += `<button data-leavetab>Pedir en una cuenta aparte</button></div>`;
  if (rounds.length) html += `<div class="full">${invoiceHtml(state.mySession)}</div>`;
  return html + `</div>`;
}

function checkoutHtml() {
  const items = cartItems();
  const canDeliver = deliveryOn();
  const delivery = canDeliver ? state.delivery : "recoger";
  return `<section class="checkout">
    <button data-back>← Volver al menú</button>
    <h2 style="margin-top:12px">Tu pedido</h2>
    ${itemsByPlate(items)}
    ${totalsHtml()}
    <div class="price">Total: ${money(cartTotal(), cur())}${delivery === "domicilio" ? ' <span class="muted">· envío gratis</span>' : ""}</div>
    <form id="casaForm" class="form" style="margin-top:14px">
      <label>Tu nombre<input id="custName" required maxlength="60" autocomplete="name" value="${esc(state.customer)}"></label>
      <label>Teléfono<input id="custPhone" required type="tel" inputmode="tel" maxlength="20" autocomplete="tel" value="${esc(state.phone)}"></label>
      <div class="opts" role="radiogroup" aria-label="Entrega" style="grid-column:1/-1">
        ${canDeliver ? `<button type="button" role="radio" aria-checked="${delivery === "domicilio"}" class="${delivery === "domicilio" ? "on" : ""}" data-delivery="domicilio">A domicilio (gratis)</button>` : ""}
        <button type="button" role="radio" aria-checked="${delivery === "recoger"}" class="${delivery === "recoger" ? "on" : ""}" data-delivery="recoger">Paso a recoger</button>
      </div>
      ${canDeliver ? "" : `<p class="muted" style="grid-column:1/-1;margin:0">Hoy no tenemos servicio a domicilio. Puedes pedir y pasar a recoger.</p>`}
      ${delivery === "domicilio" ? `<label style="grid-column:1/-1">Dirección completa (calle, número, colonia, referencias)<input id="custAddr" required maxlength="200" autocomplete="street-address" value="${esc(state.address)}"></label>` : ""}
      <label style="grid-column:1/-1">Nota (opcional)<input id="custNote" maxlength="200" value="${esc(state.note)}" placeholder="Sin cebolla, salsa aparte…"></label>
      <p class="muted" style="grid-column:1/-1;margin:0">Pagas por transferencia antes de que preparemos tu pedido. Al enviarlo te mostramos los datos.</p>
      <div style="grid-column:1/-1"><button class="primary" type="submit" id="placeOrder" ${state.sending ? "disabled" : ""}>Enviar pedido</button></div>
    </form>
  </section>`;
}

function tablePicker() {
  return `<form class="login" id="tableForm"><h2>¿En qué mesa estás?</h2>
    <label class="label" for="tableNum">Número de mesa</label>
    <input id="tableNum" inputmode="numeric" maxlength="10" required>
    <button class="primary" type="submit">Continuar</button>
    <p class="muted" style="margin:0">Normalmente viene en el código QR de tu mesa.</p></form>`;
}

// ---------- render ----------
// Al redibujar, el campo donde el cliente está escribiendo conserva el foco
function render() {
  const focusId = document.activeElement && document.activeElement.id;
  renderInner();
  const el = focusId && $(focusId);
  if (el && (el.tagName === "INPUT" || el.tagName === "SELECT") && document.activeElement !== el) {
    el.focus();
    try { if (el.tagName === "INPUT" && el.type !== "email") el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
  }
}

function renderInner() {
  const name = state.config.name || "Menú";
  $("shopName").textContent = name;
  document.title = name + ({ mesa: " · Mesa", llevar: " · Para llevar", casa: " · Pedir desde casa" })[MODE];
  $("eyebrow").textContent = MODE === "mesa" ? (state.table ? `${tableLabel(state.table)} · ordena desde tu celular` : "Pedido en mesa")
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
        return `<button data-plate="${i}" class="${i === state.cur ? "on" : ""}">Plato ${i + 1}${state.toGo[i] ? " (llevar)" : ""}${n ? ` · ${n}` : ""}</button>`;
      }).join("") +
      (state.plates.length < 20 ? `<button data-addplate>+ Otro plato</button>` : "") + `</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <button data-togo class="toggle ${state.toGo[state.cur] ? "off" : "on"}" aria-pressed="${!!state.toGo[state.cur]}">${state.toGo[state.cur] ? `Plato ${state.cur + 1}: PARA LLEVAR ✓` : `Plato ${state.cur + 1}: comer aquí`}</button>
        <span class="muted" style="font-size:.85rem">Toca para cambiar. Si quieren algo para llevar, ponlo en otro plato y márcalo.</span></div>
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
  const promos = promoLabels(state.config);
  if (promos.length && !off) html = html.replace('<div class="cats">', `<div class="notice promo">Hoy: ${promos.map(esc).join(" · ")}</div><div class="cats">`);
  for (const [cat, items] of Object.entries(groups)) {
    html += `<section class="section"><h2>${esc(cat)}</h2>`;
    for (const p of items) {
      const sel = selectionFor(state.sel, p, state.config);
      html += productCard(p, { config: state.config, plate, sel, canAdd: !off, cur: cur() });
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
    bar.innerHTML = (state.upsell ? `<div class="in">${upsellHtml()}</div>` : "") + `<div class="in">${totalsHtml()}</div><div class="in"><span class="sum">${units} ${units === 1 ? "pieza" : "piezas"} · ${money(cartTotal(), cur())}</span>
      <button class="primary" data-checkout>Continuar</button></div>`;
    return;
  }
  const label = MODE === "mesa" ? (!inTab() && state.confirmNewTab ? "Abrir cuenta nueva y enviar" : "Enviar a cocina") : "Enviar pedido";
  bar.innerHTML = (state.upsell ? `<div class="in">${upsellHtml()}</div>` : "") + `<div class="in">${totalsHtml()}</div><div class="in">
    <span class="sum">${units} ${units === 1 ? "pieza" : "piezas"} · ${money(cartTotal(), cur())}</span>
    ${MODE === "llevar" ? `<input id="custName" placeholder="Tu nombre" autocomplete="given-name" maxlength="60" value="${esc(state.customer)}" aria-label="Tu nombre">` : ""}
    <input id="custNote" placeholder="Nota (sin cebolla, salsa aparte…)" maxlength="200" value="${esc(state.note)}" aria-label="Nota para la cocina">
    <button class="primary" id="placeOrder" ${state.sending ? "disabled" : ""}>${label}</button>
  </div>
  ${MODE === "llevar" ? `<div class="in muted" style="font-size:.82rem;margin-top:6px">Pagas al recoger tu pedido.</div>` : ""}`;
  if (active && $(active)) $(active).focus();
}

// ---------- mesa: abrir o unirse a una cuenta ----------
// Abre una cuenta nueva en la mesa (se necesita la clave del QR). Puede haber varias a la vez.
async function openNewTab() {
  if (!state.tableKey) { const e = new Error("nokey"); e.code = "nokey"; throw e; }
  const session = newId(24);
  const code = newCode();
  const b = writeBatch(db);
  b.set(doc(db, "tabSecrets", session), { table: state.table, key: state.tableKey, openedAt: serverTimestamp() });
  const tab = { table: state.table, openedAt: serverTimestamp(), code, closed: false, billRequested: false };
  if (state.tabName.trim()) tab.name = state.tabName.trim().slice(0, 40);
  b.set(doc(db, "tabs", session), tab);
  b.set(doc(db, "joins", state.table + "-" + code), { session, table: state.table, createdAt: serverTimestamp() });
  try { await b.commit(); }
  catch (e) { console.error(e); const err = new Error("badkey"); err.code = closed() ? "closed" : "badkey"; throw err; }
  setSession(session);
  return session;
}

async function ensureTableSession() {
  if (inTab()) return state.mySession;
  return openNewTab();
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
    toast("¡Listo! Ya estás en la cuenta de tu mesa");
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

  if (MODE === "mesa" && !inTab()) {
    if (!state.tableKey) { toast("Escanea el QR de tu mesa, o escribe el código de la cuenta de tu mesa para unirte."); return; }
    if (!state.confirmNewTab) {
      state.confirmNewTab = true; renderCart();
      toast("Se abrirá una cuenta nueva solo para ti. Si tu mesa ya tiene cuenta, mejor escribe su código arriba.");
      return;
    }
  }
  // Sugerencia de bebida (una vez por pedido)
  if (!state.upsellDone && upsellOptions().length) { state.upsell = true; state.upsellDone = true; renderCart(); return; }
  state.upsell = false;
  state.confirmNewTab = false;
  state.sending = true; renderCart();
  try {
    const units = items.reduce((s, i) => s + i.qty, 0);
    const ref = doc(collection(db, "orders"));
    const minutes = prepMinutes(units, state.config);
    const order = {
      type: MODE, items, minutes, status: MODE === "casa" ? "por_pagar" : "pendiente", paid: false, createdAt: serverTimestamp(),
      code: ref.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase(),
      total: cartTotals().total
    };
    const tt = cartTotals();
    if (tt.discount) { order.discount = tt.discount; order.promos = tt.discounts.map((d) => d.name.slice(0, 60)); }
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
      if (order.discount) round.discount = order.discount;
      if (order.plates) round.plates = order.plates;
      batch.set(doc(db, "tabs", order.session, "rounds", ref.id), round);
    }
    // Los pedidos desde casa entran a la fila hasta que se confirma el pago
    if (MODE !== "casa") batch.set(doc(db, "queue", ref.id), { status: "pendiente", createdAt: serverTimestamp(), minutes });
    await batch.commit();

    state.plates = [{}]; state.toGo = []; state.cur = 0; state.note = ""; state.checkout = false; state.upsellDone = false; state.upsell = false;
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
    const msg = e && e.code === "nokey" ? "Escanea el código QR que está en tu mesa para pedir."
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
  if (handleSelectClick(d, state.sel, state.products, state.config)) { render(); return; }
  if ("upsellsend" in d) {
    state.upsell = false;
    if (MODE === "casa") { state.checkout = true; window.scrollTo({ top: 0 }); render(); } else placeOrder();
    return;
  }
  if (d.inc) { plate[d.inc] = (plate[d.inc] || 0) + 1; render(); return; }
  if (d.dec) { plate[d.dec] = (plate[d.dec] || 0) - 1; if (plate[d.dec] <= 0) delete plate[d.dec]; render(); return; }
  if (d.plate) { state.cur = Number(d.plate); render(); return; }
  if ("togo" in d) { state.toGo[state.cur] = !state.toGo[state.cur]; toast(state.toGo[state.cur] ? `Plato ${state.cur + 1} será para llevar` : `Plato ${state.cur + 1} es para comer aquí`); render(); return; }
  if ("addplate" in d) {
    if (state.plates.length >= 20) { toast("Máximo 20 platos por ronda"); return; }
    state.plates.push({});
    state.cur = state.plates.length - 1;
    toast(`Plato ${state.cur + 1}: agrega lo que va en este plato`);
    render(); return;
  }
  if (t.id === "placeOrder" && MODE !== "casa") { placeOrder(); return; }
  if ("checkout" in d) {
    if (!state.upsellDone && upsellOptions().length) { state.upsell = true; state.upsellDone = true; renderCart(); return; }
    state.checkout = true; window.scrollTo({ top: 0 }); render(); return;
  }
  if ("back" in d) { state.checkout = false; render(); return; }
  if (d.delivery) { state.delivery = d.delivery; render(); return; }
  if (d.copy) {
    const v = d.copy;
    Promise.resolve().then(() => navigator.clipboard.writeText(v)).then(() => toast("Copiado"), () => toast(v));
    return;
  }
  if ("neworder" in d) { watchMyOrder(null); return; }
  if ("invoiceopen" in d) { state.invoiceOpen = true; render(); $("invRfc")?.focus(); return; }
  if ("invoiceclose" in d) { state.invoiceOpen = false; render(); return; }
  if ("newtab" in d) {
    openNewTab().then(() => toast("Cuenta nueva abierta. Comparte su código con quien pida contigo."),
      (e) => toast(e.code === "closed" ? "Hoy ya no estamos recibiendo pedidos" : "No se pudo abrir la cuenta. Escanea otra vez el QR de la mesa."));
    return;
  }
  if ("leavetab" in d) {
    if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "¿Salir de esta cuenta? Toca otra vez"; return; }
    // Este celular deja de pedir en esta cuenta (la cuenta sigue abierta para los demás)
    state.mySession = null; local.set("comanda.session." + state.table, null); watchTab(null);
    toast("Listo. Ahora puedes abrir una cuenta nueva o unirte a otra con su código.");
    return;
  }
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
  if (id === "tabName") state.tabName = ev.target.value;
  const invMap = { invRfc: "rfc", invRazon: "razon", invEmail: "email", invCp: "cp", invRegimen: "regimen", invUso: "uso" };
  if (invMap[id]) state.inv[invMap[id]] = ev.target.value;
});
document.addEventListener("submit", (ev) => {
  if (ev.target.id === "casaForm") { ev.preventDefault(); placeOrder(); return; }
  if (ev.target.id === "joinForm") { ev.preventDefault(); joinTable(state.joinCode); return; }
  if (ev.target.id === "invForm") {
    ev.preventDefault();
    if (MODE === "mesa") {
      const rounds = state.rounds.filter((r) => r.status !== "cancelado");
      sendInvoice(state.mySession, "cuenta", rounds.reduce((s, r) => s + (Number(r.total) || 0), 0), state.tab && state.tab.code);
    } else if (state.myOrder) sendInvoice(state.myOrder.id, "pedido", state.myOrder.total, state.myOrder.code);
    return;
  }
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
    if (state.mySession) watchTab(state.mySession);
  }
}
start();
