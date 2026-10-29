// Levanta el sitio de pruebas y lo deja corriendo: node scripts/serve-fixture.mjs [puerto]
import { startFixtureSite } from "../tests/fixtures/site.mjs";
const site = await startFixtureSite(Number(process.argv[2] ?? 0));
console.log(site.url);
