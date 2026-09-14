import { chromium } from 'playwright';
import fs from 'node:fs';

const FILE  = 'file:///Users/tonyye/Projects/Monitor/design/variations.html';
const SHOTS = '/Users/tonyye/Projects/Monitor/design/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const PAGES  = ['a', 'b', 'c1', 'c2', 'd', 'e', 'attn'];
// v2 · 两个画布高度 × 两个横向补偿系数。1.19 是用户用 aspect-test.html 的圆校准出来的，
// 画布逻辑宽收窄到 round(480/1.19)=403，六页在 403 宽下同样不能溢出。
const CANVASES = [
  { px: 1.00, h: 270, label: '480x270' },
  { px: 1.00, h: 320, label: '480x320' },
  { px: 1.19, h: 270, label: '403x270' },
  { px: 1.19, h: 320, label: '403x320' },
];
const STATES = ['populated', 'loading', 'empty', 'error', 'edge', 'attention', 'running'];
const FONT_FLOOR = 14;                       // R4-06 · 轮播版把下限从 12 抬到 14
// R5-05 · 间距栅格与「允许的例外」。这份清单必须与 tokens.css §6 逐字对应；
// 断言不再靠手写核对，而是运行时扫描全部 gap/padding/margin 后与它比集合。
const SCALE = [0, 2, 4, 8, 12, 16, 24, 32];
const SPACING_EXCEPTIONS = ['6px paddingBottom on .'];   // 与 tokens.css §6 逐条对应

// ---------------- 移植契约（m3-executor 的 stage-css-port 测试依赖它） ----------------
// 他那边断言 app.css 的 STAGE 段与本文件第三个 <style> 块逐字相同。那条断言锚在
// 「第三个」这个序数上，而序数是我这边的实现细节——我多加一个 style 块，他那条测试
// 就会无缘无故变红或变绿。既然这个不变量归我维护，就该由我先断言它：
// 出问题时先红在我这边，而不是红在下游。
{
  const src = fs.readFileSync(FILE.replace('file://', ''), 'utf8');
  const blocks = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  const fail = [];
  if (blocks.length !== 3) fail.push(`<style> 块数是 ${blocks.length}，不是 3`);
  const stage = blocks[2] || '';
  if (!stage.includes('STAGE —— 画布坐标')) fail.push('第三块不是 STAGE 段');
  for (const sel of ['.page-a', '.page-b', '.page-c', '.page-d', '.page-e', '.page-attn'])
    if (!stage.includes(sel)) fail.push(`STAGE 段缺 ${sel}（漏一页就是漏移植）`);
  if (!stage.includes('.page-e .e-time{flex:none')) fail.push('STAGE 段缺 .e-time{flex:none（时间列的命就在这半条）');
  if (stage.includes('.harness')) fail.push('STAGE 段混进了 .harness（工具样式不该被移植）');
  console.log('移植契约:', fail.length ? fail : `ok（3 个 style 块，STAGE 段 ${stage.length} 字节）`);
  if (fail.length) process.exitCode = 1;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

// 字体走 Google Fonts CDN，偶发挂起；等 DOM 就绪即可，字体到位与否不影响断言语义
await page.goto(FILE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
await page.waitForTimeout(900);
await page.uncheck('#chkRotate');            // 逐格检查时关掉轮播，避免页自己跑掉

const problems = [];
let okCount = 0;
let trackReportOnce = null;

for (const cv of CANVASES) {
 await page.evaluate(({ px, h }) => {
   const r = document.getElementById('rngPanel');
   r.value = String(px); r.dispatchEvent(new Event('input', { bubbles: true }));
   document.querySelector(`#segH button[data-h="${h}"]`).click();
 }, cv);
 await page.waitForTimeout(260);
 for (const p of PAGES) {
  for (const s of STATES) {
    await page.click(`#segState button[data-s="${s}"]`);
    await page.click(`#segPage button[data-p="${p}"]`);
    await page.waitForTimeout(200);

    const r = await page.evaluate(({ FONT_FLOOR, SCALE_IN }) => {
      const stage = document.getElementById('stage');
      const sb = stage.getBoundingClientRect();
      const out = [];
      const parse = c => (c.match(/[\d.]+/g) || []).map(Number);
      const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const over = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)); };
      const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
      const bgOf = el => { let n = el;
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.length && (c[3] ?? 1) > 0.95) return c.slice(0, 3);
          n = n.parentElement; } return [7, 8, 10]; };
      const live = document.querySelector('.page[data-on="1"]');

      // 1 · 画布边界。待命页停在画布左外侧是刻意的，不查；4 页 × 7 态的循环
      //     保证每一页都会在「它是当前页」那一格被完整检查。
      // 「越出画布」只对没有裁切祖先的元素成立。省略号截断的内联 span 的 rect
      // 本来就会超出父盒，但它被 overflow:hidden 的祖先夹住，屏上不会露出去——
      // 把它报成越界是口径错，不是缺陷（同一类问题这已经是第三次了）。
      const clipped = n => {
        for (let a = n.parentElement; a && a !== stage.parentElement; a = a.parentElement) {
          const o = getComputedStyle(a);
          if (o.overflowX !== 'visible' || o.overflowY !== 'visible') return true;
        }
        return false;
      };
      for (const n of stage.querySelectorAll('*')) {
        if (n.closest('.sr') || n.closest('.page[data-on="0"]')) continue;
        const b = n.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (b.left < sb.left - 1 || b.right > sb.right + 1 || b.top < sb.top - 1 || b.bottom > sb.bottom + 1) {
          if (clipped(n)) continue;
          out.push(`OUTSIDE ${(typeof n.className === 'string' && n.className) || n.tagName}` +
                   ` < ${(n.parentElement && n.parentElement.className) || '?'}`);
        }
      }
      // 2 · 裁切 / 溢出
      for (const n of stage.querySelectorAll('.screen,.pages,.page,.tiles,.bands,.feed,.tile,.tile-head,.tile-foot,.row,.b-head,.band,.msg,.attn-card')) {
        if (n.closest('.page[data-on="0"]')) continue;
        const cs = getComputedStyle(n);
        if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
          if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)
            out.push(`CLIP ${n.className} ${n.scrollHeight}x${n.scrollWidth} > ${n.clientHeight}x${n.clientWidth}`);
          continue;
        }
        const pb = n.getBoundingClientRect();
        for (const c of n.children) {
          if (c.closest('.sr')) continue;
          if (getComputedStyle(c).transform !== 'none') continue;
          const cb = c.getBoundingClientRect();
          if (cb.width === 0 && cb.height === 0) continue;
          if (cb.top < pb.top - 1 || cb.bottom > pb.bottom + 1 || cb.left < pb.left - 1 || cb.right > pb.right + 1)
            out.push(`SPILL ${c.className || c.tagName} out of ${n.className}`);
        }
      }
      // 3 · 字号下限 14（所有页，它们都会被轮到）
      let minFont = 999;
      for (const n of stage.querySelectorAll('*')) {
        if (!n.textContent.trim() || n.children.length || n.closest('.sr')) continue;
        if (n.closest('.page[data-on="0"]')) continue;
        const f = parseFloat(getComputedStyle(n).fontSize);
        minFont = Math.min(minFont, f);
        if (f < FONT_FLOOR) out.push(`TINY ${f}px "${n.textContent.trim().slice(0, 14)}"`);
      }
      // 4 · 轨道 / 填充 / 缺口对比度
      const tracks = [];
      stage.querySelectorAll('.bar,.band').forEach(n =>
        tracks.push(['track-vs-bg', parse(getComputedStyle(n).backgroundColor), bgOf(n.parentElement)]));
      stage.querySelectorAll('.bar>i,.band .used').forEach(n => {
        const host = n.closest('.bar,.band');
        const track = parse(getComputedStyle(host).backgroundColor);
        const fill = parse(getComputedStyle(n).backgroundColor);
        const lvl = (n.closest('[data-level]') || { dataset: {} }).dataset.level || 'ok';
        tracks.push([`fill-vs-track/${lvl}`, fill, track]);
        const notch = parse(getComputedStyle(n).boxShadow.match(/rgba?\([^)]+\)/)?.[0] || '');
        if (notch.length) { tracks.push([`notch-vs-fill/${lvl}`, notch, fill]); tracks.push([`notch-vs-track/${lvl}`, notch, track]); }
      });
      stage.querySelectorAll('.band .caret').forEach(n => {
        const track = parse(getComputedStyle(n.closest('.band')).backgroundColor);
        tracks.push(['caret-vs-track', parse(getComputedStyle(n).backgroundColor), track]);
      });
      const seen = new Set(); const trackReport = [];
      for (const [name, fg, bg] of tracks) {
        if (!fg.length) continue;
        const rr = ratio(over(fg, bg), bg);
        const key = name + '|' + over(fg, bg).map(Math.round).join(',');
        if (!seen.has(key)) { seen.add(key); trackReport.push([name, +rr.toFixed(2)]); }
        if (name.startsWith('fill-vs-track')) continue;   // 边界由缺口承担，语义色不动
        if (rr < 3) out.push(`TRACK<3:1 ${name} ${rr.toFixed(2)}:1`);
      }
      // 4b · R5-05 · 间距栅格：扫描全部计算出的 gap / padding / margin
      const offScale = [];
      for (const n of stage.querySelectorAll('*')) {
        if (n.closest('.sr')) continue;
        const cs = getComputedStyle(n);
        for (const prop of ['rowGap','columnGap','paddingTop','paddingRight','paddingBottom',
                            'paddingLeft','marginTop','marginRight','marginBottom','marginLeft']) {
          const raw = cs[prop];
          if (!raw || !raw.endsWith('px')) continue;
          const val = Math.round(parseFloat(raw) * 100) / 100;
          if (val < 0) continue;
          if (!SCALE_IN.includes(val))
            offScale.push(`${val}px ${prop} on .${(typeof n.className === 'string' ? n.className : n.tagName).split(' ')[0]}`);
        }
      }

      // 4c · R5-01 · 非当前页里不得有任何可聚焦元素（inert 的实测口径）
      let focusableHidden = 0;
      for (const pg of stage.querySelectorAll('.page')) {
        if (pg === live) continue;
        focusableHidden += pg.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')
          .length && !pg.inert ? pg.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])').length : 0;
      }

      // 4d · E 页每条新闻的相对时间必须真的渲染且有宽度。
      //      这条是补的：时间原本被来源的省略号整个吃掉，而没有任何断言看着它。
      let newsNoTime = 0;
      if (live && live.dataset.p === 'e') {
        for (const it of live.querySelectorAll('.e-item')) {
          const tEl = it.querySelector('.e-time');
          if (!tEl || !tEl.textContent.trim() || tEl.getBoundingClientRect().width < 1) newsNoTime++;
        }
      }

      // 4e · REVISION 7：B 页三条填充必须是三家各自的身份色，而且互不相同。
      //      这是内容级断言：填充是对的颜色，不只是「有个填充」。
      //      身份色是分类色，不计入 accent —— accent 扫的是 #f4f4f6，三者都不是。
      let fillWrong = '';
      if (live && live.dataset.p === 'b') {
        const seen2 = [];
        for (const u of live.querySelectorAll('.band .used')) {
          const c = getComputedStyle(u).backgroundColor;
          if (c === 'rgb(244, 244, 246)') fillWrong = '填充用了 accent 白';
          seen2.push(c);
        }
        if (seen2.length === 3 && new Set(seen2).size !== 3)
          fillWrong = `三条填充不是三个颜色: ${seen2.join(' / ')}`;
      }

      // 4f · D 页在 ok / edge 下必须真的画出格子。原来 edge 落进了空态分支，
      //      七态里 D 只有四种渲染，而所有结构性断言照样全绿——空态不溢出。
      let heatCells = -1;
      if (live && live.dataset.p === 'd') heatCells = live.querySelectorAll('.cell[data-date]').length;

      // 5 · accent：按计算颜色全量扫描，只数当前可见页
      const ACCENT = 'rgb(244, 244, 246)';
      const accentEls = [];
      for (const n of stage.querySelectorAll('*')) {
        if (n.closest('.sr') || n.hasAttribute('data-not-accent')) continue;
        if (n.closest('svg[aria-hidden="true"]')) continue;
        if (n.closest('.page') && n.closest('.page') !== live) continue;   // 非当前页不计
        const b = n.getBoundingClientRect();
        if (b.width < 0.5 || b.height < 0.5) continue;
        const cs = getComputedStyle(n);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
        if (cs.backgroundColor === ACCENT || cs.stroke === ACCENT)
          accentEls.push(typeof n.className === 'string' && n.className ? n.className : n.tagName);
      }
      return {
        problems: out, accentEls, accent: accentEls.length, minFont, newsNoTime, fillWrong, heatCells,
        offScale: [...new Set(offScale)], focusableHidden,
        headings: stage.querySelectorAll('h1,h2,h3,[role=heading]').length,
        statusEls: stage.querySelectorAll('[role="status"]').length,
        clocks: [...stage.querySelectorAll('[data-clock]')].filter(n => n.getBoundingClientRect().height > 0 && n.textContent.trim()).length,
        dots: [...document.querySelectorAll('#dots button')].map(n => n.dataset.on).join(''),
        trackReport,
      };
    }, { FONT_FLOOR, SCALE_IN: SCALE });

    if (r.accent > 2) r.problems.push(`ACCENT ${r.accent} > 2 [${r.accentEls.join(', ')}]`);
    if (r.headings < 5) r.problems.push(`HEADINGS ${r.headings} < 5`);
    if (s === 'loading' && r.statusEls < 1) r.problems.push('LOADING no role=status');
    if (r.clocks < 1) r.problems.push('CLOCK missing');
    if (r.newsNoTime > 0) r.problems.push(`E 页有 ${r.newsNoTime} 条新闻没渲染出时间`);
    if (r.fillWrong) r.problems.push(`B 页填充色: ${r.fillWrong}`);
    if (p === 'd' && ['populated','edge','attention','running'].includes(s) && r.heatCells === 0)
      r.problems.push('D 页该出图的状态下一个格子都没有');
    // R5-01 · inert 断言
    if (r.focusableHidden > 0) r.problems.push(`INERT 非当前页仍有 ${r.focusableHidden} 个可聚焦元素`);
    // R5-05 · 例外清单断言：实测的 off-scale 集合必须等于声明的例外集合
    const unexpected = r.offScale.filter(x => !SPACING_EXCEPTIONS.includes(x));
    if (unexpected.length) r.problems.push(`OFF-SCALE 未登记: ${unexpected.join(' | ')}`);
    if (r.problems.length) problems.push({ cv: cv.label, p, s, list: r.problems });
    if (!trackReportOnce && r.trackReport.length) trackReportOnce = r.trackReport;
    if (r.problems.length)
      console.log(`${cv.label} ${p.padEnd(4)}/${s.padEnd(9)} FAIL ${r.problems.slice(0, 2).join(' | ')}`);
    else okCount++;
  }
 }
}
console.log(`\n格子检查：${okCount} / ${CANVASES.length * PAGES.length * STATES.length} 通过` +
            `（${CANVASES.length} 画布 × ${PAGES.length} 页 × ${STATES.length} 态）`);

console.log('\n轨道 / 填充 / 缺口对比度:');
for (const [n, v] of trackReportOnce || []) console.log(`  ${n.padEnd(22)} ${v}:1 ${v >= 3 ? 'PASS' : (n.startsWith('fill-vs-track') ? '(参考，边界由缺口承担)' : 'FAIL')}`);

// ---------------- 截图：panelX 1.0 作对照 + 1.19 实机系数（-x119） ----------------
// m3-executor 发现交付截图里混进过自检注入的合成事件行。我这边靠「截图在所有
// 模拟操作之前」侥幸是干净的，但没有任何东西在守着这个顺序——一旦有人把截图段
// 挪到节奏断言后面，交付图里就会混进「模拟新事件」的行，而且看起来完全正常。
// 顺序不是保证，断言才是：每张图拍之前验一遍画布里没有合成 id。
const shotPurity = [];
async function assertClean(label) {
  const dirty = await page.evaluate(() => {
    const bad = [];
    for (const r of document.querySelectorAll('#stage .row')) {
      const id = r.dataset.id || '';
      if (id.startsWith('new') || id.startsWith('attn-')) bad.push(id);
    }
    return bad;
  });
  if (dirty.length) shotPurity.push(`${label}: ${dirty.join(', ')}`);
}

const SHOT_PAGES = [['a','page-a'],['b','page-b'],['c1','page-c'],['c2','page-c2'],['d','page-d'],['e','page-e']];
for (const px of [1.00, 1.19]) {
  const sfx = px === 1.19 ? '-x119' : '';
  await page.evaluate(v => { const r = document.getElementById('rngPanel');
    r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#segH button[data-h="270"]').click(); }, px);
  await page.click('#segState button[data-s="populated"]');
  await page.waitForTimeout(320);
  for (const [p, name] of SHOT_PAGES) {
    await page.click(`#segPage button[data-p="${p}"]`); await page.waitForTimeout(380);
    await assertClean(`${name}${sfx}`);
    await page.locator('#stage').screenshot({ path: `${SHOTS}/${name}${sfx}.png` });
  }
  await page.click('#segState button[data-s="attention"]');
  await page.click('#segPage button[data-p="attn"]'); await page.waitForTimeout(380);
  await assertClean(`page-attention${sfx}`);
  await page.locator('#stage').screenshot({ path: `${SHOTS}/page-attention${sfx}.png` });
}
await page.evaluate(() => { const r = document.getElementById('rngPanel');
  r.value = '1.19'; r.dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('#segState button[data-s="populated"]');

// ---------------- 节奏断言 ----------------
console.log('\n节奏:');
const rhythm = [];
const dwell = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const ms = n => { const v = cs.getPropertyValue(n).trim(); return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000; };
  return { a: ms('--dwell-a'), b: ms('--dwell-b'), c: ms('--dwell-c'), event: ms('--dwell-event') };
});
console.log('  tokens:', JSON.stringify(dwell));
// 实机反馈 1：三页一律 60s，默认值必须是 60（下面的页序测试会临时压短，但那只是为了
// 在几秒内观察机制，token 的默认值不能跟着改）
if (!(dwell.a === 60000 && dwell.b === 60000 && dwell.c === 60000))
  rhythm.push(`三页 dwell 默认值不是 60s（实测 ${dwell.a / 1000}/${dwell.b / 1000}/${dwell.c / 1000}）`);
if (dwell.event !== dwell.c) rhythm.push('新事件钉住时长不等于一个 dwell');
const hasIdle = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--dwell-idle').trim());
if (hasIdle) rhythm.push('--dwell-idle 仍然存在（空闲加速已作废）');

// 顺序 a→b→c→a（临时把停留压短，验证的是机制不是秒数）
await page.click('#segState button[data-s="populated"]');
await page.click('#segPage button[data-p="a"]');
await page.addStyleTag({ content: ':root{--dwell-a:.4s;--dwell-b:.3s;--dwell-c:.3s;--dwell-event:.6s}' });
await page.check('#chkRotate');
const seqSeen = [];
for (let i = 0; i < 24; i++) {
  const cur = await page.evaluate(() => document.documentElement.dataset.page);
  if (seqSeen[seqSeen.length - 1] !== cur) seqSeen.push(cur);
  await page.waitForTimeout(120);
}
console.log('  观察到的页序:', seqSeen.join(' → '));
if (!/a.*b.*c/.test(seqSeen.join(''))) rhythm.push(`页序不是 A→B→C（实测 ${seqSeen.join('→')}）`);

// 新事件 → 200ms 内 C 页可见
await page.click('#segPage button[data-p="a"]');
await page.waitForTimeout(100);
await page.click('#btnPush');
await page.waitForTimeout(180);
const onC = await page.evaluate(() => !!document.querySelector('.page[data-p="c1"][data-on="1"]'));
console.log('  新事件后 180ms 在 C 页:', onC);
if (!onC) rhythm.push('新事件后 200ms 内没有切到 C 页');

// attention → 轮播停住
await page.click('#btnAttn');
await page.waitForTimeout(1500);                       // ≫ 被压短后的任何一页停留
const stuck = await page.evaluate(() => ({ page: document.documentElement.dataset.page, meter: document.getElementById('meter').textContent }));
console.log('  attention 接管 1.5s 后:', JSON.stringify(stuck));
if (stuck.page !== 'attn') rhythm.push('attention 下轮播没有停止');

// 解除后回到 A
await page.click('#btnAttn');
await page.waitForTimeout(200);
const back = await page.evaluate(() => document.documentElement.dataset.page);
console.log('  解除 attention 后:', back);
if (back !== 'a') rhythm.push('解除 attention 后没有回到 A 页');

// reduced-motion 下切页无动画
await page.check('#chkRm'); await page.waitForTimeout(150);
const rmOk = await page.evaluate(() => {
  const pg = document.querySelector('.page[data-on="1"]');
  return { rm: document.documentElement.dataset.rm, transition: getComputedStyle(pg).transitionDuration, transform: getComputedStyle(pg).transform };
});
console.log('  reduced-motion:', JSON.stringify(rmOk));
if (parseFloat(rmOk.transition) !== 0) rhythm.push('reduced-motion 下切页仍有 transition');
await page.uncheck('#chkRm');

// ---------------- 手动切换 ----------------
console.log('\n手动切换:');
const manual = [];
await page.goto(FILE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
await page.waitForTimeout(700);
const holdMs = await page.evaluate(() => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--manual-hold').trim();
  return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000; });
console.log('  --manual-hold:', holdMs);
if (holdMs !== 120000) manual.push(`--manual-hold 不是 120s（实测 ${holdMs / 1000}s）`);

await page.click('#segState button[data-s="populated"]');
await page.click('#segPage button[data-p="a"]');
await page.waitForTimeout(150);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
let m = await page.evaluate(() => ({ page: document.documentElement.dataset.page,
  hold: !document.getElementById('holdmark').hidden }));
console.log('  → 之后:', JSON.stringify(m));
if (m.page !== 'b') manual.push('→ 没有切到下一页');
if (!m.hold) manual.push('手动切页后没有显示「‖」暂停标记');
await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150);
if (await page.evaluate(() => document.documentElement.dataset.page) !== 'a') manual.push('← 没有切回上一页');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150);
await page.keyboard.press('Home'); await page.waitForTimeout(150);
if (await page.evaluate(() => document.documentElement.dataset.page) !== 'a') manual.push('Home 没有回 A 页');

// 指示点：热区 24×24，视觉仍 4px
const dot = await page.evaluate(() => {
  const b = document.querySelector('#dots button[data-p="d"]');
  // stage 现在用 transform: scale(2*panelX, 2)，横纵倍率不同，换算要分开算
  const cs = getComputedStyle(document.documentElement);
  const px = Number(cs.getPropertyValue('--panel-x')) || 1;
  const r = b.getBoundingClientRect(), zx = 2 * px, zy = 2;
  return { w: Math.round(r.width / zx), h: Math.round(r.height / zy),
           visual: getComputedStyle(b, '::after').width };
});
console.log('  指示点:', JSON.stringify(dot));
if (dot.w < 24 || dot.h < 24) manual.push(`指示点热区不足 24×24（实测 ${dot.w}×${dot.h}）`);
if (dot.visual !== '4px') manual.push(`指示点视觉不是 4px（实测 ${dot.visual}）`);
await page.click('#dots button[data-p="d"]'); await page.waitForTimeout(150);
if (await page.evaluate(() => document.documentElement.dataset.page) !== 'd') manual.push('点击指示点没有跳页');

// 边缘热区 15% + hover chevron
const edge = await page.evaluate(() => {
  const e = document.querySelector('.edge[data-side="next"]');
  const pgs = document.getElementById('pages').getBoundingClientRect();
  return { pct: Math.round(e.getBoundingClientRect().width / pgs.width * 100),
           svg: getComputedStyle(e.querySelector('svg')).width,
           opacity: getComputedStyle(e.querySelector('svg')).opacity };
});
console.log('  边缘热区:', JSON.stringify(edge));
if (edge.pct !== 15) manual.push(`边缘热区不是 15%（实测 ${edge.pct}%）`);
if (edge.svg !== '24px') manual.push(`chevron 不是 24px（实测 ${edge.svg}）`);
if (edge.opacity !== '0') manual.push('chevron 默认就可见（应当 hover 才浮出）');
await page.hover('.edge[data-side="next"]'); await page.waitForTimeout(250);
const shown = await page.evaluate(() => getComputedStyle(document.querySelector('.edge[data-side="next"] svg')).opacity);
console.log('  hover 后 chevron opacity:', shown);
if (shown === '0') manual.push('hover 后 chevron 没有浮出');
await page.waitForTimeout(2300);
const faded = await page.evaluate(() => document.querySelector('.edge[data-side="next"]').dataset.hint);
console.log('  2s 无移动后:', faded);
if (faded === '1') manual.push('2s 无移动后 chevron 没有隐藏');

// 手动之后：压短 dwell，确认 hold 期间不自动翻页
await page.addStyleTag({ content: ':root{--dwell-a:.3s;--dwell-b:.3s;--dwell-c:.3s}' });
await page.click('#dots button[data-p="b"]'); await page.waitForTimeout(1500);
const stayed = await page.evaluate(() => document.documentElement.dataset.page);
console.log('  手动切页后 1.5s（dwell 已压到 0.3s）:', stayed);
if (stayed !== 'b') manual.push(`手动暂停期间仍自动翻页（跑到了 ${stayed}）`);
// 但新事件仍然打断
await page.click('#btnPush'); await page.waitForTimeout(200);
const toC = await page.evaluate(() => document.documentElement.dataset.page);
console.log('  手动暂停期间来新事件:', toC);
if (toC !== 'c1') manual.push('手动暂停期间新事件没有跳 C1');
// attention 下 ←/→ 无效
await page.click('#btnAttn'); await page.waitForTimeout(250);
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(200);
const attnPage = await page.evaluate(() => document.documentElement.dataset.page);
console.log('  attention 下按 ←/→:', attnPage);
if (attnPage !== 'attn') manual.push('attention 页被 ←/→ 切走了');
// 但 Enter 仍可 ack
await page.click('#segPage button[data-p="c1"]'); await page.waitForTimeout(250);
// 调试视图里控制栏还在，单按一次 Tab 只会落到隔壁的控制栏按钮上（上一版就是这么
// 误报的）。一路 Tab 到焦点真的进了画布再按 Enter。
for (let i = 0; i < 30 && !await page.evaluate(() => !!document.activeElement.closest('#stage')); i++)
  await page.keyboard.press('Tab');
await page.keyboard.press('Enter'); await page.waitForTimeout(250);
// 判据是 attention 真的被解除（回到 A 且 attention 行消失），不是 live 文本里有「批准」两个字
const afterAck = await page.evaluate(() => ({
  page: document.documentElement.dataset.page,
  // ack 之后那一行仍在事件流里（它是一条已处理的事件），判据是它不再 unread
  stillAttn: !!document.querySelector('.row[data-kind="attention"][data-unread="1"]'),
  live: document.getElementById('live').textContent }));
console.log('  attention 行 Enter ack:', JSON.stringify(afterAck));
if (afterAck.stillAttn || afterAck.page !== 'a') manual.push('attention 行不能用 Enter ack 解除');
console.log('\n手动切换问题:', manual.length ? manual : 'none');

// ---------------- 纯净模式 ----------------
console.log('\n纯净模式:');
const pure = [];
await page.evaluate(() => document.exitFullscreen && document.fullscreenElement && document.exitFullscreen());
await page.keyboard.press('p');
await page.waitForTimeout(400);
let st = await page.evaluate(() => ({
  pure: document.documentElement.dataset.pure,
  harness: getComputedStyle(document.querySelector('.harness')).display,
  legend: getComputedStyle(document.querySelector('.legend')).display,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
  rotate: document.documentElement.dataset.rotate,
  dots: !!document.querySelector('#dots button[data-on="1"]'),
  page: document.documentElement.dataset.page,
}));
console.log('  按 P 之后:', JSON.stringify(st));
if (st.pure !== '1') pure.push('按 P 没有进入纯净模式');
if (st.harness !== 'none' || st.legend !== 'none') pure.push('控制栏 / 说明没有隐藏');
if (st.rotate !== '1') pure.push('纯净模式下轮播没有强制开启');
if (!st.dots) pure.push('页面指示点丢失');

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
st = await page.evaluate(() => ({ pure: document.documentElement.dataset.pure,
  harness: getComputedStyle(document.querySelector('.harness')).display }));
console.log('  按 Esc 之后:', JSON.stringify(st));
if (st.pure === '1' || st.harness === 'none') pure.push('Esc 没有退回调试视图');

// ?pure=1 打开：先挂提示，按键后提示消失
await page.goto(FILE + '?pure=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
st = await page.evaluate(() => ({ pure: document.documentElement.dataset.pure,
  hint: !document.getElementById('pureHint').hidden,
  hintText: document.getElementById('pureHint').textContent,
  hintSize: getComputedStyle(document.getElementById('pureHint')).fontSize,
  harness: getComputedStyle(document.querySelector('.harness')).display }));
console.log('  ?pure=1 打开:', JSON.stringify(st));
if (st.pure !== '1' || st.harness !== 'none') pure.push('?pure=1 没有直接进入纯净模式');
if (!st.hint) pure.push('?pure=1 没有显示「按任意键进入全屏」提示');
if (st.hintSize !== '14px') pure.push(`提示不是 14px（实测 ${st.hintSize}）`);
await page.keyboard.press('Space');
await page.waitForTimeout(300);
st = await page.evaluate(() => ({ hint: !document.getElementById('pureHint').hidden }));
console.log('  按键之后提示:', JSON.stringify(st));
if (st.hint) pure.push('按键后提示没有消失');
// 纯净模式下键盘 ack 仍可用 —— 事件行只在 C 页，所以先把 dwell 压短等轮到 C
// dwellUntil 是进入页面时按 60s 算好的，改 CSS 变量不会回溯它 ——
// 按 P 出入一次纯净模式会触发 showPage 重新计时，新的短 dwell 才生效
await page.addStyleTag({ content: ':root{--dwell-a:.3s;--dwell-b:.3s;--dwell-c:8s}' });
await page.keyboard.press('p'); await page.waitForTimeout(120);
await page.keyboard.press('p'); await page.waitForTimeout(120);
for (let i = 0; i < 60 && await page.evaluate(() => document.documentElement.dataset.page) !== 'c'; i++)
  await page.waitForTimeout(100);
await page.keyboard.press('Tab');
const acked = await page.evaluate(() => {
  const a = document.activeElement;
  return { page: document.documentElement.dataset.page, inStage: !!a.closest('#stage'),
           cls: typeof a.className === 'string' ? a.className : a.tagName,
           ring: getComputedStyle(a).boxShadow };
});
console.log('  纯净模式下 Tab 落点:', JSON.stringify(acked));
if (!acked.inStage) pure.push('纯净模式下 Tab 进不到事件行');
else {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const live = await page.textContent('#live');
  console.log('  纯净模式下 Enter ack:', JSON.stringify(live));
  if (!/已读|读完/.test(live || '')) pure.push('纯净模式下 Enter 不能 ack');
}

// 纯净模式下手动切换仍可用
await page.keyboard.press('ArrowRight'); await page.waitForTimeout(200);
const pureManual = await page.evaluate(() => ({ pure: document.documentElement.dataset.pure,
  page: document.documentElement.dataset.page, hold: !document.getElementById('holdmark').hidden }));
console.log('  纯净模式下按 →:', JSON.stringify(pureManual));
if (pureManual.pure !== '1') pure.push('纯净模式被 → 退出了');

console.log('\n纯净模式问题:', pure.length ? pure : 'none');
console.log('\n截图纯净度:', shotPurity.length ? shotPurity : 'none（14 张图里没有合成事件行）');
console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');
console.log('节奏问题:', rhythm.length ? rhythm : 'none');
console.log('布局问题:', problems.length ? JSON.stringify(problems, null, 1) : 'none');
console.log('shots:', fs.readdirSync(SHOTS).filter(f => f.endsWith('.png')).join(' '));
await browser.close();
