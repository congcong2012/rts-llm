/**
 * Phase 2 acceptance walkthrough (B1..B8) — a local, automated harness.
 *
 * docs/ROADMAP.md lists B1..B8 as manual checks. This script performs the same
 * checks automatically against the real dev stack, which makes them repeatable:
 * run it after touching the renderer to see immediately whether something broke.
 *
 * It is deliberately NOT part of `npm test`: it needs a real browser and a
 * running server, and it is much slower than the unit suite.
 *
 * ── Prerequisites ────────────────────────────────────────────────────────────
 *   1. A Chromium/Chrome binary (default path is the Playwright cache).
 *   2. The `playwright-core` package. Install it anywhere and point at it:
 *
 *        npm install --no-save playwright-core
 *        PLAYWRIGHT=./node_modules/playwright-core node scripts/browser-acceptance.cjs
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   # Peaceful sandbox: easiest for the interaction checks (B2..B6).
 *   OPPONENT=off npm run server
 *   npm run dev:web
 *   node scripts/browser-acceptance.cjs
 *
 *   # With the red commander active (checks B7 ghosts / B8 against a real fight).
 *   npm run dev
 *   node scripts/browser-acceptance.cjs
 *
 * Environment:
 *   CHROME_PATH  Chromium/Chrome executable
 *   RTS_URL      client URL (default http://localhost:5173/)
 *   PLAYWRIGHT   directory of the playwright-core module
 *
 * ── Gotchas learned the hard way ─────────────────────────────────────────────
 *  - Launch with DEFAULT headless GL. Forcing `--use-gl=swiftshader` makes Phaser
 *    4's shaders fail to compile; the render loop then stops silently and every
 *    interaction check fails for an unrelated reason.
 *  - The B8 leak scan is only meaningful against a FRESH server. After a few
 *    minutes the red army has legitimately walked into view, so the ids become
 *    visible on purpose.
 *  - A moving unit is a step ahead of the position you projected. Always re-read
 *    the live sample immediately before clicking, and verify the OUTCOME
 *    (selection / travel), not merely that a click was issued.
 */

const path = require('node:path');
const fs = require('node:fs');

const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT ?? 'playwright-core';
const { chromium } = require(PLAYWRIGHT_DIR);

const OUT_DIR = path.join(__dirname, '..', 'logs', 'acceptance-shots');
const CHROME = process.env.CHROME_PATH;
const URL = process.env.RTS_URL ?? 'http://localhost:5173/';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const launchOptions = { headless: true };
  if (CHROME !== undefined && CHROME.length > 0) launchOptions.executablePath = CHROME;
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(
    () =>
      window.__rts !== undefined && window.__rts.model !== undefined && window.__rts.model.gameId !== '',
    { timeout: 20000 },
  );

  // Tap every snapshot the client receives, so B8 can scan the raw wire payloads.
  await page.evaluate(() => {
    window.__frames = [];
    const model = window.__rts.model;
    const original = model.applySnapshot.bind(model);
    model.applySnapshot = (snapshot, now) => {
      window.__frames.push(JSON.stringify({ t: 'snap', snapshot }));
      return original(snapshot, now);
    };
  });

  const readModel = () =>
    page.evaluate(() => {
      const { model, game, client } = window.__rts;
      const scene = game.scene.getScene('game');
      const camera = scene === null ? null : scene.cameras.main;
      return {
        width: model.width,
        height: model.height,
        tick: model.tick,
        connection: model.connection,
        crystal: model.crystal,
        pop: model.pop,
        popCap: model.popCap,
        fps: model.fps,
        entities: model.sampleAll(performance.now()).map((entity) => ({
          id: entity.id,
          k: entity.k,
          o: entity.o,
          s: entity.s,
          x: entity.x,
          y: entity.y,
          carry: entity.carry,
          task: entity.task ?? null,
        })),
        blockedCount: model.blockedTiles.size,
        fogRows: model.fog === null ? 0 : model.fog.exploredRows.length,
        explored: scene === null ? -1 : scene.exploredRatio,
        selection: scene === null ? [] : [...scene.selectionIds],
        zoom: camera === null ? 0 : camera.zoom,
        scrollX: camera === null ? 0 : camera.scrollX,
        scrollY: camera === null ? 0 : camera.scrollY,
        viewW: camera === null ? 0 : camera.width / camera.zoom,
        viewH: camera === null ? 0 : camera.height / camera.zoom,
        ping: client.lastPingMs,
      };
    });

  /** Project a continuous world position (tile units) and a tile index to CSS px. */
  const projectWorld = (tileUnitsX, tileUnitsY) =>
    page.evaluate(
      ([wx, wy]) => {
        const camera = window.__rts.game.scene.getScene('game').cameras.main;
        const rect = window.__rts.game.canvas.getBoundingClientRect();
        const toScreen = (world, scroll, size) =>
          (world - scroll - size / 2) * camera.zoom + size / 2;
        return {
          sx: rect.left + toScreen(wx * 32, camera.scrollX, camera.width) * (rect.width / camera.width),
          sy: rect.top + toScreen(wy * 32, camera.scrollY, camera.height) * (rect.height / camera.height),
        };
      },
      [tileUnitsX, tileUnitsY],
    );
  const project = (tileX, tileY) => projectWorld(tileX + 0.5, tileY + 0.5);

  /** Click wherever an entity currently is. */
  const clickEntity = async (id, button = 'left') => {
    const live = await page.evaluate((entityId) => {
      const entity = window.__rts.game
        .scene.getScene('game')
        .sampledEntities.find((candidate) => candidate.id === entityId);
      return entity === undefined ? null : { x: entity.x, y: entity.y };
    }, id);
    if (live === null) return false;
    const point = await projectWorld(live.x, live.y);
    await page.mouse.click(point.sx, point.sy, button === 'right' ? { button: 'right' } : undefined);
    await sleep(200);
    return true;
  };

  /** Select an entity, retrying until the selection actually contains it. */
  const selectEntity = async (id, attempts = 6) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await clickEntity(id);
      const selection = await page.evaluate(() => [
        ...window.__rts.game.scene.getScene('game').selectionIds,
      ]);
      if (selection.length === 1 && selection[0] === id) return true;
      await sleep(120);
    }
    return false;
  };

  // The FPS meter needs one sampling window (500 ms) and the fog needs its
  // 800 ms reveal transition to settle, so every time-dependent read happens
  // after this settle delay — otherwise both look broken when they are not.
  await sleep(1400);

  const fresh = await readModel();

  // ── B1: map, base, terrain, initial fog ───────────────────────────────────
  check('B1 map is 64x64', fresh.width === 64 && fresh.height === 64, `${fresh.width}x${fresh.height}`);
  const ownBase = fresh.entities.find((entity) => entity.k === 2 && entity.o === 0);
  check('B1 own base visible', ownBase !== undefined, ownBase === undefined ? 'missing' : `${ownBase.id} @ ${ownBase.x.toFixed(1)},${ownBase.y.toFixed(1)}`);
  check('B1 rocks decoded from init (public terrain)', fresh.blockedCount > 0, `${fresh.blockedCount} blocked tiles`);
  check('B1 explored mask has one row per map row', fresh.fogRows === 64, `${fresh.fogRows} rows`);
  check('B1 map starts mostly unexplored', fresh.explored > 0 && fresh.explored < 0.6, `${(fresh.explored * 100).toFixed(1)}% explored`);
  check('B1 connection open', fresh.connection === 'open', fresh.connection);

  const baseOnScreen = await page.evaluate(() => {
    const { model, game } = window.__rts;
    const camera = game.scene.getScene('game').cameras.main;
    const base = model.ownBase;
    if (base === null) return { ok: false };
    const sx = (base.x * 32 - camera.scrollX - camera.width / 2) * camera.zoom + camera.width / 2;
    const sy = (base.y * 32 - camera.scrollY - camera.height / 2) * camera.zoom + camera.height / 2;
    return { ok: sx > 0 && sx < camera.width && sy > 0 && sy < camera.height, sx, sy };
  });
  check('B1 camera starts on the own base', baseOnScreen.ok === true, `screen ${baseOnScreen.sx?.toFixed(0)},${baseOnScreen.sy?.toFixed(0)}`);

  // ── B5: HUD (checked early so a HUD failure does not need a long wait) ────
  const readHud = () =>
    page.evaluate(() => ({
      tick: document.getElementById('stat-tick').textContent,
      fps: document.getElementById('stat-fps').textContent,
      conn: document.getElementById('stat-conn').textContent,
      crystal: document.getElementById('stat-crystal').textContent,
      pop: document.getElementById('stat-pop').textContent,
      fog: document.getElementById('stat-fog').textContent,
      seed: document.getElementById('stat-seed').textContent,
      overlayHidden: document.getElementById('overlay').hasAttribute('hidden'),
    }));
  const hud = await readHud();
  check(
    'B5 HUD renders tick / fps / crystal / pop / fog / seed',
    /^[0-9]+$/.test(hud.tick) && /^[0-9]+$/.test(hud.fps) && /^[0-9]+$/.test(hud.crystal) && /%$/.test(hud.fog) && hud.pop.includes('/'),
    JSON.stringify(hud).slice(0, 180),
  );
  check('B5 FPS is at least 55 with fog enabled', Number(hud.fps) >= 55, `${hud.fps} fps`);
  check('B5 overlay hidden while connected', hud.overlayHidden === true);
  check('B5 connection reported as connected', hud.conn.includes('已连接'), hud.conn);

  // ── B8: the raw frames must not contain anything the human cannot see ─────
  const framesSoFar = await page.evaluate(() => window.__frames.join('\n'));
  const leakCandidates = ['b2', '"u5"', '"u6"', '"u7"', '"u8"'];
  const leaks = leakCandidates.filter((id) => framesSoFar.includes(id));
  check(
    'B8 no unseen enemy id in any received frame',
    leaks.length === 0,
    leaks.length === 0 ? `${(framesSoFar.length / 1024).toFixed(1)} KB scanned` : `leaked ${leaks.join(',')}`,
  );
  const enemyRows = fresh.entities.filter((entity) => entity.o === 1).length;
  check(
    'B8 no enemy entity row while nothing is in vision',
    fresh.tick < 300 ? enemyRows === 0 : true,
    `${enemyRows} enemy rows at tick ${fresh.tick}${fresh.tick >= 300 ? ' (server not fresh — informational)' : ''}`,
  );

  const worker = fresh.entities.find((entity) => entity.k === 0 && entity.o === 0);
  check('B2 an own worker exists', worker !== undefined, worker?.id);

  if (worker !== undefined) {
    // ── B2: click select, empty-ground clear, box select ────────────────────
    const selected = await selectEntity(worker.id);
    check('B2 single click selects exactly the clicked worker', selected, JSON.stringify((await readModel()).selection));
    await page.screenshot({ path: path.join(OUT_DIR, '02-selected.png') });

    const emptyTile = await page.evaluate(() => {
      const { model, game } = window.__rts;
      const camera = game.scene.getScene('game').cameras.main;
      const samples = game.scene.getScene('game').sampledEntities;
      const onScreen = (tileX, tileY) => {
        const sx = (tileX * 32 - camera.scrollX - camera.width / 2) * camera.zoom + camera.width / 2;
        const sy = (tileY * 32 - camera.scrollY - camera.height / 2) * camera.zoom + camera.height / 2;
        return sx > 40 && sx < camera.width - 40 && sy > 120 && sy < camera.height - 120;
      };
      for (let ty = 0; ty < model.height; ty += 1) {
        for (let tx = 0; tx < model.width; tx += 1) {
          if (model.blockedTiles.has(ty * model.width + tx)) continue;
          if (!onScreen(tx + 0.5, ty + 0.5)) continue;
          if (samples.some((e) => Math.hypot(e.x - (tx + 0.5), e.y - (ty + 0.5)) < 2)) continue;
          return { x: tx, y: ty };
        }
      }
      return null;
    });
    check('B2 an empty on-screen tile exists to click', emptyTile !== null, JSON.stringify(emptyTile));
    if (emptyTile !== null) {
      const empty = await project(emptyTile.x, emptyTile.y);
      await page.mouse.click(empty.sx, empty.sy);
      await sleep(250);
      check('B2 clicking empty ground clears the selection', (await readModel()).selection.length === 0);
    }

    const topLeft = await project(4, 4);
    const bottomRight = await project(20, 20);
    await page.mouse.move(topLeft.sx, topLeft.sy);
    await page.mouse.down();
    await page.mouse.move(bottomRight.sx, bottomRight.sy, { steps: 10 });
    await page.mouse.up();
    await sleep(250);
    const boxed = await readModel();
    check('B2 box select returns own units', boxed.selection.length > 1, `${boxed.selection.length} selected`);
    check(
      'B2 box select never includes a non-own entity',
      boxed.entities.filter((e) => boxed.selection.includes(e.id) && e.o !== 0).length === 0,
    );
    await page.screenshot({ path: path.join(OUT_DIR, '03-boxselect.png') });

    // ── B3: right-click ground issues an interpolated move ─────────────────
    await selectEntity(worker.id);
    const startEntity = (await readModel()).entities.find((entity) => entity.id === worker.id);
    const destPoint = await project(Math.floor(startEntity.x) + 7, Math.floor(startEntity.y) + 4);
    await page.mouse.click(destPoint.sx, destPoint.sy, { button: 'right' });

    const walk = [];
    for (let i = 0; i < 14; i += 1) {
      const snapshot = await readModel();
      const entity = snapshot.entities.find((candidate) => candidate.id === worker.id);
      if (entity !== undefined) walk.push({ x: entity.x, y: entity.y });
      await sleep(90);
    }
    const travelled =
      walk.length < 2 ? 0 : Math.hypot(walk[walk.length - 1].x - walk[0].x, walk[walk.length - 1].y - walk[0].y);
    check('B3 right-click on ground issues a move', travelled > 1.0, `travelled ${travelled.toFixed(2)} tiles in ~1.3s`);
    let maxStep = 0;
    for (let i = 1; i < walk.length; i += 1) {
      maxStep = Math.max(maxStep, Math.hypot(walk[i].x - walk[i - 1].x, walk[i].y - walk[i - 1].y));
    }
    check('B3 movement is interpolated (no 1-tile teleports)', maxStep < 0.5, `max step ${maxStep.toFixed(3)} tiles/sample`);
    await page.screenshot({ path: path.join(OUT_DIR, '04-moved.png') });

    // ── B7 (part 2): marching into the unknown reveals tiles, monotonically ─
    const exploredTrace = [(await readModel()).explored];
    let marchEntity = (await readModel()).entities.find((entity) => entity.id === worker.id);
    for (let leg = 0; leg < 4 && marchEntity !== undefined; leg += 1) {
      await selectEntity(worker.id);
      const legPoint = await project(marchEntity.x + 7, marchEntity.y + 3);
      await page.mouse.click(legPoint.sx, legPoint.sy, { button: 'right' });
      await sleep(3200);
      const legModel = await readModel();
      exploredTrace.push(legModel.explored);
      marchEntity = legModel.entities.find((entity) => entity.id === worker.id);
    }
    const monotonic = exploredTrace.every((value, index) => index === 0 || value >= exploredTrace[index - 1]);
    check(
      'B7 walking into the unknown reveals tiles, and fog never shrinks',
      monotonic && exploredTrace[exploredTrace.length - 1] > exploredTrace[0],
      exploredTrace.map((value) => `${(value * 100).toFixed(1)}%`).join(' → '),
    );
    await page.screenshot({ path: path.join(OUT_DIR, '04b-march.png') });

  // ── B7 (part 1): the fog layer's three alpha states, read from the texture ─
  const fogStates = await page.evaluate(() => {
    const { model, game } = window.__rts;
    const scene = game.scene.getScene('game');
    const ctx = scene.fogLayer.image.texture.getContext();
    const alphaAt = (tx, ty) => ctx.getImageData(tx, ty, 1, 1).data[3];
    let exploredNotVisible = null;
    for (let ty = 0; ty < model.height && exploredNotVisible === null; ty += 1) {
      for (let tx = 0; tx < model.width; tx += 1) {
        const nib = parseInt(model.fog.exploredRows[ty][tx >> 2] ?? '0', 16);
        if ((nib & (1 << (3 - (tx & 3)))) === 0) continue;
        if (model.visibleTiles !== null && model.visibleTiles[ty * model.width + tx] === 1) continue;
        exploredNotVisible = alphaAt(tx, ty);
        break;
      }
    }
    const base = model.ownBase;
    return {
      visible: alphaAt(Math.floor(base.x), Math.floor(base.y)),
      unexplored: alphaAt(model.width - 2, model.height - 2),
      exploredNotVisible,
      foundExploredNotVisible: exploredNotVisible !== null,
    };
  });
  check(
    'B7 fog is three-state: unexplored opaque, explored dimmed, visible clear',
    fogStates.unexplored >= 250 &&
      fogStates.visible <= 4 &&
      fogStates.exploredNotVisible !== null &&
      Math.abs(fogStates.exploredNotVisible - 114.75) < 6,
    `unexplored=${fogStates.unexplored} exploredDim=${fogStates.exploredNotVisible} visible=${fogStates.visible} (0..255)`,
  );
  if (fogStates.foundExploredNotVisible === false) {
    console.log('      note: every explored tile was still inside vision, so the dim state was not sampled yet');
  }

    // ── B4: right-click a crystal starts a gather cycle ────────────────────
    const crystal = await page.evaluate(() => {
      const found = window.__rts.game
        .scene.getScene('game')
        .sampledEntities.find((entity) => entity.k === 4);
      return found === undefined ? null : { id: found.id, x: found.x, y: found.y };
    });
    check('B4 at least one crystal is visible', crystal !== null, crystal?.id);
    if (crystal !== null) {
      await selectEntity(worker.id);
      const before = await readModel();
      await clickEntity(crystal.id, 'right');
      await sleep(11000);
      const after = await readModel();
      const state = after.entities.find((entity) => entity.id === worker.id);
      check(
        'B4 right-click on a crystal starts a gather cycle',
        after.crystal > before.crystal ||
          (state !== undefined && (state.carry > 0 || state.task !== null || state.s === 2)),
        `crystal ${before.crystal} → ${after.crystal}, carry=${state?.carry}, state=${state?.s}, task=${state?.task}`,
      );
      await page.screenshot({ path: path.join(OUT_DIR, '05-gather.png') });
    }
  }

  // ── B6: camera pan, recentre, zoom clamps, bounds ────────────────────────
  const beforePan = await readModel();
  await page.keyboard.down('KeyD');
  await sleep(600);
  await page.keyboard.up('KeyD');
  await sleep(150);
  const afterPan = await readModel();
  check('B6 WASD pans the camera', afterPan.scrollX > beforePan.scrollX, `scrollX ${beforePan.scrollX.toFixed(0)} → ${afterPan.scrollX.toFixed(0)}`);

  await page.keyboard.press('Space');
  await sleep(500);
  const spaceBase = await page.evaluate(() => {
    const { model, game } = window.__rts;
    const camera = game.scene.getScene('game').cameras.main;
    const base = model.ownBase;
    const sx = (base.x * 32 - camera.scrollX - camera.width / 2) * camera.zoom + camera.width / 2;
    const sy = (base.y * 32 - camera.scrollY - camera.height / 2) * camera.zoom + camera.height / 2;
    return { ok: sx >= 0 && sx <= camera.width && sy >= 0 && sy <= camera.height, sx, sy };
  });
  check('B6 Space brings the own base into view', spaceBase.ok === true, `base at screen ${spaceBase.sx?.toFixed(0)},${spaceBase.sy?.toFixed(0)}`);

  for (let i = 0; i < 40; i += 1) await page.keyboard.press('KeyE');
  await sleep(300);
  const zoomIn = await readModel();
  for (let i = 0; i < 80; i += 1) await page.keyboard.press('KeyQ');
  await sleep(300);
  const zoomOut = await readModel();
  check('B6 zoom-in clamps to 2.0', Math.abs(zoomIn.zoom - 2.0) < 1e-6, `${zoomIn.zoom}`);
  check('B6 zoom-out clamps to 0.35', Math.abs(zoomOut.zoom - 0.35) < 1e-6, `${zoomOut.zoom}`);

  await page.evaluate(() => {
    window.__rts.game.scene.getScene('game').cameras.main.setZoom(1);
  });
  await page.keyboard.down('KeyA');
  await sleep(2500);
  await page.keyboard.up('KeyA');
  const leftEdge = await readModel();
  await page.keyboard.down('KeyD');
  await sleep(4000);
  await page.keyboard.up('KeyD');
  const rightEdge = await readModel();

  const world = 64 * 32;
  const clampReport = (state) => ({
    ok:
      (state.viewW > world || (state.scrollX >= -0.5 && state.scrollX + state.viewW <= world + 0.5)) &&
      (state.viewH > world || (state.scrollY >= -0.5 && state.scrollY + state.viewH <= world + 0.5)),
    detail: `${state.scrollX.toFixed(0)},${state.scrollY.toFixed(0)} view ${state.viewW.toFixed(0)}x${state.viewH.toFixed(0)}`,
  });
  const left = clampReport(leftEdge);
  const right = clampReport(rightEdge);
  check('B6 camera is clamped to the map bounds', left.ok && right.ok, `${left.detail} | ${right.detail}`);
  check('B6 panning right actually moved', rightEdge.scrollX > leftEdge.scrollX, `${leftEdge.scrollX.toFixed(0)} → ${rightEdge.scrollX.toFixed(0)}`);
  await page.screenshot({ path: path.join(OUT_DIR, '06-camera.png') });

  // ── B7 (part 3): units vanish when unseen; buildings leave ghosts ────────
  const streamSummary = await page.evaluate(() => {
    const frames = window.__frames.map((raw) => JSON.parse(raw));
    const seen = new Set();
    for (const frame of frames) {
      for (const row of frame.snapshot.entities) if (row.o === 1) seen.add(row.id);
    }
    const last = frames[frames.length - 1];
    const presentNow = new Set(last.snapshot.entities.map((row) => row.id));
    return {
      everSeen: [...seen],
      goneNow: [...seen].filter((id) => !presentNow.has(id)),
      ghostKinds: last.snapshot.ghosts.map((ghost) => ghost.kind),
    };
  });
  check(
    'B7 an enemy unit that leaves vision disappears from the stream',
    streamSummary.everSeen.length === 0 || streamSummary.goneNow.length > 0,
    `everSeen=${streamSummary.everSeen.length}, goneNow=${streamSummary.goneNow.length}`,
  );
  check(
    'B7 ghosts are buildings only (never units or crystals)',
    streamSummary.ghostKinds.every((kind) => kind === 'base' || kind === 'barracks'),
    streamSummary.ghostKinds.join(',') || '(none yet)',
  );

  await page.screenshot({ path: path.join(OUT_DIR, '07-final.png') });
  await page.evaluate(() => {
    window.__rts.game.scene.getScene('game').cameras.main.setZoom(2);
  });
  await page.keyboard.press('Space');
  await sleep(600);
  await page.screenshot({ path: path.join(OUT_DIR, '08-closeup.png') });

  const realErrors = consoleErrors.filter((text) => !text.includes('favicon'));
  check('no uncaught page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots: ${OUT_DIR}`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail ?? ''}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('acceptance run crashed:', error);
  process.exitCode = 1;
});
