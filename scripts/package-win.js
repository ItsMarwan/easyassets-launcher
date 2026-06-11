const path = require('path');
const Module = require('module');
const packager = require('electron-packager');

const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..', '..');
const launcherNodeModules = path.join(appRoot, 'node_modules');
const workspaceNodeModules = path.join(workspaceRoot, 'node_modules');
const nodePathParts = [process.env.NODE_PATH, launcherNodeModules, workspaceNodeModules].filter(Boolean);
process.env.NODE_PATH = nodePathParts.join(path.delimiter);
Module._initPaths();

const iconPath = path.join(appRoot, 'favicon.ico');
const outDir = path.join(appRoot, 'dist');

console.log('Packaging app from', appRoot);
console.log('Using NODE_PATH:', process.env.NODE_PATH);

packager({
  dir: appRoot,
  out: outDir,
  name: 'EasyAssets',
  platform: 'win32',
  arch: 'x64',
  icon: iconPath,
  overwrite: true,
  asar: true,
  ignore: [ /node_modules\/\.pnpm/, /scripts/, /favicon\.png/ ],
  prune: false,
  derefSymlinks: true,
})
  .then((appPaths) => {
    console.log('Packaged app paths:');
    appPaths.forEach((appPath) => console.log('  ', appPath));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
