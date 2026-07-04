import assert from 'node:assert/strict';
import test from 'node:test';
import { auditElements } from './audit.js';
import type { AuditElement, DesignTokens } from '../types.js';

const tokens: DesignTokens = {
  colors: { bg: '#0d0d0f', text: '#f2f2f2', accent: '#e0653a' },
  fonts: { sans: 'Inter, sans-serif', mono: 'JetBrains Mono, monospace' },
  typeScale: [12, 14, 16, 20],
  spacing: [4, 8, 12, 16],
  radii: [6, 10],
};

const context = { pageId: 'home', viewport: 'desktop' };

function element(styles: Record<string, string>, selector = 'main > div'): AuditElement {
  return {
    selector,
    tag: 'div',
    label: 'Sample',
    box: { x: 0, y: 0, width: 100, height: 40 },
    styles,
  };
}

test('clean elements produce no findings', () => {
  const findings = auditElements(
    [
      element({
        color: '#f2f2f2',
        backgroundColor: '#0d0d0f',
        fontSize: '14px',
        fontFamily: 'Inter, sans-serif',
        borderRadius: '6px',
        paddingTop: '8px',
      }),
    ],
    tokens,
    context,
  );
  assert.deepEqual(findings, []);
});

test('off-palette colors are flagged with the nearest token', () => {
  const findings = auditElements([element({ color: '#3366ff' })], tokens, context);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'off-palette-color');
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].pageId, 'home');
  assert.equal(findings[0].viewport, 'desktop');
  assert.ok(findings[0].expected.includes('nearest token'));
});

test('near-token colors within tolerance pass', () => {
  const findings = auditElements([element({ color: '#0e0e10' })], tokens, context);
  assert.deepEqual(findings, []);
});

test('off-scale font sizes and radii are flagged', () => {
  const findings = auditElements(
    [element({ fontSize: '18px', borderRadius: '3px' })],
    tokens,
    context,
  );
  const rules = findings.map((finding) => finding.rule).sort();
  assert.deepEqual(rules, ['off-scale-font-size', 'off-scale-radius']);
});

test('pill radii are a deliberate idiom and pass', () => {
  const findings = auditElements([element({ borderRadius: '9999px' })], tokens, context);
  assert.deepEqual(findings, []);
});

test('unknown font families are flagged, system stacks are skipped', () => {
  const flagged = auditElements(
    [element({ fontFamily: '"Comic Sans MS", cursive' })],
    tokens,
    context,
  );
  assert.equal(flagged[0]?.rule, 'unknown-font-family');
  const system = auditElements([element({ fontFamily: 'system-ui, sans-serif' })], tokens, context);
  assert.deepEqual(system, []);
});

test('allowlist suppresses findings by selector and by property/value', () => {
  const allowTokens: DesignTokens = {
    ...tokens,
    allowlist: [{ selector: '.chart' }, { property: 'color', value: '#3366ff' }],
  };
  const bySelector = auditElements(
    [element({ color: '#00ff00' }, 'main .chart svg')],
    allowTokens,
    context,
  );
  assert.deepEqual(bySelector, []);
  const byValue = auditElements([element({ color: '#3366ff' })], allowTokens, context);
  assert.deepEqual(byValue, []);
  const stillFlagged = auditElements([element({ color: '#00ff00' })], allowTokens, context);
  assert.equal(stillFlagged.length, 1);
});

test('findings are capped per rule', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    element({ color: '#3366ff' }, `main > div:nth-child(${i})`),
  );
  const findings = auditElements(many, tokens, context);
  assert.equal(findings.length, 25);
});
