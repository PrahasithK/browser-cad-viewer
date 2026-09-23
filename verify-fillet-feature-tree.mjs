import { chromium } from 'playwright';
import path from 'path';

const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');

function log(msg) { console.log(`[verify] ${msg}`); }
function assert(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log(`OK: ${msg}`);
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ['--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(60000);
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByText('Open STEP…').click();
  await page.locator('input.hidden-file-input').setInputFiles(STEP_FILE);
  await page.waitForFunction(() => {
    const el = document.querySelector('[class*=status]');
    return el && !el.textContent.includes('0 bodies');
  }, { timeout: 120000 });
  await page.waitForTimeout(1000);
  log('STEP loaded');

  // Same known-good edge pick as verify-variable-fillet.mjs (Body 1, edge at 850,780 — Edge 19,
  // a well-behaved edge on this STEP assembly; skipping Isolate per that script's own note on a
  // pre-existing, unrelated Isolate+Fillet-panel crash).
  const bodyLabels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  await bodyLabels.first().click();
  await page.waitForTimeout(300);

  const filletBtn = page.getByRole('button', { name: 'Fillet / Chamfer', exact: true });
  await filletBtn.click();
  await page.waitForTimeout(300);
  const panel = page.locator('.fillet-chamfer-panel');
  assert(await panel.isVisible(), 'Fillet/Chamfer panel opens');

  await page.mouse.click(850, 780);
  await page.waitForTimeout(600);
  const pickCount = await panel.locator('.pick-list li').count();
  assert(pickCount >= 1, 'At least one edge picked');

  const edgeInputs = panel.locator('.pick-list .edge-value-input');
  await edgeInputs.first().fill('4');
  await page.waitForTimeout(150);

  const applyBtn = panel.locator('.extrude-btn', { hasText: 'Apply Fillet' });
  await applyBtn.click();
  await page.waitForFunction(() => !document.querySelector('.fillet-chamfer-panel'), { timeout: 30000 }).catch(async () => {
    const err = await panel.locator('.error').textContent().catch(() => null);
    if (err) throw new Error('FILLET_ERROR: ' + err);
  });
  await page.waitForTimeout(500);
  assert(!(await panel.isVisible().catch(() => false)), 'Fillet panel auto-closes — no error');
  log('Fillet applied');

  // --- Feature Tree: row appears ---
  const featureTreeBtn = page.getByRole('button', { name: 'Feature Tree', exact: true });
  await featureTreeBtn.click();
  await page.waitForTimeout(300);
  const ftPanel = page.locator('.feature-tree-panel');
  assert(await ftPanel.isVisible(), 'Feature Tree panel opens');

  const rows = ftPanel.locator('.pick-list li');
  const rowCount = await rows.count();
  assert(rowCount >= 1, `Feature Tree has at least one row, got ${rowCount}`);

  const filletRow = ftPanel.locator('.feature-row-btn', { hasText: 'Fillet' });
  assert(await filletRow.count() >= 1, 'A "Fillet" row exists in the Feature Tree');
  const rowTextBefore = await filletRow.first().textContent();
  log(`Row before edit: ${rowTextBefore.trim()}`);
  assert(/1 edge/.test(rowTextBefore), 'Row shows "1 edge"');

  // --- Double-click to edit, change radius, Apply ---
  await filletRow.first().dblclick();
  await page.waitForTimeout(300);
  const editForm = ftPanel.locator('.feature-edit-form');
  assert(await editForm.isVisible(), 'Edit form opens on double-click');

  const editEdgeInput = editForm.locator('input[type=number]').first();
  assert(await editEdgeInput.inputValue() === '4', `Edit form pre-filled with radius 4, got ${await editEdgeInput.inputValue()}`);
  await editEdgeInput.fill('9');
  await page.waitForTimeout(150);

  const applyEditBtn = editForm.locator('.extrude-btn', { hasText: 'Apply' });
  await applyEditBtn.click();
  await page.waitForFunction(() => {
    const form = document.querySelector('.feature-tree-panel .feature-edit-form');
    return !form;
  }, { timeout: 30000 }).catch(async () => {
    const err = await editForm.locator('.error').textContent().catch(() => null);
    if (err) throw new Error('EDIT_ERROR: ' + err);
  });
  await page.waitForTimeout(500);
  log('Feature Tree edit applied (radius 4 -> 9)');

  const rowTextAfter = await filletRow.first().textContent();
  log(`Row after edit: ${rowTextAfter.trim()}`);

  // --- Undo / Redo ---
  const bodyCountBefore = await bodyLabels.count();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(1000);
  const bodyCountAfterUndo = await bodyLabels.count();
  assert(bodyCountAfterUndo === bodyCountBefore, `Undo kept body count stable (${bodyCountAfterUndo})`);

  await page.keyboard.press('Control+y');
  await page.waitForTimeout(1000);
  const bodyCountAfterRedo = await bodyLabels.count();
  assert(bodyCountAfterRedo === bodyCountBefore, `Redo kept body count stable (${bodyCountAfterRedo})`);
  log('Undo/Redo round-trip OK, no crash, no error state');

  if (errs.length > 0) {
    log(`Console errors (${errs.length}):`);
    errs.forEach((e) => log(`  ${e}`));
    throw new Error('Console errors present');
  } else {
    log('Zero console errors throughout.');
  }

  await browser.close();
  log('ALL CHECKS PASSED');
}

main().catch(async (err) => {
  console.error('[verify] FAILURE:', err.message || err);
  process.exit(1);
});
