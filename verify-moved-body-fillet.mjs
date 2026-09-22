// Regression: a Move-gizmo transform must survive a kernel replace-in-place (Fillet). Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
// Check 1: is a gizmo-style move of a body honoured by the kernel when the body is later filleted?
import { chromium } from 'playwright';
import path from 'path';
const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');
const log = (m) => console.log(`[moved] ${m}`);

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByText('Open STEP…').click();
  await page.locator('input.hidden-file-input').setInputFiles(STEP_FILE);
  await page.waitForFunction(() => { const el = document.querySelector('[class*=status]'); return el && !el.textContent.includes('0 bodies'); }, { timeout: 120000 });
  await page.waitForTimeout(1500);

  const rows = page.locator('.tree-node:has(.delete-toggle)');
  const labels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  const propText = async () => (await page.locator('.prop-row').allTextContents()).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => /Position|Min|Max|Volume|Faces/.test(s));

  // Select Body 1, hide every other body so the picker can only hit Body 1.
  await labels.first().click(); await page.waitForTimeout(300);
  const n = await rows.count();
  for (let i = 1; i < n; i++) { await rows.nth(i).locator('.visibility-toggle').click(); await page.waitForTimeout(60); }
  await labels.first().click(); await page.waitForTimeout(300);
  log('BEFORE move: ' + JSON.stringify(await propText()));

  // Same effect as a committed gizmo Move drag (ObjectTransformService.commitDrag's apply()): mutate mesh.position
  // (view-level transform), refresh world bbox + panels.
  const moved = await page.evaluate(() => {
    const vp = window.ng.getComponent(document.querySelector('app-viewport'));
    const nodeId = vp.selection.state().selectedNodeId;
    const body = vp.tree.getBodyForNodeId(nodeId);
    body.mesh.position.x += 400;
    body.mesh.updateMatrixWorld(true);
    if (body.mesh.geometry.boundingBox) body.boundingBox = body.mesh.geometry.boundingBox.clone().applyMatrix4(body.mesh.matrixWorld);
    vp.property.refreshIfSelected(body);
    vp.selection.refreshHighlightTransform(vp.selection.state().selectedBodyId);
    return { nodeId, px: body.mesh.position.x };
  });
  log('moved: ' + JSON.stringify(moved));
  await page.waitForTimeout(400);
  await page.keyboard.press('f'); await page.waitForTimeout(700);
  const afterMove = await propText();
  log('AFTER move (pre-fillet): ' + JSON.stringify(afterMove));

  // Fillet a picked edge on the (moved) Body 1.
  const panel = page.locator('.fillet-chamfer-panel');
  await page.getByRole('button', { name: 'Fillet / Chamfer', exact: true }).click(); await page.waitForTimeout(300);
  const cv = await page.locator('canvas').first().boundingBox();
  let picked = null;
  outer: for (let gy = 0.25; gy <= 0.8; gy += 0.04) for (let gx = 0.25; gx <= 0.8; gx += 0.04) {
    const x = cv.x + cv.width * gx, y = cv.y + cv.height * gy;
    await page.mouse.move(x, y); await page.waitForTimeout(30);
    await page.mouse.click(x, y); await page.waitForTimeout(100);
    if (await panel.locator('.pick-list li').count() >= 1) { picked = [Math.round(x), Math.round(y)]; break outer; }
  }
  log('edge pick at ' + JSON.stringify(picked));
  if (!picked) throw new Error('no edge could be picked on moved body');
  await panel.locator('.pick-list .edge-value-input').first().fill('2');
  await panel.locator('.extrude-btn', { hasText: 'Apply Fillet' }).click();
  const closed = await page.waitForFunction(() => !document.querySelector('.fillet-chamfer-panel'), { timeout: 90000 }).then(() => true).catch(() => false);
  log('fillet applied, panel closed: ' + closed + (closed ? '' : ' err=' + await panel.locator('.error').textContent().catch(() => '?')));

  await labels.first().click(); await page.waitForTimeout(400);
  const afterFillet = await propText();
  log('AFTER fillet: ' + JSON.stringify(afterFillet));
  const posInfo = await page.evaluate(() => {
    const vp = window.ng.getComponent(document.querySelector('app-viewport'));
    const body = vp.tree.getBodyForNodeId(vp.selection.state().selectedNodeId);
    return { meshPosX: body.mesh.position.x, bboxMinX: body.boundingBox.min.x, bboxMaxX: body.boundingBox.max.x };
  });
  log('mesh/bbox after fillet: ' + JSON.stringify(posInfo));
  if (posInfo.meshPosX !== 400) throw new Error('moved body snapped back after Fillet (meshPosX=' + posInfo.meshPosX + ')');
  log('OK: move survived the fillet');
} catch (e) { log('FAILED: ' + String(e).slice(0, 500)); process.exitCode = 1; }
finally { log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`); await browser.close(); }
