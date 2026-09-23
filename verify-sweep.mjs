import { chromium } from 'playwright';

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

  // Start Sketch, pick XY datum plane.
  const sketchBtn = page.getByRole('button', { name: 'Sketch', exact: true });
  await sketchBtn.click();
  await page.waitForTimeout(300);
  const panel = page.locator('.sketch-panel');
  assert(await panel.isVisible(), 'Sketch panel opens');

  await panel.locator('.plane-btn', { hasText: 'XY' }).click();
  await page.waitForFunction(() => {
    const hint = document.querySelector('.sketch-panel .hint');
    return hint && hint.textContent && hint.textContent.includes('Click');
  }, { timeout: 20000 });
  await page.waitForTimeout(200);

  // Default shape is rectangle — draw a 40 x 30 rectangle via two viewport clicks.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx - 60, cy - 40);
  await page.waitForTimeout(200);
  await page.mouse.click(cx + 60, cy + 40);
  await page.waitForTimeout(300);

  assert(await panel.locator('.kind-toggle').isVisible(), 'Finish-mode toggle appears once profile is complete');

  const sweepToggle = panel.locator('.kind-btn', { hasText: 'Sweep' });
  assert(await sweepToggle.count() === 1, 'Sweep toggle button exists');
  await sweepToggle.click();
  await page.waitForTimeout(200);

  const numberInputs = panel.locator('input[type=number]');
  const count2 = await numberInputs.count();
  log(`number input count in sweep mode: ${count2}`);
  // Fields in order: Tilt angle, Distance
  await numberInputs.nth(count2 - 2).fill('20');
  await page.waitForTimeout(150);
  await numberInputs.nth(count2 - 1).fill('25');
  await page.waitForTimeout(200);

  const sweepBtn = panel.locator('.extrude-btn', { hasText: 'Sweep' });
  assert(await sweepBtn.isVisible(), 'Sweep apply button visible');
  await sweepBtn.click();

  await page.waitForFunction(() => !document.querySelector('.sketch-panel'), { timeout: 30000 }).catch(async () => {
    const err = await panel.locator('.error').textContent().catch(() => null);
    if (err) throw new Error('SWEEP_ERROR: ' + err);
  });
  await page.waitForTimeout(500);
  assert(!(await panel.isVisible().catch(() => false)), 'Sketch panel auto-closes — no error');

  // Select the newly created body and check its properties.
  const bodyLabels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  const count = await bodyLabels.count();
  assert(count === 1, `Exactly one body in tree, got ${count}`);
  await bodyLabels.first().click();
  await page.waitForTimeout(300);

  const volText = await page.locator('.prop-row', { hasText: 'Volume' }).textContent();
  const facesText = await page.locator('.prop-row', { hasText: 'Faces' }).textContent();
  log(`Sweep result — ${facesText} | ${volText}`);

  const parseNum = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));
  const vol = parseNum(volText);
  // Rectangle profile is roughly 40x30mm (screen px -> world scale unknown exactly, so just
  // sanity check a real positive volume in a plausible range) swept 25mm along the plane's own
  // U axis (perpendicular to the sketch plane's normal) — a simple rectangular-prism-like solid.
  assert(vol > 0, `Volume is positive (${vol} mm³)`);
  assert(Number.isFinite(vol), `Volume is a finite number`);

  const faces = parseInt(facesText.replace(/[^0-9]/g, ''), 10);
  assert(faces === 6, `Faces === 6 (a swept rectangle profile is a simple 6-face box), got ${faces}`);

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
