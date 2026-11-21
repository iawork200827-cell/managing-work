// Mascota original de Tacos Josué, dibujada a mano en vectores (SVG).
const fs = require('fs');
const C = { shell: '#f2b33d', shellDark: '#c98a2b', meat: '#b5442a', meat2: '#e0602a', green: '#3ccf6e', cream: '#fff8ee', ink: '#2a1a10', red: '#e11d2e', redDark: '#b3121f', blush: '#ff7a7a', glove: '#ffffff' };
const filling = `
  <path d="M104 262 q10 -40 42 -32 q14 -36 46 -18 q22 -34 52 -8 q26 -26 50 6 q22 -8 30 26 Z" fill="${C.meat}"/>
  <path d="M112 262 q12 -26 34 -20 q14 -24 40 -10 q20 -22 42 -4 q22 -16 44 6 q18 -2 24 26 Z" fill="${C.meat2}"/>
  <circle cx="138" cy="236" r="11" fill="${C.green}"/><circle cx="196" cy="216" r="10" fill="${C.green}"/><circle cx="262" cy="232" r="11" fill="${C.green}"/>
  <circle cx="168" cy="242" r="7" fill="${C.cream}"/><circle cx="232" cy="236" r="7" fill="${C.cream}"/>`;
const shell = `
  <path d="M86 330 A114 114 0 0 1 314 330 Z" fill="${C.shell}"/>
  <path d="M86 330 A114 114 0 0 1 314 330" fill="none" stroke="${C.shellDark}" stroke-width="10" stroke-linejoin="round"/>
  <path d="M86 330 L314 330" stroke="${C.shellDark}" stroke-width="10" stroke-linecap="round"/>
  <circle cx="122" cy="306" r="4" fill="${C.shellDark}" opacity=".45"/><circle cx="282" cy="300" r="4" fill="${C.shellDark}" opacity=".45"/><circle cx="270" cy="318" r="3" fill="${C.shellDark}" opacity=".45"/>`;
const legs = `
  <path d="M172 330 L166 368" stroke="${C.ink}" stroke-width="9" stroke-linecap="round"/>
  <path d="M228 330 L234 368" stroke="${C.ink}" stroke-width="9" stroke-linecap="round"/>
  <path d="M140 376 q0 -16 26 -14 q18 2 18 14 Z" fill="${C.red}"/><path d="M140 376 h44" stroke="${C.cream}" stroke-width="6" stroke-linecap="round"/>
  <path d="M216 376 q0 -12 18 -14 q26 -2 26 14 Z" fill="${C.red}"/><path d="M216 376 h44" stroke="${C.cream}" stroke-width="6" stroke-linecap="round"/>`;
const eyes = {
  normal: `<circle cx="172" cy="284" r="11" fill="${C.ink}"/><circle cx="228" cy="284" r="11" fill="${C.ink}"/><circle cx="176" cy="279" r="4" fill="#fff"/><circle cx="232" cy="279" r="4" fill="#fff"/>`,
  wink: `<circle cx="172" cy="284" r="11" fill="${C.ink}"/><circle cx="176" cy="279" r="4" fill="#fff"/><path d="M216 286 q12 -10 24 0" stroke="${C.ink}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  happy: `<path d="M160 288 q12 -14 24 0" stroke="${C.ink}" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M216 288 q12 -14 24 0" stroke="${C.ink}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  wow: `<circle cx="172" cy="282" r="13" fill="${C.ink}"/><circle cx="228" cy="282" r="13" fill="${C.ink}"/><circle cx="177" cy="276" r="5" fill="#fff"/><circle cx="233" cy="276" r="5" fill="#fff"/>`
};
const mouths = {
  smile: `<path d="M184 302 q16 14 32 0" stroke="${C.ink}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  open: `<path d="M182 300 q18 26 36 0 Z" fill="${C.ink}"/><path d="M190 310 q10 8 20 0" fill="${C.red}"/>`,
  o: `<ellipse cx="200" cy="308" rx="8" ry="10" fill="${C.ink}"/>`
};
const blush = `<ellipse cx="150" cy="302" rx="12" ry="6" fill="${C.blush}" opacity=".55"/><ellipse cx="250" cy="302" rx="12" ry="6" fill="${C.blush}" opacity=".55"/>`;
const glove = (x, y) => `<circle cx="${x}" cy="${y}" r="15" fill="${C.glove}" stroke="${C.ink}" stroke-width="5"/>`;
const arm = (d) => `<path d="${d}" stroke="${C.ink}" stroke-width="9" fill="none" stroke-linecap="round"/>`;
const arms = {
  down: arm('M96 300 q-26 14 -30 40') + glove(64, 344) + arm('M304 300 q26 14 30 40') + glove(336, 344),
  wave: arm('M96 300 q-26 14 -30 40') + glove(64, 344) + arm('M304 296 q36 -16 44 -70') + glove(350, 218) +
        `<path d="M372 196 q10 8 8 20 M380 180 q16 12 12 32" stroke="${C.ink}" stroke-width="4" fill="none" stroke-linecap="round" opacity=".6"/>`,
  thumbs: arm('M96 300 q-26 14 -30 40') + glove(64, 344) + arm('M304 300 q34 -2 46 -26') + glove(352, 266) +
        `<rect x="345" y="230" width="14" height="28" rx="7" fill="${C.glove}" stroke="${C.ink}" stroke-width="5"/>`,
  up: arm('M98 296 q-36 -20 -40 -76') + glove(58, 214) + arm('M302 296 q36 -20 40 -76') + glove(342, 214),
  sign: arm('M100 304 q-10 -30 10 -70') + glove(112, 232) + arm('M300 304 q10 -30 -10 -70') + glove(288, 232)
};
const hat = `<g transform="rotate(-10 200 230)">
  <path d="M128 236 Q140 160 214 140 Q270 128 300 160 Q306 172 298 182 Q276 168 258 176 Q242 186 248 236 Z" fill="${C.red}"/>
  <path d="M214 140 Q270 128 300 160 Q306 172 298 182 Q284 166 262 166 Q240 150 214 140 Z" fill="${C.redDark}"/>
  <circle cx="300" cy="188" r="17" fill="${C.cream}"/>
  <rect x="116" y="224" width="146" height="28" rx="14" fill="${C.cream}"/></g>`;
const sparkle = (x, y, s = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 -16 L4 -4 L16 0 L4 4 L0 16 L-4 4 L-16 0 L-4 -4 Z" fill="#ffd257"/>`;
const sign = `<g transform="rotate(-4 200 170)"><rect x="92" y="120" width="216" height="90" rx="14" fill="${C.cream}" stroke="${C.ink}" stroke-width="6"/>
  <text x="200" y="160" text-anchor="middle" font-family="Inter Display Black, Inter, sans-serif" font-weight="900" font-size="26" fill="${C.red}">¡MUY PRONTO!</text>
  <text x="200" y="192" text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="20" fill="${C.ink}">Tacos Josué</text></g>`;

function taco({ eye = 'normal', mouth = 'smile', arm = 'down', extra = '', front = '' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 56 388 344" width="1080" height="1080">
  <ellipse cx="200" cy="384" rx="110" ry="10" fill="#000" opacity=".12"/>
  ${extra}${legs}${filling}${shell}${eyes[eye]}${mouths[mouth]}${blush}${arms[arm]}${front}</svg>`;
}
const poses = {
  'saludo': taco({ arm: 'wave', mouth: 'open' }),
  'enamorado': taco({ arm: 'down', eye: 'happy', mouth: 'smile', extra: `<path transform="translate(300 150) scale(1.3)" d="M0 8 C-14 -6 -10 -20 0 -12 C10 -20 14 -6 0 8 Z" fill="${C.red}"/><path transform="translate(96 170) scale(.9)" d="M0 8 C-14 -6 -10 -20 0 -12 C10 -20 14 -6 0 8 Z" fill="${C.red}"/>` }),
  'celebra': taco({ arm: 'up', eye: 'happy', mouth: 'open', extra: sparkle(60, 150) + sparkle(340, 140, .8) + sparkle(320, 70, .6) }),
  'sorpresa': taco({ eye: 'wow', mouth: 'o', arm: 'down', extra: `<text x="300" y="150" font-family="Inter, sans-serif" font-weight="900" font-size="70" fill="${C.red}">!</text>` }),
  'muy-pronto': taco({ arm: 'sign', eye: 'wink', front: sign }),
  'navidad': taco({ arm: 'wave', mouth: 'open', front: hat, extra: sparkle(70, 160) + sparkle(340, 110, .7) }),
};
for (const [n, svg] of Object.entries(poses)) fs.writeFileSync(`mascota-${n}.svg`, svg);
fs.writeFileSync('hoja.html', `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff8ee;font-family:Inter,sans-serif">
<div id="sheet" style="width:1500px;padding:40px;box-sizing:border-box;background:#0b2a1d;color:#fff8ee">
<h1 style="margin:0 0 6px;font-size:54px;font-weight:900">Taquín <span style="color:#ffd257">· la mascota de Tacos Josué</span></h1>
<p style="margin:0 0 24px;font-size:22px;opacity:.8">Personaje original, dibujado en vectores. Colores: tortilla #f2b33d · pastor #e0602a · cilantro #3ccf6e · chile #e11d2e</p>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">
${Object.keys(poses).map(n => `<div style="background:#fff8ee;border-radius:24px;padding:10px;text-align:center;color:#2a1a10"><img src="mascota-${n}.svg" style="width:100%;height:auto"><div style="font-weight:800;font-size:24px;margin:-10px 0 10px">${n.replace('-', ' ')}</div></div>`).join('')}
</div></div></body>`);
