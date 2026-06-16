module.exports = {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'frontend-must-not-import-sidecar',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^sidecar/src/' },
    },
    {
      name: 'sidecar-must-not-import-frontend',
      severity: 'error',
      from: { path: '^sidecar/src/' },
      to: { path: '^src/' },
    },
    {
      name: 'frontend-must-use-bridge-not-electron-internals',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^electron/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^dist/|^sidecar/dist/|\\.test\\.(ts|tsx)$)' },
    tsPreCompilationDeps: false,
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
    },
  },
};
