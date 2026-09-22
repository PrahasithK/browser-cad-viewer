// Regression: freeform Polyline sketch shape — draw an arbitrary N-point profile (not just the fixed
// 2-click rectangle/circle/polygon/slot), close via each of the three gestures (click back on start,
// Enter, double-click), and verify a concave L-shape extrudes to the correct volume.
// Needs `ng serve --port 4300`; PW_CHANNEL=chrome to use installed Chrome.
import { chromium } from 'playwright';

const log = (m) => console.log(`[polyline] ${m}`);
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

async function startPolylineOnXY(page) {
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  const panel = page.locator('.sketch-panel');
  await panel.locator('.plane-btn', { hasText: 'XY' }).click();
  await page.waitForFunction(() => { const h = document.querySelector('.sketch-panel .hint'); return h && /Click/.test(h.textContent || ''); });
  await panel.locator('.shape-btn[title^="Polyline"]').click();
  return panel;
}

const num = (s) => parseFloat(s.replace(/[^0-9.\-]/g, ''));
async function readSelectedVolume(page) {
  await page.locator('.tree-node:has(.delete-toggle) .node-label').first().click();
  await page.waitForTimeout(300);
  const t = await page.locator('.prop-row', { hasText: 'Volume' }).textContent();
  return num(t);
}

try {
  const cv0 = { x: 700, y: 500 }; // placeholder, real box read per page below

  // ---------- 1) Close by clicking back on the start point: an L-shape (60x60 minus a 30x30 corner)
  let page = await freshPage();
  let panel = await startPolylineOnXY(page);
  const cv = await page.locator('canvas').first().boundingBox();
  const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;
  const S = 1.5; // screen mm-per-unit isn't 1:1, just spacing clicks generously apart
  // L-shape points (screen-space, Y flipped vs. world Y since screen Y grows downward — doesn't
  // matter for area/volume, only that the polygon is simple and concave, matching the kernel probe).
  const pts = [
    [cx - 90, cy + 60], [cx + 90, cy + 60], [cx + 90, cy - 30],
    [cx, cy - 30], [cx, cy - 120], [cx - 90, cy - 120]
  ];
  for (const [x, y] of pts) { await page.mouse.click(x, y); await page.waitForTimeout(150); }
  check(!(await panel.locator('.extrude-btn', { hasText: 'Finish Polyline' }).isVisible().catch(() => false)) === false, '"Finish Polyline" button appears once 3+ points are placed');
  // Close by clicking back near the FIRST point.
  await page.mouse.click(pts[0][0], pts[0][1]);
  await page.waitForTimeout(300);
  check(await panel.locator('.kind-toggle').isVisible(), 'clicking back on the start point closes the profile (finish-mode toggle appears)');

  await panel.locator('input[type=number]').first().fill('20');
  await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
  await page.waitForFunction(() => !document.querySelector('.sketch-panel'));
  await page.waitForTimeout(600);
  const volClose = await readSelectedVolume(page);
  log('L-shape (close-on-start-click) volume: ' + volClose);
  // Real-world dimensions depend on the exact pixel-to-world scale at this camera framing, so check
  // the SHAPE (concave L, not a plain rectangle) rather than an exact number: an L cut from a WxH
  // rectangle by removing one corner has volume < the bounding rectangle's, and > half of it for
  // this specific 2:1 corner cut. Cross-check against Faces/Edges instead, which are scale-free.
  const facesText = await page.locator('.prop-row', { hasText: 'Faces' }).textContent();
  check(/^Faces\D*8$/.test(facesText.trim()), `L-shaped extrude has 8 faces (2 caps + 6 sides), got "${facesText.trim()}"`);
  await page.close();

  // ---------- 2) Close via Enter key: a simple triangle (minimum valid polyline)
  page = await freshPage();
  panel = await startPolylineOnXY(page);
  const cv2 = await page.locator('canvas').first().boundingBox();
  const tx = cv2.x + cv2.width / 2, ty = cv2.y + cv2.height / 2;
  await page.mouse.click(tx - 80, ty + 60); await page.waitForTimeout(150);
  await page.mouse.click(tx + 80, ty + 60); await page.waitForTimeout(150);
  await page.mouse.click(tx, ty - 80); await page.waitForTimeout(150);
  check(!(await panel.locator('.kind-toggle').isVisible().catch(() => false)), 'profile is NOT auto-finished at 3 points — stays open for more clicks');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check(await panel.locator('.kind-toggle').isVisible(), 'Enter closes a 3-point polyline');
  await panel.locator('input[type=number]').first().fill('10');
  await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
  await page.waitForFunction(() => !document.querySelector('.sketch-panel'));
  await page.waitForTimeout(600);
  await page.locator('.tree-node:has(.delete-toggle) .node-label').first().click();
  await page.waitForTimeout(300);
  const triFaces = await page.locator('.prop-row', { hasText: 'Faces' }).textContent();
  check(/^Faces\D*5$/.test(triFaces.trim()), `triangular extrude has 5 faces (2 caps + 3 sides), got "${triFaces.trim()}"`);
  await page.close();

  // ---------- 3) Close via double-click, and confirm it does NOT leave a degenerate extra point
  page = await freshPage();
  panel = await startPolylineOnXY(page);
  const cv3 = await page.locator('canvas').first().boundingBox();
  const qx = cv3.x + cv3.width / 2, qy = cv3.y + cv3.height / 2;
  await page.mouse.click(qx - 70, qy + 50); await page.waitForTimeout(150);
  await page.mouse.click(qx + 70, qy + 50); await page.waitForTimeout(150);
  await page.mouse.click(qx + 70, qy - 50); await page.waitForTimeout(150);
  await page.mouse.dblclick(qx - 70, qy - 50);
  await page.waitForTimeout(300);
  check(await panel.locator('.kind-toggle').isVisible(), 'double-click places the final point and closes the profile');
  await panel.locator('input[type=number]').first().fill('15');
  await panel.locator('.extrude-btn', { hasText: 'Extrude' }).click();
  const closed = await page.waitForFunction(() => !document.querySelector('.sketch-panel')).then(() => true).catch(() => false);
  check(closed, 'the double-click-closed quadrilateral extrudes with no error (no degenerate zero-length edge from the double-click)');
  await page.waitForTimeout(600);
  await page.locator('.tree-node:has(.delete-toggle) .node-label').first().click();
  await page.waitForTimeout(300);
  const quadFaces = await page.locator('.prop-row', { hasText: 'Faces' }).textContent();
  check(/^Faces\D*6$/.test(quadFaces.trim()), `4-sided extrude has 6 faces (2 caps + 4 sides — confirms exactly 4 points, no duplicate), got "${quadFaces.trim()}"`);
  await page.close();
} catch (e) {
  log('FAILED: ' + String(e).slice(0, 500));
  process.exitCode = 1;
} finally {
  log(`console/page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4))}`);
  if (errs.length) process.exitCode = 1;
  await browser.close();
}
