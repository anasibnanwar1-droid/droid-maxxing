const process = require('node:process');

if (process.platform !== 'darwin') {
  throw new Error('The DROIDEX Sparkle updater is available only on macOS.');
}

module.exports = require('./build/Release/sparkle_updater.node');
