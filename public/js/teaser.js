// Pantalla "Muy pronto" para las páginas de clientes (inicio, para llevar, desde casa y mesas).
// Se prende y apaga en Panel → Ajustes → Página web ("Modo Muy pronto"). Mientras no se apague,
// está prendida. Para ver la página real sin apagarla: tacosjosue.mx/?ver=todo
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, configured, esc } from "./common.js";

const root = document.documentElement;
const origTitle = document.title;
const ICON = {
  gm: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6.9 7.5.6-5.7 5 1.7 7.4L12 18l-6.5 3.9 1.7-7.4-5.7-5 7.5-.6z"/></svg>',
  ig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
  tt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 3c.3 2.2 1.7 3.8 4 4v3.1c-1.5 0-2.9-.4-4-1.1v6.3A5.7 5.7 0 1 1 10.8 9.7v3.2a2.6 2.6 0 1 0 2.6 2.6V3h3.1z"/></svg>',
  fb: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 8V6.5c0-.7.2-1.2 1.3-1.2H17V2.2c-.3 0-1.4-.2-2.6-.2C11.8 2 10.5 3.6 10.5 6.3V8H8v3.4h2.5V22H14V11.4h2.7L17 8h-3z"/></svg>',
  sp: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M7 9.5c3.5-1 7.5-.7 10.5 1M7.5 12.6c3-.8 6.2-.5 8.8.9M8 15.5c2.4-.6 4.9-.4 7 .7" stroke="#1db954" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>'
};
const DEFAULT_IG = "https://www.instagram.com/tacos.josue/";
const DEFAULT_TT = "https://www.tiktok.com/@tacos.josue";
const DEFAULT_QUOTE = "Navidad sin tacos… no es Navidad";

const link = (cls, href, icon, label) => `<a class="tz-btn ${cls}" href="${esc(href)}" target="_blank" rel="noopener">${icon}<span>${label}</span></a>`;

function render(site = {}, cfg = {}) {
  let box = document.getElementById("teaser");
  if (!box) { box = document.createElement("div"); box.id = "teaser"; document.body.prepend(box); }
  const ig = site.instagram || DEFAULT_IG, tt = site.tiktok || DEFAULT_TT;
  const more = [tt && link("tz-tt", tt, ICON.tt, "TikTok"), site.facebook && link("tz-fb", site.facebook, ICON.fb, "Facebook")].filter(Boolean);
  box.innerHTML = `
    <div class="tz-snow" aria-hidden="true">${Array.from({ length: 36 }, (_, i) => `<i style="left:${(i * 37) % 100}%;animation-delay:${-((i * 1.7) % 12).toFixed(1)}s;animation-duration:${8 + (i % 6)}s;font-size:${10 + (i % 4) * 5}px">${i % 3 ? "❄" : "•"}</i>`).join("")}</div>
    <div class="tz-lights" aria-hidden="true">${"<span></span>".repeat(14)}</div>
    <span class="tz-float" style="left:6%;top:24%" aria-hidden="true">🎄</span>
    <span class="tz-float" style="right:7%;top:40%;animation-delay:2s" aria-hidden="true">🎁</span>
    <span class="tz-float" style="left:9%;bottom:20%;animation-delay:4s" aria-hidden="true">🌮</span>
    <span class="tz-float" style="right:10%;bottom:30%;animation-delay:6s" aria-hidden="true">⭐</span>
    <main class="tz-in">
      <div class="tz-brand">Tacos <b>Josué</b></div>
      <div class="tz-fire tz-mascot"><img src="/img/mascota/mascota-navidad.svg" alt="Taquín, la mascota de Tacos Josué" width="220" height="195"></div>
      <span class="tz-eyebrow">Esta Navidad algo grande se está cocinando…</span>
      <h1 class="tz-title">Muy pronto<span>un regalo para ti</span></h1>
      <p class="tz-sub">Santa nos pidió algo especial y lo estamos envolviendo con salsa y cebollita: una nueva forma de pedir tus tacos. Calientito, rápido y con todo.</p>
      <div class="tz-hints" aria-label="Pistas"><span>¿Desde tu cel?</span><span>¿Sin filas?</span><span>¿Regalos?</span></div>
      <div class="tz-load"><span>Envolviendo el regalo…</span><div class="tz-bar"><i></i></div></div>
      <section class="tz-card">
        <h2>Mientras tanto, síguenos</h2>
        <p>En Instagram te enteras primero de <strong>ofertas, descuentos y promociones navideñas</strong> antes que nadie.</p>
        ${link("tz-ig", ig, ICON.ig, "Seguir en Instagram")}
      </section>
      ${more.length ? `<section class="tz-card"><h2>Más contenido</h2><p>Detrás del trompo, retos y antojos navideños.</p>
        <div class="tz-row ${more.length === 1 ? "one" : ""}">${more.join("")}</div></section>` : ""}
      ${cfg.googleReviewUrl || site.mapsUrl || site.address ? `<section class="tz-card"><h2>¿Ya probaste nuestros tacos?</h2><p>Cuéntanos qué te parecieron. Tu reseña en Google nos ayuda muchísimo.</p>
        <div class="tz-row ${cfg.googleReviewUrl && (site.mapsUrl || site.address) ? "" : "one"}">
        ${cfg.googleReviewUrl ? link("tz-gr", cfg.googleReviewUrl, ICON.star, "Dejar reseña") : ""}
        ${site.mapsUrl || site.address ? link("tz-gm", site.mapsUrl || "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(site.address), ICON.gm, "Cómo llegar") : ""}
        </div></section>` : ""}
      ${site.spotify ? `<section class="tz-card"><h2>La playlist de la taquería</h2><p>El soundtrack perfecto para tus tacos de temporada</p>
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
      if (site.comingSoon === false) hide(); else render(site, s.data() || {});
    }, () => {});
  }
}
