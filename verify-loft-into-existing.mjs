import { chromium } from 'playwright';
import path from 'path';

const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');

function log(msg) { console.log(`[verify] ${msg}`); }
function assert(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log(`OK: ${msg}`);
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
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

  const bodyLabels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  await bodyLabels.first().click();
  await page.waitForTimeout(300);
  await page.mouse.click(700, 400, { button: 'right' });
  await page.waitForTimeout(300);
  await page.getByText('Isolate').click();
  await page.waitForTimeout(500);
  await page.keyboard.press('f');
  await page.waitForTimeout(500);

  const volLocator = page.locator('.prop-row', { hasText: 'Volume' });
  const facesLocator = page.locator('.prop-row', { hasText: 'Faces' });
  const volBeforeText = await volLocator.textContent();
  log(`BEFORE — ${await facesLocator.textContent()} | ${volBeforeText}`);

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.getByRole('button', { name: 'Loft', exact: true }).click();
  await page.waitForTimeout(300);
  const panel = page.locator('.loft-panel');
  assert(await panel.isVisible(), 'Loft panel opens');

  // Profile 1: face-picked on the isolated body itself (this is what makes the whole Loft
  // target that body for cut/fuse — only the FIRST profile's pickedFace is ever consulted).
  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => {
    const hint = document.querySelector('.loft-panel .hint');
    return hint && hint.textContent && /Click (first corner|center|start point)/.test(hint.textContent);
  }, { timeout: 20000 });
  await page.waitForTimeout(300);

  await panel.locator('.shape-btn[title="Circle"]').click();
  await page.waitForTimeout(150);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(150);
  await page.mouse.click(cx + 80, cy);
  await page.waitForTimeout(300);

  await panel.locator('.extrude-btn', { hasText: 'Add to Loft' }).click();
  await page.waitForTimeout(300);
  assert(await panel.locator('.pick-list li').count() === 1, 'Profile 1 (face-picked) added');

  // Profile 2: on the XZ datum plane — a genuinely different orientation than the picked face,
  // giving the loft's blend real depth to work with (two profiles on the very same plane would
  // loft into a degenerate near-zero-thickness solid, a real geometric no-op unrelated to this
  // feature's own cut/fuse wiring — confirmed while developing this test). Only the FIRST
  // profile's pickedFace drives the cut/fuse target; profile 2's own plane choice doesn't.
  await panel.locator('.plane-btn', { hasText: 'XZ' }).click();
  await page.waitForFunction(() => {
    const hint = document.querySelector('.loft-panel .hint');
    return hint && hint.textContent && /Click (first corner|center|start point)/.test(hint.textContent);
  }, { timeout: 20000 });
  await page.waitForTimeout(300);
  await panel.locator('.shape-btn[title="Circle"]').click();
  await page.waitForTimeout(150);
  const box2 = await canvas.boundingBox();
  const cx2 = box2.x + box2.width / 2;
  const cy2 = box2.y + box2.height / 2;
  await page.mouse.click(cx2, cy2);
  await page.waitForTimeout(150);
  await page.mouse.click(cx2 + 60, cy2);
  await page.waitForTimeout(300);
  await panel.locator('.extrude-btn', { hasText: 'Add to Loft' }).click();
  await page.waitForTimeout(300);
  assert(await panel.locator('.pick-list li').count() === 2, 'Profile 2 added');

  const cutCheckbox = panel.locator('.field.checkbox input[type=checkbox]');
  await cutCheckbox.check();
  await page.waitForTimeout(150);

  const finishBtn = panel.locator('.extrude-btn', { hasText: 'Finish Loft' });
  assert(await finishBtn.isVisible(), 'Finish Loft button visible');
  await finishBtn.click();

  await page.waitForFunction(() => !document.querySelector('.loft-panel'), { timeout: 60000 }).catch(async () => {
    const err = await panel.locator('.error').textContent().catch(() => null);
    if (err) throw new Error('LOFT_CUT_ERROR: ' + err);
  });
  await page.waitForTimeout(500);
  assert(!(await panel.isVisible().catch(() => false)), 'Loft panel auto-closes — no error');

  const countAfter = await bodyLabels.count();
  assert(countAfter === 17, `Body count unchanged at 17 (in-place cut/fuse, not a new body), got ${countAfter}`);

  await bodyLabels.first().click();
  await page.waitForTimeout(300);
  const volAfterText = await volLocator.textContent();
  log(`AFTER — ${await facesLocator.textContent()} | ${volAfterText}`);

  const parseNum = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));
  const volBefore = parseNum(volBeforeText);
  const volAfter = parseNum(volAfterText);
  const delta = volAfter - volBefore;
  log(`Volume before: ${volBefore}, after: ${volAfter}, delta: ${delta}`);
  assert(volAfter > 0, `Volume positive (${volAfter} mm³)`);
  assert(delta < 0, `Volume DECREASED (delta=${delta}) — confirms a real Cut against the real target body, not a no-op`);
  assert(Math.abs(delta) > 1000, `Volume changed by a real, substantial amount (delta=${delta})`);

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

main().catch((err) => {
  console.error('[verify] FAILURE:', err.message || err);
  process.exit(1);
});
