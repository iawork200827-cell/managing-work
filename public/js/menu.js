// Vista del cliente: menú, carrito, envío de pedido y seguimiento en la fila.
import {
  collection, doc, onSnapshot, query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, configured, $, esc, money, toMillis, local, toast, notConfiguredHtml,
  STATUS_LABEL, DEFAULT_CONFIG
} from "./common.js";

const params = new URLSearchParams(location.search);
const state = {
  config: { ...DEFAULT_CONFIG },
  products: [],
  queue: [],
  myOrder: null,
  myOrderId: local.get("comanda.myOrder"),
  cart: {},
  customer: local.get("comanda.name") || "",
  table: params.get("mesa") || local.get("comanda.mesa") || "",
  note: "",
  catFilter: "Todo",
  loaded: false,
  sending: false
};
if (params.get("mesa")) local.set("comanda.mesa", params.get("mesa"));

const cur = () => state.config.currency || "$";

function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

// ---------- fila ----------
function queueInfo() {
  const per = Number(state.config.minutesPerOrder) || 5;
  const list = [...state.queue].sort((a, b) => a.createdAt - b.createdAt);
  const idx = list.findIndex((q) => q.id === state.myOrderId);
  if (idx < 0) return { ahead: list.length, minutes: (list.length + 1) * per };
  // Si el pedido ya se está preparando, solo cuenta el tiempo de los que están antes.
  return { ahead: idx, minutes: (idx + 1) * per };
}

function ticketHtml(o) {
  const status = o.status;
  const ready = status === "listo";
  const done = status === "entregado" || status === "cancelado";
  const steps = ["pendiente", "preparando", "listo"];
  const stepIdx = steps.indexOf(status);
  const q = queueInfo();
  const pickup = state.config.useTables && o.table ? "Te la llevamos a tu mesa." : "Pasa a recogerla al mostrador.";
  let main;
  if (ready) main = `<div class="full"><h2>¡Tu orden está lista!</h2><p class="muted" style="margin:4px 0 0">${pickup}</p></div>`;
  else if (status === "cancelado") main = `<div class="full"><h2>Tu orden fue cancelada.</h2><p class="muted" style="margin:4px 0 0">Pregunta en el mostrador si tienes dudas.</p></div>`;
  else if (status === "entregado") main = `<div class="full"><h2>Orden entregada. ¡Buen provecho!</h2></div>`;
  else main = `<div><div class="label">Personas delante de ti</div><div class="big">${q.ahead}</div></div>
      <div><div class="label">Tiempo estimado</div><div class="big">~${q.minutes} min</div></div>`;
  return `<div class="ticket ${ready ? "ready" : ""}" aria-live="polite">
    <div><div class="label">Tu orden</div><div class="big">#${esc(o.code)}</div>
      <div class="muted">${esc(o.customer)}${o.table ? " · Mesa " + esc(o.table) : ""}</div></div>
    ${main}
    <div class="full steps">${steps.map((s, i) => `<span class="step ${i <= stepIdx && !done ? "on" : ""}">${STATUS_LABEL[s]}</span>`).join("")}</div>
    <div class="full"><details><summary class="muted">Ver mi pedido</summary>
      <ul>${(o.items || []).map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join("")}</ul>
      <div class="price">Total: ${money(o.total, cur())}</div></details></div>
    ${done ? `<div class="full"><button data-neworder>Hacer otra orden</button></div>` : ""}
  </div>`;
}

// ---------- render ----------
function render() {
  $("shopName").textContent = state.config.name || "Menú";
  document.title = (state.config.name || "Menú") + " · Menú";
  $("eyebrow").textContent = state.table && state.config.useTables ? `Menú · Mesa ${state.table}` : "Menú · ordena desde tu celular";
  const app = $("app");
  if (!configured) { app.innerHTML = notConfiguredHtml(); return; }

  let html = "";
  if (state.myOrder) html += ticketHtml(state.myOrder);

  if (!state.loaded) { app.innerHTML = html + '<p class="muted">Cargando el menú…</p>'; renderCart(); return; }
  if (!state.products.length) {
    app.innerHTML = html + '<div class="empty">El menú todavía no tiene productos.</div>';
    renderCart(); return;
  }

  const cats = ["Todo", ...new Set(state.products.map((p) => p.category || "Otros"))];
  html += '<div class="cats">' + cats.map((c) => `<button data-cat="${esc(c)}" class="${c === state.catFilter ? "on" : ""}">${esc(c)}</button>`).join("") + "</div>";

  const groups = {};
  state.products
    .filter((p) => state.catFilter === "Todo" || (p.category || "Otros") === state.catFilter)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((p) => (groups[p.category || "Otros"] ||= []).push(p));

  for (const [cat, items] of Object.entries(groups)) {
    html += `<section class="section"><h2>${esc(cat)}</h2>`;
    for (const p of items) {
      const n = state.cart[p.id] || 0;
      const out = p.available === false;
      html += `<div class="item ${out ? "out" : ""}">
        <div><h3>${esc(p.name)}</h3>${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}
          <div class="price" style="margin-top:6px">${money(p.price, cur())}</div></div>
        <div>${out ? '<span class="out-tag">Agotado</span>' :
          `<div class="qty">${n ? `<button aria-label="Quitar ${esc(p.name)}" data-dec="${esc(p.id)}">−</button><span class="mono">${n}</span>` : ""}
           <button class="${n ? "" : "primary"}" aria-label="Agregar ${esc(p.name)}" data-inc="${esc(p.id)}">+</button></div>`}</div>
      </div>`;
    }
    html += "</section>";
  }
  app.innerHTML = html;
  renderCart();
}

function cartCount() { return Object.values(state.cart).reduce((a, b) => a + b, 0); }
function cartTotal() {
  return Object.entries(state.cart).reduce((s, [id, n]) => {
    const p = state.products.find((x) => x.id === id);
    return s + (p ? Number(p.price) * n : 0);
  }, 0);
}

function renderCart() {
  const bar = $("cartbar");
  const count = cartCount();
  if (!count) { bar.hidden = true; return; }
  const active = document.activeElement && document.activeElement.id;
  bar.hidden = false;
  const askTable = state.config.useTables && !params.get("mesa");
  bar.innerHTML = `<div class="in">
    <span class="sum">${count} ${count === 1 ? "producto" : "productos"} · ${money(cartTotal(), cur())}</span>
    <input id="custName" placeholder="Tu nombre" autocomplete="given-name" maxlength="60" value="${esc(state.customer)}" aria-label="Tu nombre">
    ${askTable ? `<input id="custTable" placeholder="Mesa" inputmode="numeric" maxlength="10" style="flex:0 1 90px" value="${esc(state.table)}" aria-label="Número de mesa">` : ""}
    <input id="custNote" placeholder="Nota (sin cebolla, para llevar…)" maxlength="200" value="${esc(state.note)}" aria-label="Nota para la cocina">
    <button class="primary" id="placeOrder" ${state.sending ? "disabled" : ""}>Enviar orden</button>
  </div>`;
  if (active && $(active)) $(active).focus();
}

// ---------- enviar pedido ----------
async function placeOrder() {
  const name = state.customer.trim();
  if (!name) { toast("Escribe tu nombre para poder llamarte"); $("custName")?.focus(); return; }
  if (state.config.useTables && !state.table.trim()) { toast("Escribe tu número de mesa"); $("custTable")?.focus(); return; }
  const items = Object.entries(state.cart).map(([id, qty]) => {
    const p = state.products.find((x) => x.id === id);
    return p && p.available !== false ? { id, name: p.name, price: Number(p.price) || 0, qty } : null;
  }).filter(Boolean);
  if (!items.length) { toast("Los productos que elegiste se agotaron"); state.cart = {}; render(); return; }

  const ref = doc(collection(db, "orders"));
  const code = ref.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  const order = {
    customer: name.slice(0, 60), items, code, status: "pendiente", createdAt: serverTimestamp(),
    total: Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100
  };
  if (state.config.useTables && state.table.trim()) order.table = state.table.trim().slice(0, 10);
  if (state.note.trim()) order.note = state.note.trim().slice(0, 200);

  state.sending = true; renderCart();
  try {
    const batch = writeBatch(db);
    batch.set(ref, order);
    batch.set(doc(db, "queue", ref.id), { status: "pendiente", createdAt: serverTimestamp() });
    await batch.commit();
    local.set("comanda.name", name);
    state.cart = {}; state.note = "";
    watchMyOrder(ref.id);
    toast("¡Orden enviada!");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    console.error(e);
    toast("No se pudo enviar la orden. Revisa tu internet e intenta otra vez.");
  } finally {
    state.sending = false; render();
  }
}

// ---------- seguimiento ----------
let unsubOrder = null;
function watchMyOrder(id) {
  if (unsubOrder) unsubOrder();
  state.myOrderId = id; local.set("comanda.myOrder", id);
  if (!id) { state.myOrder = null; render(); return; }
  unsubOrder = onSnapshot(doc(db, "orders", id), (s) => {
    state.myOrder = s.exists() ? { id: s.id, ...s.data() } : null;
    if (!s.exists()) { local.set("comanda.myOrder", null); }
    render();
  }, () => { state.myOrder = null; render(); });
}

// ---------- eventos ----------
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button"); if (!t) return;
  const d = t.dataset;
  if (d.cat) { state.catFilter = d.cat; render(); return; }
  if (d.inc) { state.cart[d.inc] = (state.cart[d.inc] || 0) + 1; render(); return; }
  if (d.dec) { state.cart[d.dec] = (state.cart[d.dec] || 0) - 1; if (state.cart[d.dec] <= 0) delete state.cart[d.dec]; render(); return; }
  if (t.id === "placeOrder") { placeOrder(); return; }
  if ("neworder" in d) { watchMyOrder(null); return; }
});
document.addEventListener("input", (ev) => {
  const id = ev.target.id;
  if (id === "custName") state.customer = ev.target.value;
  if (id === "custTable") { state.table = ev.target.value; local.set("comanda.mesa", ev.target.value); }
  if (id === "custNote") state.note = ev.target.value;
});

// ---------- arranque ----------
function start() {
  render();
  if (!configured) return;
  const timer = setTimeout(() => { if (!state.loaded) notice("El menú tarda en cargar. Revisa tu conexión a internet."); }, 10000);
  const onErr = (e) => { console.error(e); notice("Se perdió la conexión. Recarga la página."); };

  onSnapshot(doc(db, "config", "shop"), (s) => {
    if (s.exists()) state.config = { ...DEFAULT_CONFIG, ...s.data() };
    render();
  }, onErr);

  onSnapshot(collection(db, "products"), (s) => {
    state.products = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    for (const id of Object.keys(state.cart)) {
      const p = state.products.find((x) => x.id === id);
      if (!p || p.available === false) delete state.cart[id];
    }
    state.loaded = true; clearTimeout(timer); notice("");
    render();
  }, onErr);

  onSnapshot(query(collection(db, "queue"), where("status", "in", ["pendiente", "preparando"])), (s) => {
    state.queue = s.docs.map((d) => ({ id: d.id, createdAt: toMillis(d.data({ serverTimestamps: "estimate" }).createdAt) }));
    render();
  }, onErr);

  if (state.myOrderId) watchMyOrder(state.myOrderId);
}
start();
