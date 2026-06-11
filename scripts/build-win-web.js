const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, Platform, Arch } = require('electron-builder');

const launcherRoot = path.resolve(__dirname, '..');
const rceditPackage = require.resolve('rcedit/package.json', { paths: [launcherRoot] });
const rceditBin = path.join(path.dirname(rceditPackage), 'bin');
const rceditExe = path.join(rceditBin, 'rcedit.exe');

if (!fs.existsSync(rceditExe)) {
  console.error('Could not find local rcedit executable:', rceditExe);
  process.exit(1);
}

process.env.ELECTRON_BUILDER_RCEDIT_PATH = rceditBin;

const publishUrl = process.env.EASYASSETS_PUBLISH_URL || 'https://easyassets-uefn.vercel.app/download';
console.log('Using publish URL:', publishUrl);
console.log('Building Windows web installer (nsis-web) for EasyAssets...');

build({
  targets: Platform.WINDOWS.createTarget('nsis-web', Arch.x64),
  config: {
    directories: {
      output: path.join(launcherRoot, 'dist', 'installer'),
    },
    nsisWeb: {
      appPackageUrl: publishUrl,
    },
    afterPack: async (context) => {
      const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
      const iconPath = path.join(launcherRoot, 'build', 'favicon.ico');
      if (!fs.existsSync(exePath)) {
        throw new Error(`Expected executable not found: ${exePath}`);
      }
      if (!fs.existsSync(iconPath)) {
        throw new Error(`Expected icon not found: ${iconPath}`);
      }
      console.log(`Embedding icon into ${exePath}`);
      execFileSync(rceditExe, [exePath, '--set-icon', iconPath], { stdio: 'inherit' });
    },
  },
})
  .then(() => {
    console.log('Web installer build complete. Output is in dist/installer.');
  })
  .catch((error) => {
    console.error('Failed to build web installer:', error);
    process.exit(1);
  });
