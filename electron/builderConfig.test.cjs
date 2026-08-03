const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = require.resolve('../electron-builder.config.cjs');
const appleEnvironmentKeys = [
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

function loadConfig(environment) {
  const previous = new Map(appleEnvironmentKeys.map((key) => [key, process.env[key]]));
  for (const key of appleEnvironmentKeys) delete process.env[key];
  Object.assign(process.env, environment);
  delete require.cache[configPath];
  try {
    return require(configPath);
  } finally {
    delete require.cache[configPath];
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('unsigned mac builds never attempt notarization', () => {
  const config = loadConfig({
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'password',
    APPLE_TEAM_ID: 'TEAMID',
  });

  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
});

test('signed mac builds enable notarization when every credential is present', () => {
  const config = loadConfig({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAMID)',
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'password',
    APPLE_TEAM_ID: 'TEAMID',
  });

  assert.equal(config.mac.notarize, true);
});
