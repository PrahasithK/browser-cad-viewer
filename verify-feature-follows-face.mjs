// Regression: a feature sketched on a face of an earlier feature must follow that face when the earlier feature is edited
// (a boss stays on top of a block whose depth is edited), and undo must restore the original exactly.
// Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
import { chromium } from 'playwright';

const log = (m) => console.log(`[follows] ${m}`);
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); log('OK: ' + msg); };
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const labels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  const num = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));
  const read = async () => {
    await labels.first().click(); await page.waitForTimeout(400);
    const t = (await page.locator('.prop-row').allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim());
    const max = t.find((s) => s.startsWith('Max')) || '';
    return { vol: num(t.find((s) => s.startsWith('Volume')) || ''), zMax: num(max.split(',')[2] || ''), bodies: await labels.count() };
  };
  const cv = await page.locator('canvas').first().boundingBox();
  const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;
  const panel = page.locator('.sketch-panel');
  const waitDrawing = () => page.waitForFunction(() => {
    const h = document.querySelector('.sketch-panel .hint');
    return h && /Click (first corner|center|start point)/.test(h.textContent || '');
  });

  // F1: block, rectangle on XY, extrude 20
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await panel.locator('.plane-btn', { hasText: 'XY' }).click();
  await waitDrawing();
  await page.mouse.click(cx - 120, cy - 60); await page.waitForTimeout(150);
  await page.mouse.click(cx + 120, cy + 60); await page.waitForTimeout(300);
  await panel.locator('input[type=number]').first().fill('20');
  await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
  await page.waitForFunction(() => !document.querySelector('.sketch-panel'));
  await page.waitForTimeout(600);
  const block = await read();
  log('block (20 mm): ' + JSON.stringify(block));

  // F2: boss on the top face. Pick the face, then WAIT for the camera to settle before drawing.
  await page.getByRole('button', { name: 'Sketch', exact: true }).click(); await page.waitForTimeout(300);
  let picked = false;
  outer: for (let dy = -120; dy <= 60; dy += 12) for (let dx = -160; dx <= 160; dx += 16) {
    await page.mouse.click(cx + dx, cy + dy); await page.waitForTimeout(250);
    const n = await page.evaluate(() => { const s = window.ng.getComponent(document.querySelector('app-viewport')).sketch.state(); return s.phase === 'drawing' && s.facePlane ? s.facePlane.normal : null; });
    if (n && n[2] > 0.9) { picked = true; break outer; }
    if (n) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); await page.getByRole('button', { name: 'Sketch', exact: true }).click(); await page.waitForTimeout(300); }
  }
  check(picked, 'top face picked');
  await waitDrawing();
  await page.waitForTimeout(2500);
  await page.mouse.click(cx - 25, cy - 15); await page.waitForTimeout(150);
  await page.mouse.click(cx + 25, cy + 15); await page.waitForTimeout(300);
  await panel.locator('input[type=number]').first().fill('10');
  await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
  await page.waitForFunction(() => !document.querySelector('.sketch-panel'));
  await page.waitForTimeout(800);
  const withBoss = await read();
  log('block + boss: ' + JSON.stringify(withBoss));
  check(withBoss.bodies === 1 && withBoss.zMax > 29.9 && withBoss.zMax < 30.1, 'boss fused onto the block (one body, top at 30 mm)');
  const bossVolume = withBoss.vol - block.vol;
  check(bossVolume > 100, `boss has volume (${bossVolume.toFixed(0)} mm³)`);

  // Edit F1 depth 20 -> 60 in the Feature Tree.
  await page.getByRole('button', { name: 'Feature Tree', exact: true }).click(); await page.waitForTimeout(300);
  const ft = page.locator('.feature-tree-panel');
  await ft.locator('.feature-row-btn').first().dblclick(); await page.waitForTimeout(300);
  const form = ft.locator('.feature-edit-form');
  await form.locator('input[type=number]').first().fill('60');
  await form.locator('.extrude-btn', { hasText: 'Apply' }).click();
  await page.waitForFunction(() => !document.querySelector('.feature-tree-panel .feature-edit-form'));
  await page.waitForTimeout(1000);
  const edited = await read();
  log('after editing the block to 60 mm: ' + JSON.stringify(edited));
  check(edited.zMax > 69.9 && edited.zMax < 70.1, `the boss followed the top face (top at ${edited.zMax} mm, expected 70)`);
  const expected = block.vol * 3 + bossVolume;
  check(Math.abs(edited.vol - expected) / expected < 0.001, `volume = 60 mm block + boss (${edited.vol.toFixed(0)} vs ${expected.toFixed(0)})`);

  // Undo the edit: everything returns to the 20 mm block with the boss on top.
  await page.keyboard.press('Control+z'); await page.waitForTimeout(3000);
  const undone = await read();
  log('after undo: ' + JSON.stringify(undone));
  check(Math.abs(undone.vol - withBoss.vol) < 1 && Math.abs(undone.zMax - withBoss.zMax) < 0.01, 'undo restores the original block and boss exactly');
} catch (e) {
  log('FAILED: ' + String(e).slice(0, 500));
  process.exitCode = 1;
} finally {
  log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`);
  if (errs.length) process.exitCode = 1;
  await browser.close();
}
