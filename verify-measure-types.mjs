// Regression: Measure tool modes (angle, face-to-face, radius/diameter). Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
import { chromium } from 'playwright';

const log = (m) => console.log(`[measure] ${m}`);
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); log('OK: ' + msg); };
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errs = [];

async function freshPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:4300', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  return page;
}

async function addPrimitive(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  const cv = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(cv.x + cv.width / 2, cv.y + cv.height / 2);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tree-node .node-label').length > 2, { timeout: 120000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('f');
  await page.waitForTimeout(1200);
}

const openMeasure = async (page, mode) => {
  if (!(await page.locator('.measure-panel').count())) await page.keyboard.press('m');
  await page.locator('.measure-panel').waitFor();
  await page.locator('.measure-panel .kind-btn', { hasText: mode }).click();
};
const view = async (page, key) => { await page.keyboard.press(key); await page.waitForTimeout(1600); };
const rows = (page) => page.locator('.measure-panel .measurement-row').allTextContents().then((a) => a.map((s) => s.trim()));

try {
  // ---------- 50 mm cube: face-to-face distance and angle, 3-point angle
  let page = await freshPage();
  await addPrimitive(page, 'Box');
  const cv = await page.locator('canvas').first().boundingBox();
  const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;

  await openMeasure(page, 'Faces');
  await view(page, '5'); await page.mouse.click(cx, cy); await page.waitForTimeout(300);   // top face
  await view(page, '6'); await page.mouse.click(cx, cy); await page.waitForTimeout(400);   // bottom face
  let r = await rows(page);
  log('face rows: ' + JSON.stringify(r));
  check(r.some((t) => /^50\.00 mm \(parallel faces\)$/.test(t)), 'top-to-bottom faces of a 50 mm cube: 50.00 mm, parallel');

  await view(page, '5'); await page.mouse.click(cx, cy); await page.waitForTimeout(300);   // top face
  await view(page, '1'); await page.mouse.click(cx, cy); await page.waitForTimeout(400);   // front face
  r = await rows(page);
  log('face rows: ' + JSON.stringify(r));
  check(r.some((t) => /^90\.00° between faces$/.test(t)), 'top-to-front faces: 90.00°');

  await openMeasure(page, 'Angle');
  await view(page, '5');
  await page.mouse.click(cx + 50, cy); await page.waitForTimeout(200);
  await page.mouse.click(cx, cy); await page.waitForTimeout(200);          // vertex
  await page.mouse.click(cx, cy - 50); await page.waitForTimeout(400);
  r = await rows(page);
  log('angle rows: ' + JSON.stringify(r));
  const ang = r.map((t) => /^(\d+\.\d+)°$/.exec(t)).find(Boolean);
  check(ang && Math.abs(parseFloat(ang[1]) - 90) < 0.5, `three-point angle on the top face ≈ 90° (got ${ang && ang[1]}°)`);
  const before = (await rows(page)).length;
  await page.locator('.measure-panel .clear-btn').click();
  check((await rows(page)).length === 0 && before > 0, 'Clear All removes the measurements');
  await page.close();

  // ---------- 25 mm radius cylinder: radius/diameter, and a non-planar face is rejected
  page = await freshPage();
  await addPrimitive(page, 'Cylinder');
  const cv2 = await page.locator('canvas').first().boundingBox();
  const cx2 = cv2.x + cv2.width / 2, cy2 = cv2.y + cv2.height / 2;

  await openMeasure(page, 'Radius');
  await view(page, '5');
  let found = null;
  for (let dx = 15; dx < 420 && !found; dx += 3) {
    await page.mouse.click(cx2 + dx, cy2); await page.waitForTimeout(120);
    const rr = await rows(page);
    if (rr.length) found = rr[0];
  }
  log('circle row: ' + found);
  check(found && /^R 25\.00 mm\s+Ø 50\.00 mm$/.test(found), 'circular edge of a 25 mm-radius cylinder: R 25.00 mm, Ø 50.00 mm');

  await openMeasure(page, 'Faces');
  await view(page, '1'); await page.mouse.click(cx2, cy2); await page.waitForTimeout(400);
  const err = (await page.locator('.measure-panel .error').textContent().catch(() => '')) || '';
  check(/not planar/i.test(err), `curved face is rejected with a clear message ("${err.trim()}")`);
  await page.close();
} catch (e) {
  log('FAILED: ' + String(e).slice(0, 500));
  process.exitCode = 1;
} finally {
  log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`);
  if (errs.length) process.exitCode = 1;
  await browser.close();
}
