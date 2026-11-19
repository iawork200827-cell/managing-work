// Lógica del carrito compartida por el menú del cliente y el modo empleado:
// carnes, extras con precio, notas rápidas ("sin cebolla"), agotados y promociones.
import { esc, money } from "./common.js";

export const DEFAULT_NOTES = ["Con todo", "Sin cebolla", "Sin cilantro", "Sin salsa"];
const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// ---------- agotados y opciones ----------
export const outSet = (config) => new Set((config.outOptions || []).map((o) => norm(o)));
export const hasOptions = (p) => Array.isArray(p.options) && p.options.length > 0;
export function optionsOf(p, config) {
  const out = outSet(config);
  return (Array.isArray(p.options) ? p.options : []).filter((o) => o && !out.has(norm(o)));
}
export function isOut(p, config) {
  if (p.available === false) return true;
  const name = norm(p.name);
  return [...outSet(config)].some((o) => o && name.includes(o));
}
export const extrasOf = (p) => (Array.isArray(p.extras) ? p.extras : []).filter((e) => e && e.name);
// Las notas rápidas se ofrecen en la comida (productos con carnes para escoger)
export const notesFor = (p, config) => (hasOptions(p) ? (Array.isArray(config.quickNotes) && config.quickNotes.length ? config.quickNotes : DEFAULT_NOTES) : []);

// ---------- claves del carrito ----------
// Cada plato guarda { "id|carne|extra1+extra2|nota1+nota2": cantidad }
export function makeKey(id, opt, extras, notes) {
  return [id, opt || "", [...(extras || [])].sort().join("+"), [...(notes || [])].sort().join("+")].join("|");
}
export function parseKey(key) {
  const [id, opt = "", ex = "", no = ""] = String(key).split("|");
  return { id, opt, extras: ex ? ex.split("+") : [], notes: no ? no.split("+") : [] };
}
export function validKey(key, products, config) {
  const k = parseKey(key);
  const p = products.find((x) => x.id === k.id);
  if (!p || isOut(p, config)) return null;
  if (hasOptions(p) && !optionsOf(p, config).includes(k.opt)) return null;
  const allExtras = extrasOf(p);
  const extras = k.extras.map((n) => allExtras.find((e) => e.name === n)).filter(Boolean);
  if (extras.length !== k.extras.length) return null;
  return { p, opt: k.opt, extras, notes: k.notes };
}

// Nombre que ve la cocina: "Tacos de pastor + extra queso (sin cebolla)"
export function itemName(v) {
  let n = v.opt ? `${v.p.name} de ${v.opt.toLowerCase()}` : v.p.name;
  if (v.extras.length) n += " + " + v.extras.map((e) => e.name.toLowerCase()).join(", ");
  if (v.notes.length) n += " (" + v.notes.map((x) => x.toLowerCase()).join(", ") + ")";
  return n;
}

// Arma la lista de productos de los platos
export function buildItems(plates, toGo, products, config, allowToGo) {
  const out = [];
  let num = 0;
  plates.forEach((plate, idx) => {
    const hasItems = Object.entries(plate).some(([k, q]) => q > 0 && validKey(k, products, config));
    if (hasItems) num++;
    for (const [key, qty] of Object.entries(plate)) {
      const v = validKey(key, products, config);
      if (!v || qty <= 0) continue;
      const price = (Number(v.p.price) || 0) + v.extras.reduce((s, e) => s + (Number(e.price) || 0), 0);
      const item = { id: v.p.id, name: itemName(v), price, qty, plate: num };
      if (v.opt) item.option = v.opt;
      if (v.extras.length) item.extras = v.extras.map((e) => e.name);
      if (v.notes.length) item.notes = v.notes;
      if (allowToGo && toGo && toGo[idx]) item.toGo = true;
      out.push(item);
    }
  });
  return out;
}

export function cleanPlates(plates, products, config) {
  for (const plate of plates) for (const key of Object.keys(plate)) if (!validKey(key, products, config) || plate[key] <= 0) delete plate[key];
}

// ---------- promociones ----------
// config.promos: [{ id, name, kind: "2x1" | "pct", target: "prod:<id>" | "cat:<Categoría>", pct, days: [0-6], from: "HH:MM", to: "HH:MM", active }]
const minutesOf = (hhmm) => { const [h, m] = String(hhmm || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
export function promoActive(promo, now = new Date()) {
  if (!promo || promo.active === false) return false;
  if (Array.isArray(promo.days) && promo.days.length && !promo.days.includes(now.getDay())) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const from = promo.from ? minutesOf(promo.from) : 0, to = promo.to ? minutesOf(promo.to) : 24 * 60;
  return from <= to ? t >= from && t < to : t >= from || t < to;
}
function matches(promo, item, products) {
  const [kind, val] = String(promo.target || "").split(/:(.*)/s);
  if (kind === "prod") return item.id === val;
  if (kind === "cat") { const p = products.find((x) => x.id === item.id); return !!p && (p.category || "Otros") === val; }
  return false;
}
// Devuelve los descuentos que aplican: [{ name, amount }]
export function promoDiscounts(items, products, config, now = new Date()) {
  const out = [];
  for (const promo of config.promos || []) {
    if (!promoActive(promo, now)) continue;
    const hits = items.filter((i) => i.price > 0 && matches(promo, i, products));
    if (!hits.length) continue;
    let amount = 0;
    if (promo.kind === "2x1") {
      // Por cada 2 piezas, la más barata va gratis
      const units = [];
      hits.forEach((i) => { for (let k = 0; k < i.qty; k++) units.push(i.price); });
      units.sort((a, b) => a - b);
      const free = Math.floor(units.length / 2);
      amount = units.slice(0, free).reduce((s, x) => s + x, 0);
    } else if (promo.kind === "pct") {
      const pct = Math.min(100, Math.max(0, Number(promo.pct) || 0));
      amount = hits.reduce((s, i) => s + i.price * i.qty, 0) * pct / 100;
    }
    amount = Math.round(amount * 100) / 100;
    if (amount > 0) out.push({ name: promo.name || "Promoción", amount });
  }
  return out;
}
export function promoLabels(config, now = new Date()) {
  return (config.promos || []).filter((p) => promoActive(p, now)).map((p) => p.name).filter(Boolean);
}

// Totales de un carrito: subtotal, descuentos y total
export function totals(items, products, config) {
  const subtotal = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
  const discounts = promoDiscounts(items, products, config);
  const discount = Math.round(discounts.reduce((s, d) => s + d.amount, 0) * 100) / 100;
  return { subtotal, discounts, discount, total: Math.max(0, Math.round((subtotal - discount) * 100) / 100) };
}

// ---------- tarjeta de producto con carnes, extras y notas ----------
// sel = { opt, extras: Set, notes: Set } (lo que está escogido en ese producto)
export function productCard(p, { config, plate, sel, canAdd, compactNotes, cur }) {
  const out = isOut(p, config) || (hasOptions(p) && !optionsOf(p, config).length);
  const opts = optionsOf(p, config);
  const extras = extrasOf(p);
  const notes = notesFor(p, config);
  const key = makeKey(p.id, sel.opt, sel.extras, sel.notes);
  const n = plate[key] || 0;
  const unit = (Number(p.price) || 0) + extras.filter((e) => sel.extras.has(e.name)).reduce((s, e) => s + (Number(e.price) || 0), 0);
  const chosen = Object.entries(plate).filter(([k, q]) => q > 0 && parseKey(k).id === p.id).map(([k, q]) => {
    const pk = parseKey(k);
    const bits = [pk.opt && pk.opt.toLowerCase(), ...pk.extras.map((x) => "+" + x.toLowerCase()), ...pk.notes.map((x) => x.toLowerCase())].filter(Boolean);
    return `${q}${bits.length ? " " + bits.join(" ") : ""}`;
  });
  const showSel = canAdd && !out;
  return `<div class="item ${out ? "out" : ""}">
    ${p.photo ? `<img class="pphoto" src="${esc(p.photo)}" alt="" loading="lazy">` : ""}
    <div class="pbody"><h3>${esc(p.name)}${p.popular ? ' <span class="tag pop">Lo más pedido</span>' : ""}</h3>
      ${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}
      <div class="price" style="margin-top:6px">${money(unit, cur)}</div>
      ${showSel && opts.length ? `<div class="opts" role="radiogroup" aria-label="Carne para ${esc(p.name)}">${opts.map((o) => `<button role="radio" aria-checked="${o === sel.opt}" class="${o === sel.opt ? "on" : ""}" data-pick="${esc(p.id)}" data-opt="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}
      ${showSel && extras.length ? `<div class="opts">${extras.map((e) => `<button class="${sel.extras.has(e.name) ? "on" : ""}" aria-pressed="${sel.extras.has(e.name)}" data-extra="${esc(p.id)}" data-name="${esc(e.name)}">+ ${esc(e.name)} ${money(e.price, cur)}</button>`).join("")}</div>` : ""}
      ${showSel && notes.length ? `<div class="opts notes">${notes.map((x) => `<button class="${sel.notes.has(x) ? "on" : ""}" aria-pressed="${sel.notes.has(x)}" data-note="${esc(p.id)}" data-name="${esc(x)}">${esc(x)}</button>`).join("")}</div>` : ""}
      ${chosen.length ? `<div class="muted chosen">En este plato: ${esc(chosen.join(", "))}</div>` : ""}</div>
    <div>${out ? '<span class="out-tag">Agotado</span>' : !canAdd ? "" :
      `<div class="qty">${n ? `<button aria-label="Quitar ${esc(p.name)}" data-dec="${esc(key)}">−</button><span class="mono">${n}</span>` : ""}
       <button class="${n ? "" : "primary"}" aria-label="Agregar ${esc(p.name)}" data-inc="${esc(key)}">+</button></div>`}</div>
  </div>`;
}

// Selección actual de un producto (carne, extras y notas escogidos)
export function selectionFor(store, p, config) {
  const s = (store[p.id] ||= { opt: "", extras: new Set(), notes: new Set() });
  const opts = optionsOf(p, config);
  if (opts.length && !opts.includes(s.opt)) s.opt = opts[0];
  if (!opts.length) s.opt = "";
  const valid = new Set(extrasOf(p).map((e) => e.name));
  for (const e of [...s.extras]) if (!valid.has(e)) s.extras.delete(e);
  return s;
}

// Maneja los toques en carne / extra / nota. Devuelve true si atendió el clic.
export function handleSelectClick(d, store, products, config) {
  const pid = d.pick || d.extra || d.note;
  if (!pid) return false;
  const p = products.find((x) => x.id === pid);
  if (!p) return true;
  const s = selectionFor(store, p, config);
  if (d.pick) s.opt = d.opt;
  if (d.extra) s.extras.has(d.name) ? s.extras.delete(d.name) : s.extras.add(d.name);
  if (d.note) s.notes.has(d.name) ? s.notes.delete(d.name) : s.notes.add(d.name);
  return true;
}
