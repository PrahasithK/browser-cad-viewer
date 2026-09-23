// Regression: Hole Wizard holes as their own `kind: 'hole'` Feature Tree entries, plus counterbore/
// countersink (2026-09-24).
// Checks: (1) a simple hole appears as an editable "Hole (...)" row; (2) editing it to a counterbore
// removes exactly the analytical extra volume π(R²−r²)·depth, and Ctrl+Z restores it — which also
// proves edit results reach the scene (before 2026-09-24 a hole body's id never matched its
// producesBodyId, so edit replays were silently dropped); (3) a SECOND and THIRD hole on the same,
// already-cut part — a counterbore and a countersink placed directly from the wizard — each remove
// more material than a plain hole would.
// Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
import { chromium } from 'playwright';
import path from 'path';

const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');
const log = (m) => console.log(`[hole-ft] ${m}`);
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); log('OK: ' + msg); };
const num = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  // ResizeObserver's own "loop completed with undelivered notifications" is a browser-generated
  // advisory, not an application error.
  page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver loop/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByText('Open STEP…').click();
  await page.locator('input.hidden-file-input').setInputFiles(STEP_FILE);
  await page.waitForFunction(() => { const el = document.querySelector('[class*=status]'); return el && !el.textContent.includes('0 bodies'); }, null, { timeout: 120000 });
  await page.waitForTimeout(1200);

  const labels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  const readVol = async () => { await labels.first().click(); await page.waitForTimeout(400); return num(await page.locator('.prop-row', { hasText: 'Volume' }).textContent()); };
  const holeState = () => page.evaluate(() => window.ng.getComponent(document.querySelector('app-viewport')).holeWizard.state());

  await labels.first().click(); await page.waitForTimeout(300);
  await page.mouse.click(700, 400, { button: 'right' }); await page.waitForTimeout(300);
  await page.getByText('Isolate').click(); await page.waitForTimeout(500);
  await page.keyboard.press('f'); await page.waitForTimeout(700);
  const v0 = await readVol();
  log('Body 1 volume before any hole: ' + v0);

  const panel = page.locator('.hole-wizard-panel');

  async function placeHole(label, holeType, centerOffset, entryInput = null) {
    // camera.fitAll() runs at the end of the PREVIOUS hole's commit() — re-fit before scanning.
    await page.keyboard.press('f');
    await page.waitForTimeout(700);
    const box = await page.locator('canvas').first().boundingBox();
    const centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;

    await page.getByRole('button', { name: 'Hole Wizard', exact: true }).click();
    await page.waitForTimeout(300);
    check(await panel.isVisible(), `${label}: Hole Wizard panel opens`);

    let picked = false;
    outer: for (let dy = -80; dy <= 80; dy += 15) for (let dx = -100; dx <= 100; dx += 20) {
      await page.mouse.click(centerX + dx, centerY + dy);
      if ((await holeState()).phase === 'picking-point') { picked = true; break outer; }
      await page.waitForTimeout(80);
    }
    check(picked, `${label}: a flat face was picked`);
    await page.waitForTimeout(400);
    // Each hole gets its own center — drilling through an already-empty hole would correctly
    // remove nothing, indistinguishable from a silent-no-op defect.
    await page.mouse.click(centerX + centerOffset.dx, centerY + centerOffset.dy);
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-viewport')).holeWizard.state().phase === 'configuring', null, { timeout: 15000 });
    await page.waitForTimeout(300);

    await panel.locator('select[title="Hole type"]').selectOption(holeType);
    await page.waitForTimeout(200);
    if (entryInput) {
      await panel.locator('label', { hasText: entryInput.label }).locator('input').fill(String(entryInput.value));
      await page.waitForTimeout(200);
    }
    const st = await holeState();
    const applyBtn = panel.locator('.extrude-btn', { hasText: 'Apply Hole' });
    check(await applyBtn.isEnabled(), `${label}: Apply Hole is enabled`);
    await applyBtn.click();
    const closed = await page.waitForFunction(() => !document.querySelector('.hole-wizard-panel'), null, { timeout: 60000 }).then(() => true).catch(() => false);
    if (!closed) {
      const err = await panel.locator('.error').textContent().catch(() => '(no error text)');
      throw new Error(`${label}: Hole Wizard did not close — error: "${err}"`);
    }
    await page.waitForTimeout(600);
    return { volume: await readVol(), state: st };
  }

  // ---- Hole #1: simple, on a pristine STEP body.
  const { volume: v1 } = await placeHole('hole #1 (simple)', 'simple', { dx: 0, dy: 0 });
  const simpleDelta = v0 - v1;
  log(`volume after hole #1: ${v1} (removed ${simpleDelta.toFixed(1)})`);
  check(simpleDelta > 1, 'hole #1 removed real material');
  check(await labels.count() === 17, 'body count unchanged (replaced in place)');

  // ---- Feature Tree: a "Hole (...)" row, edited to a counterbore.
  await page.getByRole('button', { name: 'Feature Tree', exact: true }).click();
  await page.waitForTimeout(300);
  const ft = page.locator('.feature-tree-panel');
  const rows = ft.locator('.feature-row-btn');
  log('Feature Tree rows: ' + JSON.stringify(await rows.allTextContents()));
  const holeRow = rows.filter({ hasText: 'Hole (' });
  check(await holeRow.count() === 1, 'exactly one "Hole (...)" row exists');

  await holeRow.first().dblclick();
  await page.waitForTimeout(300);
  const form = ft.locator('.feature-edit-form');
  check(await form.isVisible(), 'double-click opens the edit form');
  const holeDia = Number(await form.locator('input[type=number]').first().inputValue());
  await form.locator('select').first().selectOption('counterbore');
  await page.waitForTimeout(200);
  const inputs = form.locator('input[type=number]');
  const cboreDia = Number(await inputs.nth(1).inputValue());
  // This part is only ~5 mm thick at the picked face (hole #1 removed π·r²·T), so the M6 standard
  // counterbore depth (6.5 mm) would go straight through. Use a depth well inside the plate so the
  // check is of a real stepped hole.
  const thickness = simpleDelta / (Math.PI * (holeDia / 2) ** 2);
  const cboreDepth = Math.round(thickness * 0.5 * 10) / 10;
  log(`plate thickness at hole #1: ${thickness.toFixed(2)} mm`);
  await inputs.nth(2).fill(String(cboreDepth));
  log(`edit: hole Ø${holeDia} → counterbore Ø${cboreDia} × ${cboreDepth}`);
  await form.locator('.extrude-btn', { hasText: 'Apply' }).click();
  await page.waitForFunction(() => !document.querySelector('.feature-tree-panel .feature-edit-form'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const vCbore = await readVol();
  const expectedExtra = Math.PI * ((cboreDia / 2) ** 2 - (holeDia / 2) ** 2) * cboreDepth;
  const actualExtra = v1 - vCbore;
  log(`counterbore edit removed ${actualExtra.toFixed(1)} extra (analytical ${expectedExtra.toFixed(1)})`);
  check(Math.abs(actualExtra - expectedExtra) / expectedExtra < 0.02, 'edited counterbore removes the analytical π(R²−r²)·depth extra volume (within 2%)');
  const rowsAfterEdit = await rows.allTextContents();
  check(rowsAfterEdit.some((t) => t.includes('Counterbore (')), 'the row now reads "Counterbore (...)"');

  // The undo replay queues behind history.run()'s own idempotent re-apply of the edit, and each
  // replay re-reads the imported STEP assembly — wait for the real outcome, not a fixed delay.
  await page.keyboard.press('Control+z');
  const reverted = await page
    .waitForFunction(() => [...document.querySelectorAll('.feature-tree-panel .feature-row-btn')].some((b) => /^\s*Hole \(/.test(b.textContent ?? '')), null, { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  check(reverted, 'Ctrl+Z reverts the row to "Hole (...)"');
  await page.waitForTimeout(800);
  const vUndone = await readVol();
  check(Math.abs(vUndone - v1) < 0.01, "Ctrl+Z restores the simple hole's volume exactly");

  // ---- Holes #2/#3 on the SAME, already-cut body: counterbore and countersink straight from the wizard.
  // Typing the counterbore depth in the wizard panel also exercises its own input path.
  const { volume: v2, state: s2 } = await placeHole('hole #2 (counterbore)', 'counterbore', { dx: 60, dy: 40 }, { label: "C'bore depth", value: 3 });
  log(`volume after hole #2: ${v2} (removed ${(vUndone - v2).toFixed(1)}; c'bore Ø${s2.cboreDiameter} × ${s2.cboreDepth})`);
  check(s2.cboreDepth === 3, 'the wizard panel accepted a typed counterbore depth');
  check(vUndone - v2 > simpleDelta + 1, 'counterbore hole removes more material than a plain hole');

  const { volume: v3, state: s3 } = await placeHole('hole #3 (countersink)', 'countersink', { dx: -60, dy: -40 });
  log(`volume after hole #3: ${v3} (removed ${(v2 - v3).toFixed(1)}; c'sink Ø${s3.csinkDiameter} @ ${s3.csinkAngleDeg}°)`);
  check(v2 - v3 > simpleDelta + 1, 'countersink hole removes more material than a plain hole');
  check(await labels.count() === 17, 'body count still unchanged after three holes');

  if (!(await ft.isVisible())) {
    await page.getByRole('button', { name: 'Feature Tree', exact: true }).click();
    await page.waitForTimeout(300);
  }
  const finalRows = await ft.locator('.feature-row-btn').allTextContents();
  log('Feature Tree rows after all holes: ' + JSON.stringify(finalRows));
  check(finalRows.filter((t) => /^\s*(Hole|Counterbore|Countersink) \(/.test(t)).length === 3, 'all three holes are separately editable Feature Tree rows');
} catch (e) {
  log('FAILED: ' + String(e).slice(0, 500));
  process.exitCode = 1;
} finally {
  log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4))}`);
  if (errs.length) process.exitCode = 1;
  await browser.close();
}
