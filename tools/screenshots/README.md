# README screenshots

`shoot.js` photographs the manager's own UI for `docs/screenshots/`.

It loads the real `src/renderer/index.html` in Chromium with `window.api` stubbed, so what comes out is
the app's own markup and stylesheet rather than a drawing of them. The app proper will not run here --
its detection reads PE headers off real Windows game folders -- so the stub answers what `main.js`
would have, with six games chosen to cover every state a card can be in.

```
npm i -D playwright   # if it is not already about
node tools/screenshots/shoot.js
```

It writes `manager-game-grid.png` and `game-help.png` beside itself; copy them into `docs/screenshots/`.

Two things to keep in mind when it breaks:

- **The stub follows the renderer, not the other way round.** A new `window.api` call whose result the
  renderer reads a field off will throw before any card exists. The default answer is `{}` for exactly
  that reason; add a real shape to `over` when `{}` is not enough.
- **Codes have to be real.** The card's one problem row and Game Help's headline both come from
  `helpShort()` / `helpFixLabel()` in `renderer.js`, which switch on `diag.code` and `diag.fix.id`.
  An invented code renders as "no known fix" and an invented fix id renders as itself.

The two `dlssnr-panel-*.png` are real captures from a game and are not produced here.
