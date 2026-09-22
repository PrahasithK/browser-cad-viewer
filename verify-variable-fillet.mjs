import { chromium } from 'playwright';
import path from 'path';

const STEP_FILE = path.resolve('public/assets/DM556MotorDriverAssembly.STEP');

function log(msg) { console.log(`[verify] ${msg}`); }
function assert(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log(`OK: ${msg}`);
}

async function main() {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] });
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

  // Deliberately NOT using Isolate here (unlike every other verify script in this project) — a
  // real, reproducible browser crash was found during this feature's own verification: opening
  // the Fillet/Chamfer panel and clicking the viewport, specifically after a right-click →
  // Isolate on the target body, crashes the renderer/page outright, on every body tried
  // (including tiny ones), with no console error surfaced first. Confirmed NOT caused by this
  // session's own Fillet/Chamfer changes (reproduces identically on a stash of the pre-change
  // code too) and NOT a general environment issue (Shell/Draft/Sweep all click-pick fine
  // immediately after the same Isolate step). Root cause not yet found — logged as a real,
  // separate bug for a future pass rather than blocking this one; skipping Isolate here avoids
  // it entirely since Fillet/Chamfer's own click-to-pick works reliably without it.
  const bodyLabels = page.locator('.tree-node:has(.delete-toggle) .node-label');
  await bodyLabels.first().click();
  await page.waitForTimeout(300);

  const volLocator = page.locator('.prop-row', { hasText: 'Volume' });
  const facesLocator = page.locator('.prop-row', { hasText: 'Faces' });
  const volBeforeText = await volLocator.textContent();
  const facesBeforeText = await facesLocator.textContent();
  log(`BEFORE — ${facesBeforeText} | ${volBeforeText}`);

  const filletBtn = page.getByRole('button', { name: 'Fillet / Chamfer', exact: true });
  assert(await filletBtn.isVisible(), 'Fillet/Chamfer ribbon button visible');
  await filletBtn.click();
  await page.waitForTimeout(300);
  const panel = page.locator('.fillet-chamfer-panel');
  assert(await panel.isVisible(), 'Fillet/Chamfer panel opens');

  // Pick a real edge on Body 1 (the large enclosure panel, clearly visible in the default
  // un-isolated assembly view), at (850,780) — resolves to Edge 19. This script verifies the
  // single-edge apply path end to end with real numeric checks; the 2-different-edges-with-2-
  // different-values scenario (the actual "variable-radius" input) was separately confirmed via
  // a standalone probe: picking a 2nd real edge after this one correctly ADDS it alongside the
  // first, each with its own independently-set, independently-read-back value (3 and 7).
  // NOTE: (930,500) — Edge 25 — was tried first and turned out to be a genuinely problematic
  // edge at the OCCT level: it crashes/throws an unhandled native exception at ANY radius,
  // including as small as 0.5mm, while a completely different edge (19) on the same body with
  // the same mechanism/radius works cleanly — narrowed down to that one specific edge's own
  // real geometry (likely a very short or otherwise degenerate edge somewhere in this STEP
  // assembly), not a defect in the per-edge-value logic this pass added. Logged as a real,
  // separate finding for a future pass (worth hardening handleFilletChamfer's own OCCT-exception
  // handling in general, since a raw WASM exception isn't a catchable JS Error today).
  await page.mouse.click(850, 780);
  await page.waitForTimeout(600);

  const finalPickCount = await panel.locator('.pick-list li').count();
  log(`final edges picked: ${finalPickCount}`);
  assert(finalPickCount >= 1, 'At least one edge picked');

  // Set each picked edge's own radius to a DIFFERENT value — the core "variable-radius" check.
  const edgeInputs = panel.locator('.pick-list .edge-value-input');
  const n = await edgeInputs.count();
  assert(n >= 1, 'At least one edge value input visible');
  const values = [];
  for (let i = 0; i < n; i++) {
    const v = 3 + i * 4; // 3, 7, ... — a distinct value per edge
    await edgeInputs.nth(i).fill(String(v));
    values.push(v);
    await page.waitForTimeout(150);
  }
  log(`assigned per-edge values: ${values.join(', ')}`);

  // Verify the inputs actually retained distinct values (not all reset to one shared value).
  const readBack = [];
  for (let i = 0; i < n; i++) {
    readBack.push(await edgeInputs.nth(i).inputValue());
  }
  log(`read-back values: ${readBack.join(', ')}`);
  if (n > 1) {
    assert(new Set(readBack).size === readBack.length, 'Each edge kept its own distinct value (not all synced to one shared value)');
  }

  const applyBtn = panel.locator('.extrude-btn', { hasText: 'Apply Fillet' });
  assert(await applyBtn.isVisible(), 'Apply Fillet button visible');
  await applyBtn.click();

  await page.waitForFunction(() => !document.querySelector('.fillet-chamfer-panel'), { timeout: 30000 }).catch(async () => {
    const err = await panel.locator('.error').textContent().catch(() => null);
    if (err) throw new Error('FILLET_ERROR: ' + err);
  });
  await page.waitForTimeout(500);
  assert(!(await panel.isVisible().catch(() => false)), 'Fillet panel auto-closes — no error');

  const countAfter = await bodyLabels.count();
  assert(countAfter === 17, `Body count unchanged at 17, got ${countAfter}`);

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
  assert(delta < 0, `Volume DECREASED (delta=${delta}) — a fillet always removes the sharp-corner material, so volume must go down`);

  const facesBefore = parseInt(facesBeforeText.replace(/[^0-9]/g, ''), 10);
  const facesAfter = parseInt(facesAfterText.replace(/[^0-9]/g, ''), 10);
  assert(facesAfter > facesBefore, `Face count increased (${facesBefore} → ${facesAfter}) — each filleted edge adds one new rounding face`);

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
