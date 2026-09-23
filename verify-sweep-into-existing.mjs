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
  const facesBeforeText = await facesLocator.textContent();
  log(`BEFORE — ${facesBeforeText} | ${volBeforeText}`);

  // Start Sketch, click directly on the body's face (this both picks a plane AND resolves
  // pickedFace, the same way finishAndExtrude's own cut path already relies on). Click BEFORE
  // opening the Sketch panel's own camera reframe changes anything — use the exact same
  // dead-center click Draft/Shell's own verify scripts use, which reframe identically.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await page.waitForTimeout(300);
  const panel = page.locator('.sketch-panel');

  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => {
    const hint = document.querySelector('.sketch-panel .hint');
    // "Click first corner…"/"Click center…" (phase: drawing) — distinct from the picking-phase
    // hint text ("Click a face on a part…"), which also contains "Click" and would otherwise
    // make this wait pass immediately without the phase having actually changed.
    return hint && hint.textContent && /Click (first corner|center|start point)/.test(hint.textContent);
  }, { timeout: 20000 });
  await page.waitForTimeout(300);

  await panel.locator('.shape-btn[title="Circle"]').click();
  await page.waitForTimeout(150);
  // Small circle: center near the click point, radius ~15px (a small pocket, not a huge cut).
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(150);
  await page.mouse.click(cx + 15, cy);
  await page.waitForTimeout(300);

  const kindToggle = panel.locator('.kind-toggle');
  assert(await kindToggle.isVisible(), 'Finish-mode toggle appears');
  await panel.locator('.kind-btn', { hasText: 'Sweep' }).click();
  await page.waitForTimeout(200);

  const numberInputs = panel.locator('input[type=number]');
  const count = await numberInputs.count();
  // Fields in Sweep mode: Tilt angle, Distance (in that order).
  await numberInputs.nth(count - 2).fill('0');
  await page.waitForTimeout(150);
  await numberInputs.nth(count - 1).fill('50');
  await page.waitForTimeout(150);

  const cutCheckbox = panel.locator('.field.checkbox input[type=checkbox]').last();
  await cutCheckbox.check();
  await page.waitForTimeout(200);

  const sweepBtn = panel.locator('.extrude-btn', { hasText: 'Sweep' });
  await sweepBtn.click();

  await page.waitForFunction(() => !document.querySelector('.sketch-panel'), { timeout: 60000 }).catch(async () => {
    const err = await panel.locator('.error').textContent().catch(() => null);
    if (err) throw new Error('SWEEP_CUT_ERROR: ' + err);
  });
  await page.waitForTimeout(500);
  assert(!(await panel.isVisible().catch(() => false)), 'Sketch panel auto-closes — no error');

  const countAfter = await bodyLabels.count();
  assert(countAfter === 17, `Body count unchanged at 17 (in-place cut, not a new body), got ${countAfter}`);

  await bodyLabels.first().click();
  await page.waitForTimeout(300);
  const volAfterText = await volLocator.textContent();
  const facesAfterText = await facesLocator.textContent();
  log(`AFTER — ${facesAfterText} | ${volAfterText}`);

  const parseNum = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));
  const volBefore = parseNum(volBeforeText);
  const volAfter = parseNum(volAfterText);
  const delta = volAfter - volBefore;
  log(`Volume before: ${volBefore}, after: ${volAfter}, delta: ${delta}`);
  assert(volAfter > 0, `Volume positive (${volAfter} mm³)`);
  assert(delta < 0, `Volume DECREASED (delta=${delta}) — confirms a real Cut happened, not a no-op or a fuse`);
  assert(Math.abs(delta) > 100, `Volume changed by a real, substantial amount (delta=${delta})`);

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
