const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWindowsInstaller } = require('electron-winstaller');

const electronWinstallerPackage = require.resolve('electron-winstaller/package.json');
const vendorDirectory = path.join(path.dirname(electronWinstallerPackage), 'vendor');
const appDirectory = path.join(__dirname, '..', 'dist', 'EasyAssets-win32-x64');
const outputDirectory = path.join(__dirname, '..', 'dist', 'installer');
const iconPath = path.join(__dirname, '..', 'favicon.ico');

function ensure7zVendorFiles() {
  const arch = os.arch();
  const srcExe = path.join(vendorDirectory, `7z-${arch}.exe`);
  const srcDll = path.join(vendorDirectory, `7z-${arch}.dll`);
  const destExe = path.join(vendorDirectory, '7z.exe');
  const destDll = path.join(vendorDirectory, '7z.dll');

  if (!fs.existsSync(destExe) && fs.existsSync(srcExe)) {
    fs.copyFileSync(srcExe, destExe);
  }

  if (!fs.existsSync(destDll) && fs.existsSync(srcDll)) {
    fs.copyFileSync(srcDll, destDll);
  }
}

process.env.PATH = [vendorDirectory, process.env.PATH].filter(Boolean).join(path.delimiter);

console.log('Creating Windows installer from', appDirectory);
console.log('Using vendor directory:', vendorDirectory);

ensure7zVendorFiles();

createWindowsInstaller({
  appDirectory,
  outputDirectory,
  vendorDirectory,
  authors: 'EasyAssets',
  description: 'EasyAssets Launcher installer',
  exe: 'EasyAssets.exe',
  setupExe: 'EasyAssets-Setup.exe',
  setupIcon: iconPath,
  noMsi: true,
  skipUpdateIcon: true,
})
  .then(() => {
    console.log('Windows installer created successfully in', outputDirectory);
  })
  .catch((error) => {
    console.error('Failed to create Windows installer:', error);
    process.exit(1);
  });
