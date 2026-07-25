const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'nativeBrowserPreload.cjs'), 'utf8');

test('browser inspection routes element text and HTML through sanitizers', () => {
  assert.match(source, /function safeElementText\(/);
  assert.equal(source.match(/cleanText\(el\.innerText \|\| el\.textContent/g)?.length, 1);
  assert.doesNotMatch(source, /html:\s*cleanText\(el\.outerHTML/);
  assert.match(source, /html:\s*cleanText\(sanitizedOuterHtml\(el\)/);
  assert.match(source, /redactedTextTags\.has\(el\.tagName\)/);
});

test('browser inspection covers URL-bearing and executable attributes', () => {
  for (const attribute of [
    'background',
    'cite',
    'data',
    'formaction',
    'itemid',
    'manifest',
    'poster',
    'usemap',
    'xlink:href',
  ]) {
    assert.match(source, new RegExp(`['"]${attribute}['"]`));
  }
  for (const attribute of ['ping', 'srcdoc', 'srcset', 'style']) {
    assert.match(source, new RegExp(`['"]${attribute}['"]`));
  }
  assert.match(source, /isMetaRefreshContent\(name, node\)/);
});

test('select option matching accepts the option label attribute', () => {
  assert.match(source, /cleanText\(item\.label\) === expected/);
});
