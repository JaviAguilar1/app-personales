// Lee los platos pedidos en Social Lunch y los guarda en Firebase para la app Salud.
// Solo lectura en Social Lunch: no pide, cancela ni cambia nada.
import { chromium } from "playwright";
import admin from "firebase-admin";

const { SL_USER, SL_PASS, OWNER_EMAIL, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DB_URL } = process.env;
const iso = (d) => d.toISOString().slice(0, 10);
const hoy = new Date(Date.now() - 3 * 3600e3); // hora Argentina
const fmtPlato = (s) => s.trim().toLowerCase().replace(/(^|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

async function leerMenu() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("https://app.sociallunch.com.ar/", { waitUntil: "networkidle" });
    const pass = page.locator('input[type="password"]:visible').first();
    await pass.waitFor({ timeout: 20000 });
    const user = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"])').first();
    await user.fill(SL_USER);
    await pass.fill(SL_PASS);
    await pass.press("Enter");
    await page.waitForURL(/event=/, { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle");
    if (await page.locator('input[type="password"]:visible').count()) throw new Error("No se pudo iniciar sesión en Social Lunch (¿cambió la contraseña?).");
    const ini = new Date(hoy); ini.setDate(ini.getDate() - 3);
    const fin = new Date(hoy); fin.setDate(fin.getDate() + 45);
    return await page.evaluate(async ([a, b]) => {
      const url = `index.php?event=directAPI&send_fk_diner=true&DirectAPIEvent=api_get_d_diner_services_and_requests&DirectAPIStep=sf&DirectAPITime=0&DirectAPIResponseType=json&DirectAPIParams%5Binicio%5D=${a}&DirectAPIParams%5Bfin%5D=${b}`;
      const r = await fetch(url, { credentials: "include" }).then((x) => x.json());
      return Object.values(r).flatMap((d) => (d.servicios || []).filter((s) => s.seleccion).map((s) => [s.fecha_key.replace(/_/g, "-"), s.seleccion]));
    }, [iso(ini), iso(fin)]);
  } finally {
    await browser.close();
  }
}

const platos = await leerMenu();
console.log(`Social Lunch: ${platos.length} platos leídos.`);

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)), databaseURL: FIREBASE_DB_URL });
const { uid } = await admin.auth().getUserByEmail(OWNER_EMAIL);
const ref = admin.database().ref(`users/${uid}/salud/menu`);
const actual = (await ref.get()).val() || {};
const hoyS = iso(hoy), nuevos = Object.fromEntries(platos.map(([f, p]) => [f, fmtPlato(p)]));
const updates = {};
let cambios = 0;
for (const [f, p] of Object.entries(nuevos)) {
  if (actual[f]?.plato !== p) { updates[f] = { fecha: f, plato: p }; cambios++; }
}
for (const f of Object.keys(actual)) {
  if (f !== "_meta" && f >= hoyS && !nuevos[f]) { updates[f] = null; cambios++; } // pedido cancelado
}
updates._meta = { actualizado: Date.now(), fuente: "sociallunch" };
await ref.update(updates);
console.log(`Listo: ${cambios} cambios. Menú cubierto hasta ${Object.keys(nuevos).sort().pop() || "—"}.`);
process.exit(0);
