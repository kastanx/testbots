const nut = require('@nut-tree-fork/nut-js');
(async () => {
  nut.mouse.config.mouseSpeed = 2000;
  await nut.mouse.setPosition(new nut.Point(1815, 862));
  await nut.mouse.leftClick();
  console.log('clicked Zrusit at 1815,862');
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
