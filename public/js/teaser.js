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
const DEFAULT_QUOTE = "Navidad sin tacos… no es Navidad 🎄🌮";

const link = (cls, href, icon, label) => `<a class="tz-btn ${cls}" href="${esc(href)}" target="_blank" rel="noopener">${icon}<span>${label}</span></a>`;

function render(site = {}) {
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
      <div class="tz-fire tz-mascot" aria-hidden="true"><svg viewBox="0 0 220 190" width="190" height="164">
        <ellipse cx="110" cy="178" rx="72" ry="8" fill="#000" opacity=".25"/>
        <path d="M44 120 q8 -26 28 -20 q10 -24 30 -12 q14 -22 34 -6 q18 -18 34 2 q16 -6 22 18 Z" fill="#b5442a"/>
        <path d="M50 120 q8 -16 22 -12 q10 -16 26 -6 q14 -14 28 -2 q14 -10 28 4 q12 -2 16 16 Z" fill="#e0602a"/>
        <circle cx="74" cy="104" r="7" fill="#3ccf6e"/><circle cx="118" cy="94" r="6" fill="#3ccf6e"/><circle cx="160" cy="104" r="7" fill="#3ccf6e"/>
        <circle cx="96" cy="108" r="5" fill="#fff8ee"/><circle cx="140" cy="104" r="5" fill="#fff8ee"/>
        <path d="M24 170 A86 86 0 0 1 196 170 Z" fill="#f2b33d"/>
        <path d="M24 170 A86 86 0 0 1 196 170" fill="none" stroke="#c98a2b" stroke-width="8"/>
        <path d="M44 150 q14 6 26 0 M150 150 q14 6 26 0" stroke="#e0a030" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>
        <g class="tz-face"><circle cx="92" cy="136" r="6" fill="#2a1a10"/><circle cx="128" cy="136" r="6" fill="#2a1a10"/><circle cx="94.5" cy="133.5" r="2" fill="#fff"/><circle cx="130.5" cy="133.5" r="2" fill="#fff"/>
          <path d="M99 148 q11 10 22 0" stroke="#2a1a10" stroke-width="4" fill="none" stroke-linecap="round"/>
          <ellipse cx="78" cy="148" rx="8" ry="4.5" fill="#ff7a7a" opacity=".55"/><ellipse cx="142" cy="148" rx="8" ry="4.5" fill="#ff7a7a" opacity=".55"/></g>
        <g class="tz-hat">
          <path d="M58 100 C64 58 96 26 134 30 C162 34 178 56 178 70 C162 60 142 60 130 70 C122 78 118 90 116 100 Z" fill="#e11d2e"/>
          <path d="M134 30 C156 34 176 52 178 70 C168 62 156 58 142 60 Z" fill="#b3121f"/>
          <circle cx="182" cy="74" r="13" fill="#fff8ee"/>
          <rect x="48" y="92" width="80" height="18" rx="9" fill="#fff8ee" transform="rotate(-8 88 101)"/>
        </g>
        <g transform="translate(30 132) rotate(-25)"><path d="M0 0 q10 -12 22 -2 q-10 4 -8 14 q-12 -4 -14 -12z" fill="#2e8b57"/><path d="M0 0 q-12 -10 -22 2 q10 2 10 14 q10 -6 12 -16z" fill="#2e8b57"/><circle cx="0" cy="2" r="5" fill="#e11d2e"/><circle cx="7" cy="-2" r="4" fill="#e11d2e"/></g>
        <path class="tz-spark" d="M26 44 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4z" fill="#ffd257"/>
        <path class="tz-spark" style="animation-delay:.8s" d="M198 116 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3 l7 -3z" fill="#ffd257"/>
      </svg></div>
      <span class="tz-eyebrow">🎄 Esta Navidad algo grande se está cocinando…</span>
      <h1 class="tz-title">Muy pronto<span>un regalo para ti</span></h1>
      <p class="tz-sub">Santa nos pidió algo especial y lo estamos envolviendo con salsa y cebollita: una nueva forma de pedir tus tacos. Calientito, rápido y con todo. 🤫</p>
      <div class="tz-hints" aria-label="Pistas"><span>📱 ¿Desde tu cel?</span><span>⏱️ ¿Sin filas?</span><span>🎁 ¿Regalos?</span></div>
      <div class="tz-load"><span>Envolviendo el regalo… 🎁</span><div class="tz-bar"><i></i></div></div>
      <section class="tz-card">
        <h2>Mientras tanto, síguenos 👇</h2>
        <p>En Instagram te enteras primero de <strong>ofertas, descuentos y promociones navideñas</strong> antes que nadie.</p>
        ${link("tz-ig", ig, ICON.ig, "Seguir en Instagram")}
      </section>
      ${more.length ? `<section class="tz-card"><h2>Más contenido</h2><p>Detrás del trompo, retos y antojos navideños.</p>
        <div class="tz-row ${more.length === 1 ? "one" : ""}">${more.join("")}</div></section>` : ""}
      ${site.spotify ? `<section class="tz-card"><h2>🎧 La playlist de la taquería</h2><p>El soundtrack perfecto para tus tacos de temporada 🎄</p>
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
