// Regression: Delete is an undoable step (2026-09-24). Deletes a STEP body, then checks that
// Ctrl+Z puts back the SAME tree node (same id, same position among its siblings, STEP-source
// flag intact) and the same mesh in the scene, that Ctrl+Y deletes it again, and that the restored
// part still works as a kernel target (a Hole Wizard hole cut into it removes real material).
// Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
// CONTROL=1 skips the delete/undo steps (the same hole on a never-deleted part, for comparison);
// SHOT=<path> saves a screenshot if the face pick fails.
import { chromium } from 'playwright';
import path from 'path';

const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');
const log = (m) => console.log(`[delete-undo] ${m}`);
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); log('OK: ' + msg); };

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver loop/.test(m.text())) errs.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByText('Open STEP…').click();
  await page.locator('input.hidden-file-input').setInputFiles(STEP_FILE);
  await page.waitForFunction(() => { const el = document.querySelector('[class*=status]'); return el && !el.textContent.includes('0 bodies'); }, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  // Snapshot of the tree + scene, read straight from the services the viewport holds.
  const snapshot = () => page.evaluate(() => {
    const vp = window.ng.getComponent(document.querySelector('app-viewport'));
    const body = vp.tree.nodes()[0].children[0].children;
    return {
      nodeIds: body.map((n) => n.id),
      stepFlags: body.map((n) => n.hasStepSource),
      bodyCount: vp.tree.allBodies().length,
      sceneCount: vp.viewer.getBodyGroup().children.length,
      meshesMapped: vp.tree.allBodies().every((b) => vp.tree.getNodeIdForMesh(b.mesh) !== undefined)
    };
  });

  const before = await snapshot();
  log(`before: ${before.bodyCount} bodies, ${before.sceneCount} meshes in scene`);
  const victimIndex = 2;
  const victimId = before.nodeIds[victimIndex];

  const labels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  if (!process.env.CONTROL) {
  await labels.nth(victimIndex).click();
  await page.waitForTimeout(300);
  await page.locator('canvas').first().hover();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(600);
  const afterDelete = await snapshot();
  check(afterDelete.bodyCount === before.bodyCount - 1 && afterDelete.sceneCount === before.sceneCount - 1, 'Delete removes the part from the tree and the scene');
  check(!afterDelete.nodeIds.includes(victimId), 'the deleted node is gone');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  const afterUndo = await snapshot();
  check(afterUndo.bodyCount === before.bodyCount && afterUndo.sceneCount === before.sceneCount, 'Ctrl+Z restores the part to the tree and the scene');
  check(JSON.stringify(afterUndo.nodeIds) === JSON.stringify(before.nodeIds), 'the restored node has the same id and the same position among its siblings');
  check(JSON.stringify(afterUndo.stepFlags) === JSON.stringify(before.stepFlags), 'STEP-source flags are unchanged');
  check(afterUndo.meshesMapped, 'every body mesh maps back to its node (picking works)');

  await page.keyboard.press('Control+y');
  await page.waitForTimeout(600);
  const afterRedo = await snapshot();
  check(afterRedo.bodyCount === before.bodyCount - 1 && !afterRedo.nodeIds.includes(victimId), 'Ctrl+Y deletes it again');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  const afterUndo2 = await snapshot();
  check(JSON.stringify(afterUndo2.nodeIds) === JSON.stringify(before.nodeIds) && afterUndo2.sceneCount === before.sceneCount, 'a second Ctrl+Z restores it again, unchanged');
  }

  // The restored part must still be a usable kernel target: re-reading its STEP source works only
  // if its node id, parent import and hasStepSource flag all came back intact.
  const vol = async () => {
    await labels.nth(victimIndex).click();
    await page.waitForTimeout(400);
    return parseFloat((await page.locator('.prop-row', { hasText: 'Volume' }).textContent()).replace(/[^0-9.\-]/g, ''));
  };
  await labels.nth(victimIndex).click(); await page.waitForTimeout(300);
  await page.mouse.click(700, 400, { button: 'right' }); await page.waitForTimeout(300);
  await page.getByText('Isolate').click(); await page.waitForTimeout(500);
  await page.keyboard.press('f'); await page.waitForTimeout(700);
  const v0 = await vol();

  await page.getByRole('button', { name: 'Hole Wizard', exact: true }).click();
  await page.waitForTimeout(300);
  // Click the projected top-center of the part's own bounding box (a blind scan around the canvas
  // center misses thin parts — see architecture.md's 2026-09-22 test-infrastructure notes).
  const canvasBox = await page.locator('canvas').first().boundingBox();
  const target = await page.evaluate((nodeId) => {
    const vp = window.ng.getComponent(document.querySelector('app-viewport'));
    const bb = vp.tree.getBodyForNodeId(nodeId).boundingBox;
    const cam = vp.camera.getActiveCamera();
    const p = cam.position.clone().set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z).project(cam);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }, victimId);
  const px = canvasBox.x + target.x * canvasBox.width, py = canvasBox.y + target.y * canvasBox.height;
  const phase = () => page.evaluate(() => window.ng.getComponent(document.querySelector('app-viewport')).holeWizard.state().phase);
  await page.mouse.click(px, py);
  await page.waitForTimeout(400);
  const picked = (await phase()) === 'picking-point';
  if (picked) {
    // Picking the face animates the camera to look straight at it — wait for that, then click the
    // face's own origin re-projected through the settled camera.
    await page.waitForTimeout(1500);
    const c = await page.evaluate(() => {
      const vp = window.ng.getComponent(document.querySelector('app-viewport'));
      const o = vp.holeWizard.state().facePlane.origin;
      const cam = vp.camera.getActiveCamera();
      const p = cam.position.clone().set(o[0], o[1], o[2]).project(cam);
      return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
    });
    await page.mouse.click(canvasBox.x + c.x * canvasBox.width, canvasBox.y + c.y * canvasBox.height);
  }
  if (!picked && process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  check(picked, 'Hole Wizard can pick a face on the restored part');
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-viewport')).holeWizard.state().phase === 'configuring', null, { timeout: 15000 });
  await page.locator('.hole-wizard-panel .extrude-btn', { hasText: 'Apply Hole' }).click();
  const closed = await page.waitForFunction(() => !document.querySelector('.hole-wizard-panel'), null, { timeout: 60000 }).then(() => true).catch(() => false);
  if (!closed) throw new Error('Hole Wizard on the restored part failed: ' + (await page.locator('.hole-wizard-panel .error').textContent().catch(() => '?')));
  await page.waitForTimeout(600);
  const v1 = await vol();
  log(`restored part volume ${v0} → ${v1} after a hole`);
  check(v1 < v0 - 1, 'a hole cut into the restored part removes real material (its STEP source still resolves)');
} catch (e) {
  log('FAILED: ' + String(e).slice(0, 500));
  process.exitCode = 1;
} finally {
  log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4))}`);
  if (errs.length) process.exitCode = 1;
  await browser.close();
}
