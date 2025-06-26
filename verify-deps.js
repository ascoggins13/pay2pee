const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const criticalFiles = {
  mongoose: 'lib/drivers/node-mongodb-native/bulkWriteResult.js',
  'iconv-lite': 'lib/extend-node.js'
};

Object.entries(criticalFiles).forEach(([pkg, filePath]) => {
  const fullPath = path.join('node_modules', pkg, filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing ${fullPath}`);
    console.log(`Attempting to download ${pkg} file...`);
    try {
      execSync(`mkdir -p ${path.dirname(fullPath)}`);
      execSync(`curl -o ${fullPath} https://raw.githubusercontent.com/${pkg === 'mongoose' ? 'Automattic/mongoose' : 'ashtuchkin/iconv-lite'}/${require('./package.json').dependencies[pkg]}/${filePath}`);
    } catch (err) {
      console.error(`Failed to restore ${fullPath}:`, err);
      process.exit(1);
    }
  }
});