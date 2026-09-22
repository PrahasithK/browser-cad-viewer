// Regression: a face-sketch cut on a MOVED body must cut where the body is now (previously a silent no-op). Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
// Check 4: after one sketch-cut on an imported STEP body, can a SECOND cut / Hole Wizard / Fillet act on the same body?
import { chromium } from 'playwright';
import path from 'path';
const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');
const log = (m) => console.log(`[2cuts] ${m}`);
const num = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByText('Open STEP…').click();
  await page.locator('input.hidden-file-input').setInputFiles(STEP_FILE);
  await page.waitForFunction(() => { const el = document.querySelector('[class*=status]'); return el && !el.textContent.includes('0 bodies'); }, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const labels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  const vol = page.locator('.prop-row', { hasText: 'Volume' });
  const readVol = async () => { await labels.first().click(); await page.waitForTimeout(400); return num(await vol.textContent()); };

  await labels.first().click(); await page.waitForTimeout(300);
  await page.mouse.click(700, 400, { button: 'right' }); await page.waitForTimeout(300);
  await page.getByText('Isolate').click(); await page.waitForTimeout(500);
  await page.keyboard.press('f'); await page.waitForTimeout(600);
  const cv = await page.locator('canvas').first().boundingBox();
  const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;
  const v0 = await readVol();
  await page.evaluate(() => {
    const vp = window.ng.getComponent(document.querySelector('app-viewport'));
    const body = vp.tree.getBodyForNodeId(vp.selection.state().selectedNodeId);
    body.mesh.position.x += 400; body.mesh.updateMatrixWorld(true);
    body.boundingBox = body.mesh.geometry.boundingBox.clone().applyMatrix4(body.mesh.matrixWorld);
    vp.property.refreshIfSelected(body);
  });
  await page.keyboard.press('f'); await page.waitForTimeout(800);
  log('body moved +400 X before cutting');
  log('volume before any cut: ' + v0);

  const panel = page.locator('.sketch-panel');
  async function sketchCut(px, py, half, label) {
    await page.getByRole('button', { name: 'Sketch', exact: true }).click(); await page.waitForTimeout(300);
    await page.mouse.click(px, py);
    const ok = await page.waitForFunction(() => { const h = document.querySelector('.sketch-panel .hint'); return h && /Click (first corner|center|start point)/.test(h.textContent || ''); }, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!ok) { log(`${label}: face pick failed: ` + await panel.locator('.error').textContent().catch(() => '(no error text)')); await page.keyboard.press('Escape'); return { picked: false }; }
    await page.waitForTimeout(2500); await page.mouse.click(cx - half, cy - half); await page.waitForTimeout(150);
    await page.mouse.click(cx + half, cy + half); await page.waitForTimeout(300);
    await panel.locator('input[type=number]').first().fill('60');
    await panel.locator('.field.checkbox input[type=checkbox]').first().check();
    await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
    const closed = await page.waitForFunction(() => !document.querySelector('.sketch-panel'), { timeout: 90000 }).then(() => true).catch(() => false);
    const err = closed ? null : await panel.locator('.error').textContent().catch(() => null);
    if (!closed) await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    return { picked: true, closed, err };
  }

  const r1 = await sketchCut(cx, cy, 30, 'cut #1'); const v1 = await readVol();
  log(`cut #1: ${JSON.stringify(r1)} volume ${v0} -> ${v1} (delta ${(v1 - v0).toFixed(1)})`);
  const after = await page.evaluate(() => { const vp = window.ng.getComponent(document.querySelector('app-viewport')); const b = vp.tree.getBodyForNodeId(vp.selection.state().selectedNodeId); return { posX: b.mesh.position.x, minX: b.boundingBox.min.x }; });
  log('after cut: ' + JSON.stringify(after));
  if (!(v1 < v0 - 1000)) throw new Error('cut on a moved body removed nothing (' + v0 + ' -> ' + v1 + ')');
  if (after.posX !== 400) throw new Error('moved body snapped back after the cut');
  log('OK: cut removed material and the body stayed put');
} catch (e) { log('FAILED: ' + String(e).slice(0, 500)); process.exitCode = 1; }
finally { log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`); await browser.close(); }
