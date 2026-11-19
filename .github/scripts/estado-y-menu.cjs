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
