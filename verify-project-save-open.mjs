// Regression: Save Project / Open Project (2026-09-24).
// Builds a small document (STEP import, a Hole Wizard hole edited to a counterbore in the Feature
// Tree, a renamed and recolored part, a moved part), saves it with Ctrl+S, RELOADS the page, opens
// the saved file, and checks that:
//   (1) the tree, body ids, names, colors, transforms and volumes all match what was saved;
//   (2) the Feature Tree rows came back, and editing the hole back to a simple hole restores the
//       pre-counterbore volume — proof the worker's feature history was rebuilt, not just the meshes;
//   (3) a new hole cut into a never-modified imported part removes material — proof the STEP
//       source was restored for kernel re-reads;
//   (4) the undo stack starts empty.
// Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';

const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');
const log = (m) => console.log(`[project] ${m}`);
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); log('OK: ' + msg); };
const num = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
const savedPath = path.join(os.tmpdir(), `verify-project-${Date.now()}.cadproj`);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver loop/.test(m.text())) errs.push('console: ' + m.text()); });
  page.on('dialog', (d) => { errs.push('dialog: ' + d.message()); d.accept(); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByText('Open STEP…').click();
  await page.locator('input.hidden-file-input').setInputFiles(STEP_FILE);
  await page.waitForFunction(() => { const el = document.querySelector('[class*=status]'); return el && !el.textContent.includes('0 bodies'); }, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const labels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  const readVol = async (i) => { await labels.nth(i).click(); await page.waitForTimeout(400); return num(await page.locator('.prop-row', { hasText: 'Volume' }).textContent()); };

  // ---- Hole in Body 1 (the same scan-for-a-face approach verify-hole-wizard-feature-tree.mjs uses).
  await labels.first().click(); await page.waitForTimeout(300);
  await page.mouse.click(700, 400, { button: 'right' }); await page.waitForTimeout(300);
  await page.getByText('Isolate').click(); await page.waitForTimeout(500);
  await page.keyboard.press('f'); await page.waitForTimeout(700);
  const v0 = await readVol(0);
  const box = await page.locator('canvas').first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.getByRole('button', { name: 'Hole Wizard', exact: true }).click();
  await page.waitForTimeout(300);
  let picked = false;
  outer: for (let dy = -80; dy <= 80; dy += 15) for (let dx = -100; dx <= 100; dx += 20) {
    await page.mouse.click(cx + dx, cy + dy);
    if ((await page.evaluate(() => window.ng.getComponent(document.querySelector('app-viewport')).holeWizard.state().phase)) === 'picking-point') { picked = true; break outer; }
    await page.waitForTimeout(80);
  }
  check(picked, 'picked a face on Body 1');
  await page.waitForTimeout(400);
  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-viewport')).holeWizard.state().phase === 'configuring', null, { timeout: 15000 });
  await page.locator('.hole-wizard-panel .extrude-btn', { hasText: 'Apply Hole' }).click();
  await page.waitForFunction(() => !document.querySelector('.hole-wizard-panel'), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const vSimple = await readVol(0);
  check(vSimple < v0 - 1, 'hole cut into Body 1');

  // Edit it to a counterbore (a shallow one — this plate is ~5 mm thick).
  await page.getByRole('button', { name: 'Feature Tree', exact: true }).click();
  await page.waitForTimeout(300);
  const ft = page.locator('.feature-tree-panel');
  await ft.locator('.feature-row-btn').first().dblclick();
  const form = ft.locator('.feature-edit-form');
  await form.locator('select').first().selectOption('counterbore');
  await form.locator('input[type=number]').nth(2).fill('2');
  await form.locator('.extrude-btn', { hasText: 'Apply' }).click();
  await page.waitForFunction(() => !document.querySelector('.feature-tree-panel .feature-edit-form'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const vCbore = await readVol(0);
  check(vCbore < vSimple - 1, 'the edit to a counterbore removed more material');

  // Show everything again, then rename + recolor Body 2 and move Body 4 (through the same services the UI calls).
  await page.mouse.click(700, 400, { button: 'right' }); await page.waitForTimeout(300);
  await page.getByText('Show All').click(); await page.waitForTimeout(300);
  await page.evaluate(() => {
    const v = window.ng.getComponent(document.querySelector('app-viewport'));
    const entries = v.tree.bodyEntries();
    v.tree.renameNode(entries[1].nodeId, 'Renamed Bracket');
    v.property.setColor(entries[1].body, '#ff8800');
    const moved = entries[3].body.mesh;
    moved.position.set(12.5, -40, 7);
    moved.updateMatrixWorld(true);
  });

  const snapshot = () => page.evaluate(() => {
    const v = window.ng.getComponent(document.querySelector('app-viewport'));
    return {
      bodies: v.tree.bodyEntries().map(({ nodeId, body }) => ({
        nodeId, id: body.id, name: body.name, color: body.color, volume: body.volume,
        position: body.mesh.position.toArray().map((n) => +n.toFixed(4)),
        triangles: body.geometry.index.count / 3
      })),
      features: v.toolPanels.featureTreeEntries().map((f) => f.label + '|' + f.kind + '|' + JSON.stringify(f.params)),
      canUndo: v.history.canUndo()
    };
  });
  const before = await snapshot();
  log(`before save: ${before.bodies.length} bodies, features ${JSON.stringify(before.features)}`);

  // ---- Save (Ctrl+S) and capture the download.
  await page.locator('canvas').first().hover();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.keyboard.press('Control+s')]);
  await download.saveAs(savedPath);
  const size = fs.statSync(savedPath).size;
  log(`saved ${download.suggestedFilename()} (${(size / 1024).toFixed(0)} KB)`);
  check(download.suggestedFilename().endsWith('.cadproj'), 'Ctrl+S downloads a .cadproj file');

  // ---- Reload: nothing in memory survives this.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  check((await page.evaluate(() => window.ng.getComponent(document.querySelector('app-viewport')).tree.allBodies().length)) === 0, 'after a reload the scene is empty');

  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByText('Open Project…').click();
  await page.locator('input.project-file-input').setInputFiles(savedPath);
  await page.waitForFunction(() => { const v = window.ng.getComponent(document.querySelector('app-viewport')); return v.tree.allBodies().length > 0 && v.projectBusyMessage() === null; }, null, { timeout: 180000 });
  await page.waitForTimeout(800);

  const after = await snapshot();
  check(after.bodies.length === before.bodies.length, `same number of bodies (${after.bodies.length})`);
  check(JSON.stringify(after.bodies) === JSON.stringify(before.bodies), 'every body matches: node id, body id, name, color, volume, position, triangle count');
  check(JSON.stringify(after.features) === JSON.stringify(before.features), 'Feature Tree rows match');
  check(!after.canUndo, 'the undo stack starts empty');
  check(after.bodies[1].name === 'Renamed Bracket' && after.bodies[1].color === '#ff8800', 'rename and color survived');
  check(JSON.stringify(after.bodies[3].position) === JSON.stringify([12.5, -40, 7]), 'the moved part kept its position');

  // ---- (2) The rebuilt feature history is live: edit the counterbore back to a simple hole.
  if (!(await ft.isVisible())) { await page.getByRole('button', { name: 'Feature Tree', exact: true }).click(); await page.waitForTimeout(300); }
  await ft.locator('.feature-row-btn').first().dblclick();
  await form.locator('select').first().selectOption('simple');
  await form.locator('.extrude-btn', { hasText: 'Apply' }).click();
  await page.waitForFunction(() => !document.querySelector('.feature-tree-panel .feature-edit-form'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const vReverted = await readVol(0);
  log(`after opening, editing the hole back to simple: ${vReverted} (simple hole was ${vSimple})`);
  check(Math.abs(vReverted - vSimple) < 0.01, 'editing a feature after opening rebuilds it exactly (worker history was restored)');

  // ---- (3) The STEP source is live: cut a hole into never-modified Body 3.
  const target = 2;
  await labels.nth(target).click(); await page.waitForTimeout(300);
  await page.mouse.click(700, 400, { button: 'right' }); await page.waitForTimeout(300);
  await page.getByText('Isolate').click(); await page.waitForTimeout(500);
  await page.keyboard.press('f'); await page.waitForTimeout(700);
  const w0 = await readVol(target);
  await page.getByRole('button', { name: 'Hole Wizard', exact: true }).click();
  await page.waitForTimeout(300);
  const canvasBox = await page.locator('canvas').first().boundingBox();
  const project = (fn, arg) => page.evaluate(fn, arg);
  const p1 = await project((i) => {
    const v = window.ng.getComponent(document.querySelector('app-viewport'));
    const bb = v.tree.bodyEntries()[i].body.boundingBox;
    const cam = v.camera.getActiveCamera();
    const p = cam.position.clone().set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z).project(cam);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }, target);
  await page.mouse.click(canvasBox.x + p1.x * canvasBox.width, canvasBox.y + p1.y * canvasBox.height);
  await page.waitForTimeout(1500);
  const p2 = await project(() => {
    const v = window.ng.getComponent(document.querySelector('app-viewport'));
    const o = v.holeWizard.state().facePlane.origin;
    const cam = v.camera.getActiveCamera();
    const p = cam.position.clone().set(o[0], o[1], o[2]).project(cam);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  });
  await page.mouse.click(canvasBox.x + p2.x * canvasBox.width, canvasBox.y + p2.y * canvasBox.height);
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-viewport')).holeWizard.state().phase === 'configuring', null, { timeout: 15000 });
  await page.locator('.hole-wizard-panel .extrude-btn', { hasText: 'Apply Hole' }).click();
  const closed = await page.waitForFunction(() => !document.querySelector('.hole-wizard-panel'), null, { timeout: 60000 }).then(() => true).catch(() => false);
  if (!closed) throw new Error('hole on Body 3 failed: ' + (await page.locator('.hole-wizard-panel .error').textContent().catch(() => '?')));
  await page.waitForTimeout(600);
  const w1 = await readVol(target);
  log(`Body 3 volume ${w0} → ${w1}`);
  check(w1 < w0 - 1, 'a hole cut into an imported part after opening removes material (STEP source restored)');
} catch (e) {
  log('FAILED: ' + String(e).slice(0, 600));
  process.exitCode = 1;
} finally {
  log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4))}`);
  if (errs.length) process.exitCode = 1;
  fs.rmSync(savedPath, { force: true });
  await browser.close();
}
