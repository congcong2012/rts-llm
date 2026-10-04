/**
 * Renderer entry point (docs/ROADMAP.md 任务 4).
 *
 * Boot order matters:
 *   1. create the Phaser game with both scenes,
 *   2. inject the shared `WorldModel` and the order sender into the scenes,
 *   3. open the WebSocket.
 *
 * The game boots before `init` arrives, so the scene starts with a 64×64 default
 * and re-lays-out its static layers when the server's real map dimensions arrive
 * (`world-init`). That keeps the scene code free of "not connected yet" branches.
 */

import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';
import { HudScene } from './scenes/HudScene';
import { NetClient } from './net/NetClient';
import { WorldModel } from './state/WorldModel';

function boot(): void {
  const model = new WorldModel();
  const gameScene = new GameScene();
  const hudScene = new HudScene();

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#05070c',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      // The fog layer is a 64×64 texture blown up 32×; nearest-neighbour keeps
      // its tile boundaries crisp instead of blurring them.
      pixelArt: true,
      antialias: false,
      roundPixels: false,
    },
    banner: false,
    scene: [gameScene, hudScene],
  });

  const client = new NetClient(model, {
    onMessage: (message) => {
      if (message.t === 'init') game.events.emit('world-init');
    },
  });

  // Wire the scenes: `model` and the sender are injected rather than imported so
  // both scenes stay independently testable and there is no module-level state.
  gameScene.model = model;
  gameScene.sendOrders = (actions) => client.sendActions(actions);
  gameScene.toast = (message) => hudScene.showToast(message);

  hudScene.model = model;
  hudScene.retryConnection = () => client.connect();

  client.connect();

  // Exposed for the acceptance walkthrough / debugging in DevTools.
  Object.assign(window as unknown as Record<string, unknown>, {
    __rts: { game, model, client, gameScene, hudScene },
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
