// Página web pública: menú en vivo, horario, ubicación, contacto y redes (todo se edita en el panel).
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, configured, $, esc, money, DEFAULT_CONFIG, isClosed, withinHours, hoursText, DAY_NAMES } from "./common.js";
import { isOut, optionsOf, hasOptions, promoLabels } from "./cart.js";

const state = { config: { ...DEFAULT_CONFIG }, products: [], cat: "Todo" };
const cur = () => state.config.currency || "$";

function renderInfo() {
  const c = state.config, site = c.site || {};
  const name = c.name || "Tacos Josué";
  document.title = `${name} · Taquería`;
  $("shopName").textContent = name;
  $("footName").textContent = name;
  if (site.tagline) $("tagline").textContent = site.tagline;
  const open = !isClosed(c) && withinHours(c);
  $("openNow").textContent = open ? "Abierto ahora" : "Cerrado en este momento";
  $("openNow").classList.toggle("is-open", open);
  $("hoursLine").textContent = hoursText(c) || "";

  // Horario de la semana
  const h = c.hours;
  $("hoursTable").innerHTML = h
    ? DAY_NAMES.map((d, i) => { const x = h[String(i)] || {}; return `<div class="${new Date().getDay() === i ? "today" : ""}"><span>${d}</span><span class="mono">${x.off || !x.open ? "Cerrado" : `${esc(x.open)} – ${esc(x.close)}`}</span></div>`; }).join("")
    : "";

  if (site.address) {
    $("address").textContent = site.address;
    const q = encodeURIComponent(site.address);
    const btn = $("mapsBtn"); btn.hidden = false; btn.href = site.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${q}`;
    const box = $("mapBox"); box.hidden = false;
    if (!box.dataset.q || box.dataset.q !== q) { box.dataset.q = q; box.innerHTML = `<iframe title="Mapa" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${q}&output=embed"></iframe>`; }
  }

  const contact = [];
  if (site.whatsapp) { const n = String(site.whatsapp).replace(/\D/g, ""); contact.push(`<a class="btn-main" href="https://wa.me/${n.length === 10 ? "52" + n : n}" target="_blank" rel="noopener">WhatsApp</a>`); }
  if (site.phone) contact.push(`<a class="btn-alt dark" href="tel:${esc(String(site.phone).replace(/[^\d+]/g, ""))}">Llamar ${esc(site.phone)}</a>`);
  if (c.googleReviewUrl) contact.push(`<a class="btn-alt dark" href="${esc(c.googleReviewUrl)}" target="_blank" rel="noopener">★ Déjanos tu reseña en Google</a>`);
  $("contact").innerHTML = contact.join("") || '<p class="muted">Pide en línea con los botones de arriba.</p>';
  const links = [["instagram", "Instagram"], ["facebook", "Facebook"], ["tiktok", "TikTok"], ["google", "Reseñas en Google"]]
    .filter(([k]) => site[k] || (k === "google" && c.googleReviewUrl))
    .map(([k, l]) => `<a href="${esc(k === "google" ? c.googleReviewUrl : site[k])}" target="_blank" rel="noopener">${l}</a>`);
  $("social").innerHTML = links.join("");

  if (site.about) { $("about").hidden = false; $("aboutText").textContent = site.about; }
  // El envío depende de que haya repartidor ese día: se prende y apaga en el panel (Domicilio)
  const zonesTxt = c.zones && c.zones.length ? ` a ${c.zones.map((z) => z.name).slice(0, 6).join(", ")}${c.zones.length > 6 ? " y más" : ""}` : "";
  $("howCasa").textContent = c.deliveryOn
    ? `Envío${zonesTxt}, sujeto a disponibilidad. O pasa a recoger. Pagas antes por transferencia.`
    : `Hoy no tenemos envíos${zonesTxt ? " (llevamos" + zonesTxt + " cuando hay repartidor)" : ""}. Pide y pasa a recoger. Pagas antes por transferencia.`;
  $("casaBtn").textContent = c.deliveryOn ? "Pedir a domicilio" : "Pedir y recoger";

  const promos = promoLabels(c);
  $("promoBand").hidden = !promos.length;
  $("promoBand").textContent = promos.length ? "Hoy: " + promos.join(" · ") : "";
}

function renderMenu() {
  const products = [...state.products].sort((a, b) => (b.popular ? 1 : 0) - (a.popular ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0));
  if (!products.length) { $("menuList").innerHTML = '<p class="muted">Pronto verás nuestro menú aquí.</p>'; return; }
  const cats = ["Todo", ...new Set(state.products.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((p) => p.category || "Otros"))];
  $("menuCats").innerHTML = cats.map((c) => `<button data-cat="${esc(c)}" class="${c === state.cat ? "on" : ""}">${esc(c)}</button>`).join("");
  const groups = {};
  products.filter((p) => state.cat === "Todo" || (p.category || "Otros") === state.cat).forEach((p) => (groups[p.category || "Otros"] ||= []).push(p));
  $("menuList").innerHTML = Object.entries(groups).map(([cat, items]) => `<h3 class="menu-cat">${esc(cat)}</h3><div class="menu-grid">${items.map((p) => {
    const out = isOut(p, state.config) || (hasOptions(p) && !optionsOf(p, state.config).length);
    return `<article class="mcard ${out ? "out" : ""}">${p.photo ? `<img src="${esc(p.photo)}" alt="${esc(p.name)}" loading="lazy">` : ""}
      <div class="mbody"><div class="mrow"><h4>${esc(p.name)}</h4><span class="price">${money(p.price, cur())}</span></div>
      ${p.popular ? '<span class="tag pop">Lo más pedido</span>' : ""}${out ? '<span class="out-tag">Agotado hoy</span>' : ""}
      ${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}
      ${hasOptions(p) ? `<p class="muted small">De: ${esc(p.options.join(", ").toLowerCase())}</p>` : ""}</div></article>`;
  }).join("")}</div>`).join("");
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-cat]");
  if (b) { state.cat = b.dataset.cat; renderMenu(); }
});

renderInfo();
if (configured) {
  onSnapshot(doc(db, "config", "shop"), (s) => { if (s.exists()) state.config = { ...DEFAULT_CONFIG, ...s.data() }; renderInfo(); renderMenu(); }, () => {});
  onSnapshot(collection(db, "products"), (s) => { state.products = s.docs.map((d) => ({ id: d.id, ...d.data() })); renderMenu(); }, () => {});
  setInterval(renderInfo, 60000);
}
