// Regression: Mass Properties section (material -> mass, centre of gravity, inertia). Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
import { chromium } from 'playwright';

const log = (m) => console.log(`[mass] ${m}`);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // Default 50 x 50 x 50 mm box placed on the ground plane.
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  const cv = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(cv.x + cv.width / 2, cv.y + cv.height / 2);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tree-node .node-label').length > 2, { timeout: 120000 });
  await page.waitForTimeout(500);
  await page.locator('.tree-node:has(.delete-toggle) .node-label').first().click();
  await page.waitForTimeout(400);

  const rows = async () => {
    const out = {};
    for (const r of await page.locator('.prop-section:has(.section-title:text("Mass Properties")) .prop-row').all()) {
      const label = (await r.locator('.prop-label').textContent()).trim();
      const el = r.locator('.prop-value');
      if (await el.count()) out[label] = (await el.first().textContent()).trim();
    }
    return out;
  };
  const num = (s) => parseFloat(s.replace(/[^0-9.eE+\-]/g, ''));
  // Masses are shown as kg, g or mg; convert to kg.
  const kg = (s) => (/ mg$/.test(s) ? num(s) / 1e6 : / g$/.test(s) ? num(s) / 1e3 : num(s));
  const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b);
  const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); log('OK: ' + msg); };

  const none = await rows();
  log('no material: ' + JSON.stringify(none));
  check(!('Mass' in none) && 'Centroid' in none, 'without a material only the centroid is shown');

  const select = page.locator('.prop-select');
  await select.selectOption('steel-a36');
  await page.waitForTimeout(400);
  const steel = await rows();
  log('steel: ' + JSON.stringify(steel));
  const mSteel = kg(steel['Mass']);
  check(near(mSteel, 0.98125, 0.001), `steel 50 mm cube mass = ${mSteel} kg (expected 0.981 kg)`);
  check(near(num(steel['Ixx']), (0.98125 * 50 * 50) / 6, 0.005), `Ixx = ${steel['Ixx']} (expected ~408.9 kg·mm²)`);
  check(num(steel['Ixy']) === 0 && num(steel['Iyz']) === 0, 'products of inertia are exactly 0 for a cube (noise suppressed)');

  await select.selectOption('aluminium-6061-t6');
  await page.waitForTimeout(400);
  const alu = await rows();
  check(near(kg(alu['Mass']), 0.98125 * (2700 / 7850), 0.001), `aluminium mass = ${alu['Mass']} (expected 0.3375 kg)`);

  // Move the body +400 mm in X: the center of gravity must follow it.
  const cgBefore = alu['Center of gravity'];
  await page.evaluate(() => {
    const vp = window.ng.getComponent(document.querySelector('app-viewport'));
    const body = vp.tree.getBodyForNodeId(vp.selection.state().selectedNodeId);
    body.mesh.position.x += 400; body.mesh.updateMatrixWorld(true);
    body.boundingBox = body.mesh.geometry.boundingBox.clone().applyMatrix4(body.mesh.matrixWorld);
    vp.property.refreshIfSelected(body);
  });
  await page.waitForTimeout(400);
  const cgAfter = (await rows())['Center of gravity'];
  log(`CoG before move: ${cgBefore}  after +400 mm X: ${cgAfter}`);
  check(near(num(cgAfter.split(',')[0]), num(cgBefore.split(',')[0]) + 400, 0.001), 'center of gravity follows a moved body');

  // Undo the last material change (aluminium -> steel), then again (steel -> none).
  await page.locator('canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.locator('.tree-node:has(.delete-toggle) .node-label').first().click();
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  const afterUndo = await rows();
  log('after undo: ' + JSON.stringify(afterUndo));
  check(!('Mass' in afterUndo), 'undo removes the material assignment (mass hidden again)');
} catch (e) {
  log('FAILED: ' + String(e).slice(0, 400));
  process.exitCode = 1;
} finally {
  log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`);
  if (errs.length) process.exitCode = 1;
  await browser.close();
}
