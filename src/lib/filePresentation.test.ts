import assert from 'node:assert';
import test from 'node:test';
import { resolveFilePresentation } from './filePresentation';

test('resolves stack file extensions case-insensitively', () => {
  const cases = [
    ['src/App.TSX', { kind: 'react', language: 'tsx' }],
    ['component.jsx', { kind: 'react', language: 'jsx' }],
    ['index.ts', { kind: 'typescript', language: 'typescript' }],
    ['server.MJS', { kind: 'javascript', language: 'javascript' }],
    ['theme.css', { kind: 'css', language: 'css' }],
    ['page.html', { kind: 'html', language: 'markup' }],
    ['README.md', { kind: 'markdown', language: 'markdown' }],
    ['worker.py', { kind: 'python', language: 'python' }],
    ['main.rs', { kind: 'rust', language: 'rust' }],
    ['scripts/release.sh', { kind: 'shell', language: 'bash' }],
  ] as const;

  for (const [filename, expected] of cases) {
    assert.deepEqual(resolveFilePresentation(filename), expected, filename);
  }
});

test('uses the final extension for compound filenames', () => {
  assert.deepEqual(resolveFilePresentation('archive.spec.ts'), {
    kind: 'typescript',
    language: 'typescript',
  });
  assert.deepEqual(resolveFilePresentation('photo.backup.PNG'), { kind: 'image' });
  assert.deepEqual(resolveFilePresentation('release.tar.gz'), { kind: 'archive' });
});

test('special filenames take precedence over their extensions', () => {
  assert.deepEqual(resolveFilePresentation('package.json'), {
    kind: 'package',
    language: 'json',
  });
  assert.deepEqual(resolveFilePresentation('config/tsconfig.build.json'), {
    kind: 'config',
    language: 'json',
  });
  assert.deepEqual(resolveFilePresentation('vite.config.ts'), {
    kind: 'config',
    language: 'typescript',
  });
  assert.deepEqual(resolveFilePresentation('docker-compose.dev.yml'), {
    kind: 'docker',
    language: 'docker',
  });
});

test('handles extensionless names and dotfiles', () => {
  assert.deepEqual(resolveFilePresentation('Dockerfile'), {
    kind: 'docker',
    language: 'docker',
  });
  assert.deepEqual(resolveFilePresentation('README'), {
    kind: 'markdown',
    language: 'markdown',
  });
  assert.deepEqual(resolveFilePresentation('LICENSE'), { kind: 'document' });
  assert.deepEqual(resolveFilePresentation('.env.local'), {
    kind: 'env',
    language: 'bash',
  });
  assert.deepEqual(resolveFilePresentation('.gitignore'), { kind: 'config' });
  assert.deepEqual(resolveFilePresentation('Makefile'), { kind: 'config' });
});

test('groups binary and office formats and falls back for unknown files', () => {
  assert.deepEqual(resolveFilePresentation('design.svg'), {
    kind: 'image',
    language: 'markup',
  });
  assert.deepEqual(resolveFilePresentation('report.PDF'), { kind: 'pdf' });
  assert.deepEqual(resolveFilePresentation('brief.docx'), { kind: 'document' });
  assert.deepEqual(resolveFilePresentation('budget.xlsx'), { kind: 'spreadsheet' });
  assert.deepEqual(resolveFilePresentation('source.7z'), { kind: 'archive' });
  assert.deepEqual(resolveFilePresentation('binary.wasm'), { kind: 'unknown' });
  assert.deepEqual(resolveFilePresentation('no-extension'), { kind: 'unknown' });
});

test('normalizes Windows paths without mutating the input', () => {
  const filename = String.raw`C:\workspace\src\App.tsx`;
  assert.deepEqual(resolveFilePresentation(filename), {
    kind: 'react',
    language: 'tsx',
  });
  assert.equal(filename, String.raw`C:\workspace\src\App.tsx`);
});
