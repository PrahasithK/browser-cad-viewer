// Regression: editing a feature whose replay yields several solids must not overwrite its main body. Extrude a block, sketch a boss on its top face (the click lands off the block, so the fuse yields TWO solids), edit the block depth, expect both bodies to survive. Needs `ng serve --port 4300`; PW_CHANNEL=chrome for installed Chrome.
// Check 2: does a boss sketched on the top face of Extrude F1 follow that face when F1's depth is edited?
import { chromium } from 'playwright';
import path from 'path';
const log = (m) => console.log(`[boss] ${m}`);

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const labels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  const props = async () => {
    const t = (await page.locator('.prop-row').allTextContents()).map(s => s.replace(/\s+/g, ' ').trim());
    return { vol: t.find(s => s.startsWith('Volume')), max: t.find(s => s.startsWith('Max')), min: t.find(s => s.startsWith('Min')) };
  };
  const selectBody = async () => { await labels.first().click(); await page.waitForTimeout(400); };
  const cv = await page.locator('canvas').first().boundingBox();
  const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;
  const panel = page.locator('.sketch-panel');
  const waitDrawing = () => page.waitForFunction(() => {
    const h = document.querySelector('.sketch-panel .hint');
    return h && /Click (first corner|center|start point)/.test(h.textContent || '');
  }, { timeout: 90000 });

  // ---- F1: rectangle on XY, extrude 20
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await panel.locator('.plane-btn', { hasText: 'XY' }).click();
  await waitDrawing();
  await page.mouse.click(cx - 120, cy - 60); await page.waitForTimeout(150);
  await page.mouse.click(cx + 120, cy + 60); await page.waitForTimeout(300);
  await panel.locator('input[type=number]').first().fill('20');
  await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
  await page.waitForFunction(() => !document.querySelector('.sketch-panel'), { timeout: 90000 });
  await page.waitForTimeout(500);
  await selectBody();
  const p1 = await props();
  log('F1 (block, depth 20): ' + JSON.stringify(p1));

  // ---- F2: boss on the TOP face. Scan clicks until the picked face plane has normal.z ~ +1.
  await page.getByRole('button', { name: 'Sketch', exact: true }).click(); await page.waitForTimeout(300);
  let topPick = null;
  outer: for (let dy = -120; dy <= 60; dy += 12) for (let dx = -160; dx <= 160; dx += 16) {
    await page.mouse.click(cx + dx, cy + dy); await page.waitForTimeout(250);
    const st = await page.evaluate(() => {
      const vp = window.ng.getComponent(document.querySelector('app-viewport'));
      const s = vp.sketch.state();
      return { phase: s.phase, n: s.facePlane ? s.facePlane.normal : null };
    });
    if (st.phase === 'drawing' && st.n && st.n[2] > 0.9) { topPick = { dx, dy, n: st.n }; break outer; }
    if (st.phase === 'drawing') { log('picked a non-top face ' + JSON.stringify(st.n) + ', cancelling & retrying'); await page.keyboard.press('Escape'); await page.waitForTimeout(300); await page.getByRole('button', { name: 'Sketch', exact: true }).click(); await page.waitForTimeout(300); }
  }
  log('top face pick: ' + JSON.stringify(topPick));
  if (!topPick) throw new Error('could not pick the top face');
  await waitDrawing();
  const bx = cx + topPick.dx, by = cy + topPick.dy;
  await page.mouse.click(bx - 25, by - 15); await page.waitForTimeout(150);
  await page.mouse.click(bx + 25, by + 15); await page.waitForTimeout(300);
  await panel.locator('input[type=number]').first().fill('10');
  const cut = panel.locator('.field.checkbox input[type=checkbox]').first();
  if (await cut.count()) { log('cut checkbox checked? ' + await cut.isChecked()); }
  await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
  await page.waitForFunction(() => !document.querySelector('.sketch-panel'), { timeout: 90000 });
  await page.waitForTimeout(600);
  {
    const n = await labels.count();
    for (let i = 0; i < n; i++) { await labels.nth(i).click(); await page.waitForTimeout(400); log(`after-boss body[${i}] "${(await labels.nth(i).textContent()).trim()}": ` + JSON.stringify(await props())); }
  }

  // ---- edit F1 depth 20 -> 60 via Feature Tree
  await page.getByRole('button', { name: 'Feature Tree', exact: true }).click(); await page.waitForTimeout(300);
  const ft = page.locator('.feature-tree-panel');
  const rows = ft.locator('.feature-row-btn');
  log('feature rows: ' + JSON.stringify(await rows.allTextContents()));
  await rows.first().dblclick(); await page.waitForTimeout(300);
  const form = ft.locator('.feature-edit-form');
  await form.locator('input[type=number]').first().fill('60');
  await form.locator('.extrude-btn', { hasText: 'Apply' }).click();
  await page.waitForFunction(() => !document.querySelector('.feature-tree-panel .feature-edit-form'), { timeout: 90000 })
    .catch(async () => log('edit form still open; error=' + await form.locator('.error').textContent().catch(() => '?')));
  await page.waitForTimeout(800);
  {
    const n = await labels.count();
    var finalMax = [];
    for (let i = 0; i < n; i++) { await labels.nth(i).click(); await page.waitForTimeout(400); finalMax.push((await props()).max); log(`after-edit body[${i}] "${(await labels.nth(i).textContent()).trim()}": ` + JSON.stringify(await props())); }
  }
  {
    const okBlock = finalMax.some((m) => /, 60.00 mm/.test(m));
    const okBoss = finalMax.some((m) => /, 70.00 mm/.test(m)); /* the boss now follows the top face (30 -> 70) */
    if (finalMax.length !== 2 || !okBlock || !okBoss) throw new Error('feature edit lost a body: ' + JSON.stringify(finalMax));
    log('OK: block (z 60) and boss (z 70, it followed the face) both survived the edit');
  }
  const dump = await page.evaluate(() => {
    const vp = window.ng.getComponent(document.querySelector('app-viewport'));
    const out = [];
    const walk = (ns) => { for (const n of ns) { out.push({ id: n.id, label: n.label, type: n.type, featureId: n.featureId, hasStepSource: n.hasStepSource }); if (n.children) walk(n.children); } };
    walk(vp.tree.nodes());
    return { nodes: out, bodies: vp.tree.allBodies().map(b => ({ id: b.id, name: b.name, zMin: b.boundingBox.min.z, zMax: b.boundingBox.max.z, vol: b.volume, meshInScene: !!b.mesh.parent })) };
  });
  log('TREE DUMP ' + JSON.stringify(dump));
} catch (e) { log('FAILED: ' + String(e).slice(0, 500)); process.exitCode = 1; }
finally { log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`); await browser.close(); }
