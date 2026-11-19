// Revisa el estado de la base de datos con la llave de servicio y, si el menú está vacío, lo carga.
// No imprime datos de clientes; solo conteos y ajustes.
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const OWNER = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: process.env.PROJECT_ID });
const db = admin.firestore();

(async () => {
  console.log("=== Estado de la base de datos ===");
  // Usuario dueño en Authentication
  try {
    const u = await admin.auth().getUserByEmail(OWNER);
    console.log(`Usuario dueño (${OWNER}): existe${u.disabled ? " pero está DESACTIVADO" : ""}. Proveedores: ${u.providerData.map((p) => p.providerId).join(", ") || "ninguno"}`);
  } catch (e) {
    console.log(`Usuario dueño (${OWNER}): NO EXISTE en Authentication (${e.code || e.message})`);
    try {
      const list = await admin.auth().listUsers(10);
      console.log(`Usuarios registrados: ${list.users.length} -> ${list.users.map((x) => x.email).join(", ")}`);
    } catch (e2) { console.log("No se pudo listar usuarios: " + (e2.code || e2.message)); }
  }

  // Los empleados entran de forma anónima (con QR + PIN): hay que tener activado ese tipo de acceso
  try {
    const token = (await admin.credential.applicationDefault().getAccessToken()).access_token;
    const base = `https://identitytoolkit.googleapis.com/admin/v2/projects/${process.env.PROJECT_ID}/config`;
    const cur = await fetch(base, { headers: { Authorization: "Bearer " + token } }).then((r) => r.json());
    const anon = cur && cur.signIn && cur.signIn.anonymous && cur.signIn.anonymous.enabled;
    if (anon) console.log("Acceso de empleados (anónimo): activado");
    else {
      const r = await fetch(base + "?updateMask=signIn.anonymous.enabled", {
        method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ signIn: { anonymous: { enabled: true } } })
      });
      console.log(r.ok ? "Acceso de empleados (anónimo): lo activé" : "No pude activar el acceso de empleados: " + r.status + " " + (await r.text()).slice(0, 200));
    }
  } catch (e) { console.log("No pude revisar el acceso de empleados: " + e.message); }

  const staff = await db.doc("staffConfig/main").get();
  console.log("PIN de empleados: " + (staff.exists && staff.data().pin ? "configurado" : "falta (ponlo en Panel → Ajustes)"));

  const cfg = await db.doc("config/shop").get();
  if (cfg.exists) {
    const c = cfg.data();
    const closed = c.closedUntil && c.closedUntil.toDate() > new Date();
    console.log(`Ajustes: nombre="${c.name}", cerrado hoy=${closed ? "SÍ" : "no"}, domicilio=${c.deliveryOn === false ? "apagado" : "activo"}, mesas=${c.tables}, CLABE=${c.clabe ? "configurada" : "falta"}`);
  } else console.log("Ajustes: todavía no se guardan (se usan los de fábrica)");

  const products = await db.collection("products").get();
  console.log(`Productos: ${products.size}`);
  const orders = await db.collection("orders").count().get();
  const tables = await db.collection("tables").count().get();
  console.log(`Pedidos guardados: ${orders.data().count} · Mesas con cuenta: ${tables.data().count}`);

  // Mesas abiertas con el sistema anterior (sin sesión secreta): se liberan para que se puedan usar
  const openTables = await db.collection("tables").where("status", "==", "abierta").get();
  for (const t of openTables.docs) {
    const secret = await db.doc("tableSecrets/" + t.id).get();
    if (!secret.exists) {
      await t.ref.set({ status: "cerrada", closedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log(`Mesa ${t.id}: estaba abierta con el sistema anterior, la liberé.`);
    }
  }
  // Cuentas abiertas con la versión de "una cuenta por mesa": se pasan al formato de varias cuentas
  const oldSecrets = await db.collection("tableSecrets").get();
  for (const sdoc of oldSecrets.docs) {
    const { session, key, openedAt } = sdoc.data();
    if (!session) continue;
    const tab = await db.doc("tabs/" + session).get();
    const already = await db.doc("tabSecrets/" + session).get();
    if (tab.exists && !tab.data().closed && !already.exists) {
      await db.doc("tabSecrets/" + session).set({ table: sdoc.id, key: key || "", openedAt: openedAt || admin.firestore.FieldValue.serverTimestamp() });
      console.log("Mesa " + sdoc.id + ": cuenta abierta convertida al formato de varias cuentas.");
    }
  }
  const keys = await db.collection("tableKeys").count().get();
  console.log(`Claves de QR de mesas creadas: ${keys.data().count}`);

  // Resumen de mesas (sin datos de clientes): estado, sesión abreviada y rondas
  const allTables = await db.collection("tables").get();
  for (const t of allTables.docs) {
    const d = t.data();
    const sec = await db.doc("tableSecrets/" + t.id).get();
    const sess = sec.exists ? sec.data().session : null;
    let rounds = 0;
    let tabInfo = "sin cuenta";
    if (sess) {
      const tab = await db.doc("tabs/" + sess).get();
      rounds = (await db.collection("tabs/" + sess + "/rounds").count().get()).data().count;
      tabInfo = tab.exists ? "cuenta " + (tab.data().closed ? "cerrada" : "abierta") + ", código " + tab.data().code : "cuenta no encontrada";
    }
    const legacy = "session" in d ? " (campo viejo)" : "";
    console.log("Mesa " + t.id + ": " + d.status + legacy + " · sesión " + (sess ? sess.slice(0, 4) + "…" : "ninguna") + " · " + tabInfo + " · rondas: " + rounds);
  }
  const since = new Date(Date.now() - 6 * 3600e3);
  const recent = await db.collection("orders").where("createdAt", ">=", since).get();
  const mesaOrders = recent.docs.map((x) => x.data()).filter((o) => o.type === "mesa");
  console.log("Rondas de mesa en las últimas 6 h: " + mesaOrders.length);
  mesaOrders.forEach((o) => console.log("  - mesa " + o.table + " · sesión " + String(o.session || "").slice(0, 4) + "… · " + o.status + " · total " + o.total));

  if (products.size === 0) {
    const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "menu-tacos-josue.json"), "utf8"));
    const batch = db.batch();
    menu.products.forEach(([name, price, category], i) => {
      const data = { name, price, category, description: "", available: true, order: i };
      if (menu.withMeats.includes(name)) data.options = menu.meats;
      batch.set(db.collection("products").doc(), data);
    });
    await batch.commit();
    console.log(`El menú estaba vacío: cargué ${menu.products.length} productos de Tacos Josué.`);
  }
})().catch((e) => { console.log("Error revisando la base de datos: " + (e.code || "") + " " + e.message); process.exitCode = 1; });
