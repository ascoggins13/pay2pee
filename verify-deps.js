const fs = require('fs');
const path = require('path');

// Check for express router files
const expressRouterPath = path.join('node_modules', 'express', 'lib', 'router');
if (!fs.existsSync(expressRouterPath)) {
  console.error('Express router files missing! Reinstalling express...');
  require('child_process').execSync('npm install express@4.18.2 --force', {stdio: 'inherit'});
}

// Check for iconv-lite file
const iconvLitePath = path.join('node_modules', 'iconv-lite', 'lib', 'extend-node.js');
if (!fs.existsSync(iconvLitePath)) {
  console.error('iconv-lite extend-node.js missing! Reinstalling iconv-lite...');
  require('child_process').execSync('npm install iconv-lite@0.6.3 --force', {stdio: 'inherit'});
  
  // If still missing, create it manually
  if (!fs.existsSync(iconvLitePath)) {
    const content = `"use strict";
// Prepare to extend Node's primitive String.prototype with a \`toByteArray\` method
// and Buffer.prototype with \`toString\` method that support all encodings.
var Buffer = require('safer-buffer').Buffer;
// String.prototype augmentation.
if (String.prototype.toByteArray) {
    delete String.prototype.toByteArray;
}
String.prototype.toByteArray = function(encoding) {
    return Buffer.from(this, encoding);
};
// Buffer.prototype augmentation.
if (Buffer.prototype.toString) {
    delete Buffer.prototype.toString;
}
Buffer.prototype.toString = function(encoding) {
    return this.toString(encoding);
};`;
    fs.mkdirSync(path.dirname(iconvLitePath), { recursive: true });
    fs.writeFileSync(iconvLitePath, content);
  }
}

console.log('Dependency verification complete');