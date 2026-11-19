// Vista del cliente. Funciona en tres modos según la página:
//  - mesa.html   → cuenta abierta por mesa, rondas separadas por platos, se paga al final.
//  - llevar.html → pedido para llevar en el local, con fila y tiempo estimado; se paga al recoger.
//  - casa.html   → pedido desde casa (domicilio o recoger); se paga antes por transferencia.
import {
  collection, doc, onSnapshot, query, where, writeBatch, setDoc, getDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, configured, $, esc, money, toMillis, local, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG, prepMinutes, estimate, isClosed, newId
} from "./common.js";

const MODE = ["mesa", "casa"].includes(document.body.dataset.mode) ? document.body.dataset.mode : "llevar";
const ORDER_KEY = MODE === "casa" ? "comanda.myOrder.casa" : "comanda.myOrder";
const params = new URLSearchParams(location.search);
const tableParam = (params.get("m") || params.get("mesa") || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 10);

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
  tableDoc: null,
  rounds: [],
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
  state.plates.forEach((plate, i) => {
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
    <div class="full"><details><summary class="muted">Ver mi pedido</summary>${itemsByPlate(o.items)}
      <div class="price">Total: ${money(o.total, cur())}</div>
      <div class="muted">${payNote}${o.type === "casa" ? (o.delivery === "domicilio" ? " · A domicilio" : " · Pasas a recoger") : ""}</div></details></div>
    ${done ? `<div class="full"><button data-neworder>Hacer otro pedido</button></div>` : ""}
  </div>`;
}

function tableHeader() {
  const t = state.tableDoc;
  const open = t && t.status === "abierta";
  const rounds = state.rounds.filter((r) => r.status !== "cancelado").sort((a, b) => a.createdAt - b.createdAt);
  const total = rounds.reduce((s, r) => s + (Number(r.total) || 0), 0);
  // Cuenta que este celular tenía y que el dueño ya cerró
  if (!open && state.mySession && t && t.session === state.mySession && t.status === "cerrada") {
    return `<div class="ticket ready"><div class="full"><h2>Cuenta cerrada. ¡Gracias por tu visita!</h2>
      <p class="muted" style="margin:4px 0 0">Si quieren pedir algo más, se abre una cuenta nueva al enviar el pedido.</p></div></div>`;
  }
  if (!open || !rounds.length) return "";
  let html = `<div class="ticket"><div><div class="label">Mesa ${esc(state.table)}</div><div class="big">${money(total, cur())}</div>
    <div class="muted">${rounds.length} ${rounds.length === 1 ? "ronda" : "rondas"}</div></div>`;
  const active = rounds.filter((r) => r.status === "pendiente" || r.status === "preparando");
  if (active.length) {
    const last = active[active.length - 1];
    const q = etaFor(last);
    html += `<div><div class="label">Tu última ronda llega en</div><div class="big">~${q.minutes} min</div></div>`;
  } else if (rounds.some((r) => r.status === "listo")) {
    html += `<div><div class="label">Estado</div><h2>¡Ya va para tu mesa!</h2></div>`;
  }
  html += `<div class="full"><details><summary class="muted">Ver la cuenta</summary>`;
  rounds.forEach((r, i) => {
    html += `<div class="round"><div class="row"><strong>Ronda ${i + 1}</strong><span class="tag">${STATUS_LABEL[r.status] || r.status}</span><span class="price">${money(r.total, cur())}</span></div>${itemsByPlate(r.items)}</div>`;
  });
  html += `</details></div><div class="full" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">`;
  html += t.billRequested ? `<span class="tag">Ya pediste la cuenta. En un momento te atienden.</span>` : `<button data-bill>Pedir la cuenta</button>`;
  html += `</div></div>`;
  return html;
}

function checkoutHtml() {
  const items = cartItems();
  const canDeliver = deliveryOn();
  const delivery = canDeliver ? state.delivery : "recoger";
  return `<section class="checkout">
    <button data-back>← Volver al menú</button>
    <h2 style="margin-top:12px">Tu pedido</h2>
    ${itemsByPlate(items)}
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
  const ref = doc(db, "tables", state.table);
  const t = state.tableDoc;
  if (t && t.status === "abierta") return t.session;
  const session = newId(20);
  try {
    await setDoc(ref, { status: "abierta", session, openedAt: serverTimestamp() });
    return session;
  } catch (e) {
    // Otra persona de la mesa la abrió al mismo tiempo: usamos esa cuenta.
    const s = await getDoc(ref);
    if (s.exists() && s.data().status === "abierta") return s.data().session;
    throw e;
  }
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
      state.mySession = order.session; local.set("comanda.session." + state.table, order.session);
    }
    const batch = writeBatch(db);
    batch.set(ref, order);
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
    toast(closed() ? "Hoy ya no estamos recibiendo pedidos" : "No se pudo enviar. Revisa tu internet e intenta otra vez.");
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

let unsubRounds = null, roundsSession = null;
function watchRounds(session) {
  if (session === roundsSession) return;
  if (unsubRounds) unsubRounds();
  roundsSession = session; state.rounds = [];
  if (!session) { unsubRounds = null; render(); return; }
  unsubRounds = onSnapshot(query(collection(db, "orders"), where("type", "==", "mesa"), where("session", "==", session)), (s) => {
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
    // Si el último plato está vacío, solo cambiamos a él
    const lastEmpty = !Object.keys(state.plates[state.plates.length - 1]).length;
    if (!lastEmpty) state.plates.push({});
    state.cur = state.plates.length - 1; render(); return;
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
    updateDoc(doc(db, "tables", state.table), { billRequested: true })
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
});
document.addEventListener("submit", (ev) => {
  if (ev.target.id === "casaForm") { ev.preventDefault(); placeOrder(); return; }
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
  const timer = setTimeout(() => { if (!state.loaded) notice("El menú tarda en cargar. Revisa tu conexión a internet."); }, 10000);
  const onErr = (e) => { console.error(e); notice("Se perdió la conexión. Recarga la página."); };

  onSnapshot(doc(db, "config", "shop"), (s) => {
    if (s.exists()) state.config = { ...DEFAULT_CONFIG, ...s.data() };
    cleanCart();
    render();
  }, onErr);

  onSnapshot(collection(db, "products"), (s) => {
    state.products = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    cleanCart();
    state.loaded = true; clearTimeout(timer); notice("");
    render();
  }, onErr);

  onSnapshot(query(collection(db, "queue"), where("status", "in", ["pendiente", "preparando"])), (s) => {
    state.queue = s.docs.map((d) => { const x = d.data({ serverTimestamps: "estimate" }); return { id: d.id, minutes: x.minutes, createdAt: toMillis(x.createdAt) }; });
    render();
  }, onErr);

  if (MODE !== "mesa" && state.myOrderId) watchMyOrder(state.myOrderId);
  if (MODE === "mesa") {
    onSnapshot(doc(db, "tables", state.table), (s) => {
      state.tableDoc = s.exists() ? s.data() : null;
      const open = state.tableDoc && state.tableDoc.status === "abierta";
      watchRounds(open ? state.tableDoc.session : null);
      render();
    }, onErr);
  }
}
start();
