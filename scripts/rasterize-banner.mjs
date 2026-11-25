// scripts/rasterize-banner.mjs —— 把 assets/banner.svg 光栅化成 PNG（精确 2172×724），供后续转 WebP。
// 为什么是 .mjs：ego-browser 只吃 `ego-browser nodejs` 这种入口（AGENTS 里对 ego 脚本的例外）。
const task = await taskSpace('rasterize banner svg');
const page = task.page('p1');

const SVG = 'file:///D:/project/dsh1/dsh-remote-wsl/assets/banner.svg';
const OUT = 'D:/project/dsh1/dsh-remote-wsl/_banner.tmp.png';
const W = 2172;
const H = 724;

await page.goto(SVG);
await new Promise((r) => setTimeout(r, 800));

const shot = await page.cdp('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
});
const fs = await import('node:fs/promises');
await fs.writeFile(OUT, Buffer.from(shot.data, 'base64'));
console.log('rasterized ->', OUT);
