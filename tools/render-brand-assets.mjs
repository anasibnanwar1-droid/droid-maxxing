// Renders the committed brand SVG sources (assets/brand/*.svg) into the raster
// assets the app and installer need:
//   electron/assets/icon.png           1024 master (non-darwin window icon)
//   electron/assets/icon.icns          macOS icon (via iconutil, darwin only)
//   assets/brand/dmg-background.png    DMG window background @1x
//   assets/brand/dmg-background@2x.png DMG window background @2x
//
// Rendering is deterministic: Playwright screenshots the vector source at each
// exact pixel size (no resampling), so small sizes stay crisp. Run after
// editing a brand SVG:  node tools/render-brand-assets.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = path.join(repoRoot, 'assets', 'brand');
const electronAssets = path.join(repoRoot, 'electron', 'assets');

const FONT_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap';

async function renderSvg(browser, svgPath, size, outPath) {
  const svg = readFileSync(svgPath, 'utf8');
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(
      `<!doctype html><html><head>
         <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
         <link href="${FONT_STYLESHEET}" rel="stylesheet" />
         <style>html,body{margin:0;padding:0}svg{display:block;width:100vw;height:100vh}</style>
       </head><body>${svg}</body></html>`,
    );
    await page.waitForLoadState('networkidle');
    await page
      .waitForFunction(() => document.fonts.status === 'loaded', { timeout: 5000 })
      .catch(() => {});
    await page.screenshot({ path: outPath });
  } finally {
    await page.close();
  }
  console.log(`rendered ${path.relative(repoRoot, outPath)} (${size.width}x${size.height})`);
}

const ICONSET_SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

async function main() {
  const browser = await chromium.launch();
  try {
    const iconSvg = path.join(brandDir, 'icon.svg');
    const dmgSvg = path.join(brandDir, 'dmg-background.svg');

    // macOS iconset -> iconutil -> icon.icns (darwin only; other platforms keep
    // the committed .icns).
    const iconsetDir = path.join(electronAssets, 'icon.iconset');
    rmSync(iconsetDir, { recursive: true, force: true });
    mkdirSync(iconsetDir, { recursive: true });
    for (const [name, size] of ICONSET_SIZES) {
      await renderSvg(browser, iconSvg, { width: size, height: size }, path.join(iconsetDir, name));
    }
    if (process.platform === 'darwin') {
      execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(electronAssets, 'icon.icns')], {
        stdio: 'inherit',
      });
      console.log('rendered electron/assets/icon.icns');
      rmSync(iconsetDir, { recursive: true, force: true });
    } else {
      console.log('not darwin: iconset kept at electron/assets/icon.iconset, iconutil skipped');
    }

    // 1024 master PNG (window icon on non-darwin platforms).
    await renderSvg(browser, iconSvg, { width: 1024, height: 1024 }, path.join(electronAssets, 'icon.png'));

    // DMG window background, 1x + 2x (electron-builder picks the @2x up when it
    // sits next to the 1x file).
    await renderSvg(browser, dmgSvg, { width: 600, height: 400 }, path.join(brandDir, 'dmg-background.png'));
    await renderSvg(
      browser,
      dmgSvg,
      { width: 1200, height: 800 },
      path.join(brandDir, 'dmg-background@2x.png'),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
