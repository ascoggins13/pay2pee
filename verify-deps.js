const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dependenciesToVerify = [
  {
    name: 'express',
    files: [
      'lib/router/index.js',
      'lib/router/layer.js',
      'lib/router/route.js'
    ]
  },
  {
    name: 'iconv-lite',
    files: [
      'lib/extend-node.js'
    ]
  },
  {
    name: 'mongoose',
    files: [
      'lib/drivers/node-mongodb-native/bulkWriteResult.js',
      'lib/drivers/node-mongodb-native/collection.js'
    ]
  }
];

function verifyDependency(dep) {
  let allFilesExist = true;
  
  dep.files.forEach(file => {
    const fullPath = path.join('node_modules', dep.name, file);
    if (!fs.existsSync(fullPath)) {
      console.error(`Missing file: ${fullPath}`);
      allFilesExist = false;
    }
  });

  if (!allFilesExist) {
    console.log(`Reinstalling ${dep.name}...`);
    try {
      execSync(`npm install ${dep.name}@${require('./package.json').dependencies[dep.name]} --force`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`Failed to reinstall ${dep.name}:`, err);
    }
  }
}

console.log('Verifying all critical dependencies...');
dependenciesToVerify.forEach(verifyDependency);
console.log('Dependency verification complete');