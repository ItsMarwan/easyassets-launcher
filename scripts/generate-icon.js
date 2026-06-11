const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico');

const sourcePath = path.join(__dirname, '..', 'favicon.png');
const targetPath = path.join(__dirname, '..', 'favicon.ico');

(async () => {
  try {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source favicon not found at ${sourcePath}`);
    }

    const buffer = await pngToIco(sourcePath);

    const buildDir = path.join(__dirname, '..', 'build');
    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir);
    }

    const targetPathBuild = path.join(buildDir, 'favicon.ico');
    fs.writeFileSync(targetPath, buffer);
    fs.writeFileSync(targetPathBuild, buffer);
    console.log(`Generated icon at ${targetPath}`);
    console.log(`Generated icon at ${targetPathBuild}`);
  } catch (error) {
    console.error('Failed to generate ICO file:', error);
    process.exit(1);
  }
})();
