import { chromium } from 'playwright';
import path from 'path';

const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');

function log(msg) { console.log(`[verify] ${msg}`); }
function assert(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log(`OK: ${msg}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
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
  const volLocator = page.locator('.prop-row', { hasText: 'Volume' });
  const facesLocator = page.locator('.prop-row', { hasText: 'Faces' });
  const edgesLocator = page.locator('.prop-row', { hasText: 'Edges' });

  const volBeforeText = await volLocator.textContent();
  const facesBefore = await facesLocator.textContent();
  const edgesBefore = await edgesLocator.textContent();
  log(`BEFORE — ${facesBefore} | ${edgesBefore} | ${volBeforeText}`);

  await page.mouse.click(700, 400, { button: 'right' });
  await page.waitForTimeout(300);
  await page.getByText('Isolate').click();
  await page.waitForTimeout(500);
  await page.keyboard.press('f');
  await page.waitForTimeout(500);

  const draftBtn = page.getByRole('button', { name: 'Draft', exact: true });
  assert(await draftBtn.isVisible(), 'Draft ribbon button visible');
  await draftBtn.click();
  await page.waitForTimeout(300);
  const panel = page.locator('.draft-panel');
  assert(await panel.isVisible(), 'Draft panel opens');

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(300);
  assert((await panel.locator('.hint').first().textContent()).includes('selected'), 'Face picked');

  const ANGLE = 5;
  await panel.locator('input[type=number]').fill(String(ANGLE));
  await page.waitForTimeout(200);
  const applyBtn = panel.locator('.extrude-btn');
  assert(!(await applyBtn.isDisabled()), 'Apply Draft enabled');
  await applyBtn.click();

  let draftErr = null;
  await page.waitForFunction(() => !document.querySelector('.draft-panel'), { timeout: 90000 }).catch(async () => {
    draftErr = await panel.locator('.error').textContent().catch(() => null);
  });
  if (draftErr) throw new Error('DRAFT_OCCT_ERROR: ' + draftErr);
  await page.waitForTimeout(500);
  assert(!(await panel.isVisible().catch(() => false)), 'Draft panel auto-closes — no OCCT error');

  await bodyLabels.first().click();
  await page.waitForTimeout(300);
  const facesAfter = await facesLocator.textContent();
  const edgesAfter = await edgesLocator.textContent();
  const volAfterText = await volLocator.textContent();
  log(`AFTER — ${facesAfter} | ${edgesAfter} | ${volAfterText}`);

  const bodyCount = await bodyLabels.count();
  assert(bodyCount === 17, `Body count unchanged at 17, got ${bodyCount}`);

  const parseNum = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));
  const volAfter = parseNum(volAfterText);
  const volBefore = parseNum(volBeforeText);
  const delta = volAfter - volBefore;
  log(`Volume before: ${volBefore}, after: ${volAfter}, delta: ${delta}`);
  assert(volAfter > 0, `Volume positive (${volAfter} mm³)`);
  assert(Math.abs(delta) > 10000, `Volume changed by a real, substantial amount (delta=${delta}, expected well over 10,000 mm³ for a ${ANGLE}° draft on a large face)`);

  await page.screenshot({ path: 'draft-result.png' });

  if (errs.length > 0) {
    log(`Console errors (${errs.length}):`);
    errs.forEach((e) => log(`  ${e}`));
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
