// Rebuilds src/data/us-places.json: every US place in the GeoNames list that all-the-cities carries
// (about 16,700 towns and cities) as [name, state, lat, lng, population], biggest first.
// Run by hand when you want fresh data:  npm install --no-save all-the-cities && node scripts/build-places.mjs
// Data: GeoNames (CC BY 4.0), packaged by all-the-cities (MIT).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const cities = createRequire(import.meta.url)('all-the-cities');
const us = cities
  .filter((c) => c.country === 'US' && /^[A-Z]{2}$/.test(c.adminCode))
  .sort((a, b) => b.population - a.population || (a.name < b.name ? -1 : 1))
  .map((c) => [c.name, c.adminCode, +c.loc.coordinates[1].toFixed(4), +c.loc.coordinates[0].toFixed(4), c.population]);
fs.writeFileSync(new URL('../src/data/us-places.json', import.meta.url), JSON.stringify(us));
console.log(`wrote ${us.length} places`);
