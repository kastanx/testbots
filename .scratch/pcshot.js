const nut = require('@nut-tree-fork/nut-js');
(async () => {
  const w = await nut.screen.width();
  const h = await nut.screen.height();
  console.log(JSON.stringify({ screenWidth: w, screenHeight: h }));
  nut.screen.config.highlightDurationMs = 0;
  const img = await nut.screen.grab();
  const path = require('path');
  await nut.screen.capture('pcshot.png', nut.FileType.PNG, path.resolve('.scratch'));
  console.log('captured');
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
