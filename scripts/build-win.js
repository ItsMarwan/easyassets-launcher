const childProcess = require('child_process');
const path = require('path');

const launcherRoot = path.resolve(__dirname, '..');
const fs = require('fs');
const rceditPackage = require.resolve('rcedit/package.json', { paths: [launcherRoot] });
const rceditBin = path.join(path.dirname(rceditPackage), 'bin');
if (!fs.existsSync(rceditBin)) {
  console.error('Could not find local rcedit binary directory:', rceditBin);
  process.exit(1);
}
process.env.ELECTRON_BUILDER_RCEDIT_PATH = rceditBin;
console.log('Using ELECTRON_BUILDER_RCEDIT_PATH:', process.env.ELECTRON_BUILDER_RCEDIT_PATH);

const builderCli = require.resolve('electron-builder/cli.js', { paths: [launcherRoot] });
console.log('Building Windows NSIS installer...');
console.log('Installer output directory: dist/installer');
const result = childProcess.spawnSync(process.execPath, [builderCli, '--win', 'nsis', '--x64'], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error('Build failed:', result.error);
  process.exit(1);
}

process.exit(result.status || 0);
