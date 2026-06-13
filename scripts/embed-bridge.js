/**
 * Bridge validator.
 * The bridge JS is embedded into the binary via Rust include_str! —
 * this script just confirms the file exists before building.
 */
const fs   = require('fs');
const path = require('path');

const bridgePath = path.join(__dirname, '..', 'frontend', 'launcher-bridge.js');

if (!fs.existsSync(bridgePath)) {
  console.error('❌  frontend/launcher-bridge.js not found.');
  process.exit(1);
}
const content = fs.readFileSync(bridgePath, 'utf8');
if (content.trim().length < 100) {
  console.error('❌  launcher-bridge.js appears empty or corrupt.');
  process.exit(1);
}
console.log(`✅  launcher-bridge.js OK (${content.length} chars)`);
