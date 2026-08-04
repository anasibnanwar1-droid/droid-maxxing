import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrCommentBody, prCommentPreview } from './prCommentPresentation';

test('normalizes GitHub details markup and removes Cubic machine metadata', () => {
  const body = `<!-- cubic:review-summary:start -->
**1 issue found** across 11 files
<!-- cubic:review-summary:end -->
<details><summary>Prompt for AI Agents (unresolved issues)</summary>

\`\`\`text
<file name="src/review.ts">
Fix this issue.
</file>
\`\`\`
</details>
<sub>You're on the cubic free plan. [Upgrade for unlimited reviews](https://example.test)<br />Re-trigger cubic</sub>
<!-- cubic:review-post:opaque-id -->`;

  const normalized = normalizePrCommentBody(body);

  assert.match(normalized, /\*\*1 issue found\*\*/);
  assert.match(normalized, /\*\*Prompt for AI Agents \(unresolved issues\)\*\*/);
  assert.match(normalized, /```text/);
  assert.doesNotMatch(normalized, /<!--|<details|<summary|<\/details>|<sub|cubic free plan/);
});

test('preview returns the first readable line without markdown decoration', () => {
  const normalized = normalizePrCommentBody(
    '<!-- marker -->\n**1 issue found** across 11 files\n\n```text\nlong details\n```',
  );

  assert.equal(prCommentPreview(normalized), '1 issue found across 11 files');
});

test('ordinary GitHub markdown remains intact', () => {
  const body = 'Please preserve **this decision**.\n\n- First\n- Second';
  assert.equal(normalizePrCommentBody(body), body);
});
