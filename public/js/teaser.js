// Pantalla "Muy pronto" para las páginas de clientes (inicio, para llevar, desde casa y mesas).
// Se prende y apaga en Panel → Ajustes → Página web ("Modo Muy pronto"). Mientras no se apague,
// está prendida. Para ver la página real sin apagarla: tacosjosue.mx/?ver=todo
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, configured, esc } from "./common.js";

const root = document.documentElement;
const origTitle = document.title;
const ICON = {
  ig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
  tt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 3c.3 2.2 1.7 3.8 4 4v3.1c-1.5 0-2.9-.4-4-1.1v6.3A5.7 5.7 0 1 1 10.8 9.7v3.2a2.6 2.6 0 1 0 2.6 2.6V3h3.1z"/></svg>',
  fb: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 8V6.5c0-.7.2-1.2 1.3-1.2H17V2.2c-.3 0-1.4-.2-2.6-.2C11.8 2 10.5 3.6 10.5 6.3V8H8v3.4h2.5V22H14V11.4h2.7L17 8h-3z"/></svg>',
  sp: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M7 9.5c3.5-1 7.5-.7 10.5 1M7.5 12.6c3-.8 6.2-.5 8.8.9M8 15.5c2.4-.6 4.9-.4 7 .7" stroke="#1db954" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>'
};
const DEFAULT_IG = "https://www.instagram.com/tacos.josue/";
const DEFAULT_TT = "https://www.tiktok.com/@tacos.josue";
const DEFAULT_QUOTE = "Sin tacos no hay paraíso 🌮";

const link = (cls, href, icon, label) => `<a class="tz-btn ${cls}" href="${esc(href)}" target="_blank" rel="noopener">${icon}<span>${label}</span></a>`;

function render(site = {}) {
  let box = document.getElementById("teaser");
  if (!box) { box = document.createElement("div"); box.id = "teaser"; document.body.prepend(box); }
  const ig = site.instagram || DEFAULT_IG, tt = site.tiktok || DEFAULT_TT;
  const more = [tt && link("tz-tt", tt, ICON.tt, "TikTok"), site.facebook && link("tz-fb", site.facebook, ICON.fb, "Facebook")].filter(Boolean);
  box.innerHTML = `
    <div class="tz-flags" aria-hidden="true">${"<span></span>".repeat(9)}</div>
    <span class="tz-float" style="left:6%;top:22%" aria-hidden="true">🌮</span>
    <span class="tz-float" style="right:8%;top:38%;animation-delay:2s" aria-hidden="true">🌶️</span>
    <span class="tz-float" style="left:10%;bottom:18%;animation-delay:4s" aria-hidden="true">🍋</span>
    <main class="tz-in">
      <div class="tz-brand">Tacos <b>Josué</b></div>
      <div class="tz-fire" aria-hidden="true">🔥</div>
      <span class="tz-eyebrow">Algo grande se está cocinando…</span>
      <h1 class="tz-title">Muy pronto<span>nueva actualización</span></h1>
      <p class="tz-sub">Estamos preparando algo que va a cambiar tu forma de pedir tacos. Calientito, rápido y con todo. 🤫</p>
      <div class="tz-hints" aria-label="Pistas"><span>📱 ¿Desde tu cel?</span><span>⏱️ ¿Sin filas?</span><span>🎁 ¿Sorpresas?</span></div>
      <div class="tz-load"><span>Preparando la salsa…</span><div class="tz-bar"><i></i></div></div>
      <section class="tz-card">
        <h2>Mientras tanto, síguenos 👇</h2>
        <p>En Instagram te enteras primero de <strong>ofertas, descuentos y promociones</strong> antes que nadie.</p>
        ${link("tz-ig", ig, ICON.ig, "Seguir en Instagram")}
      </section>
      ${more.length ? `<section class="tz-card"><h2>Más contenido</h2><p>Detrás del trompo, retos y antojos.</p>
        <div class="tz-row ${more.length === 1 ? "one" : ""}">${more.join("")}</div></section>` : ""}
      ${site.spotify ? `<section class="tz-card"><h2>🎧 La playlist de la taquería</h2><p>Lo que suena mientras sale el pastor.</p>
        ${link("tz-sp", site.spotify, ICON.sp, "Escuchar en Spotify")}</section>` : ""}
      <p class="tz-quote">${esc(site.slogan || DEFAULT_QUOTE)}</p>
      <p class="tz-small">tacosjosue.mx</p>
    </main>`;
  document.title = "Tacos Josué · Muy pronto";
}

function hide() {
  root.classList.remove("cs");
  if (document.title === "Tacos Josué · Muy pronto") document.title = origTitle;
  document.getElementById("teaser")?.remove();
}

if (root.classList.contains("cs")) {
  render();
  if (configured) {
    onSnapshot(doc(db, "config", "shop"), (s) => {
      const site = (s.exists() && s.data().site) || {};
      if (site.comingSoon === false) hide(); else render(site);
    }, () => {});
  }
}
