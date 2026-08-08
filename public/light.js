// ============================================================
//  THE WATCH · light.js · v1.0 · 2026-08-02
//  作者：Yihang Zhang
//
//  这个文件干什么：让服务器直接控制揭示光的智能灯泡。
//
//  为什么单独一个文件：
//    灯泡是最不可靠的一环（Wi-Fi、固件、断电）。
//    把它隔离出来，灯泡出任何问题都不会连累服务器。
//    所有网络请求都带 .catch()，失败只打印一行，绝不抛异常。
//
//  用法（server.js 里加两处，共 3 行）：
//    1. 文件顶部：      const Light = require('./light');
//    2. goOffline 里的 REVEAL_UP setTimeout 内： Light.cue('REVEAL_UP');
//    3. goOffline 里的 REVEAL_DOWN setTimeout 内： Light.cue('REVEAL_DOWN');
//       （TRACKING_OFF / TRACKING_ON 不用管，追踪光是常亮的，
//         变暗由摄像头曝光在软件里完成 —— 见 v2.1 §1.1 解法 A）
// ============================================================


// ════════════════════════════════════════════════════════════
//  ★★★ 只需要改下面这一块 ★★★
// ════════════════════════════════════════════════════════════

const CONFIG = {
  // 开关。灯泡没到货、或者当天不想用自动光，改成 false 就行。
  // 改成 false 之后服务器完全不会碰网络，帮手用旋钮手动推。
  enabled : true,

  // 灯泡的局域网 IP。
  // ★ 怎么找：笔记本开热点 → 灯泡配网 → Windows 命令行敲 arp -a
  //   或者去路由器/热点的已连接设备列表里看
  ip      : '192.168.137.50',

  // 亮度曲线
  upMs    : 4000,   // 推起时长（毫秒）
  downMs  : 2000,   // 落下时长
  maxLevel: 100,    // 揭示光最亮到多少（0-100）。现场对着脸调，不要在这里猜
  minLevel: 0,

  // 分步淡入的步数。
  // 灯泡固件自带 transition 的话可以设成 1（一条请求搞定，最平滑）
  // 不带的话用 12–20 步软件模拟
  steps   : 16,
};


// ── 把"亮度 0-100"翻译成一条 URL ──────────────────────────────
// ★★★ 这个函数几乎肯定要改，因为每家固件的地址不一样 ★★★
//
// 怎么找你自己灯泡的正确地址（5 分钟）：
//   1. 浏览器打开  http://灯泡IP/   —— 大部分本地控制的灯泡有网页界面
//   2. 在那个界面上拖亮度滑块，同时按 F12 → Network 标签
//   3. 看它发出的请求长什么样，照抄到下面
//
// 常见的两种（Shelly 系列）：
//   Gen1: http://IP/light/0?turn=on&brightness=50
//   Gen2: http://IP/rpc/Light.Set?id=0&on=true&brightness=50
//
function urlFor(level) {
  const b = Math.max(0, Math.min(100, Math.round(level)));
  if (b <= 0) {
    return `http://${CONFIG.ip}/light/0?turn=off`;
  }
  return `http://${CONFIG.ip}/light/0?turn=on&brightness=${b}`;
}

// ════════════════════════════════════════════════════════════
//  ★★★ 下面的不用改 ★★★
// ════════════════════════════════════════════════════════════


let currentLevel = 0;
let fadeTimers   = [];   // 正在进行的淡变，切换时要全部清掉


// ── 发一条请求，失败只打印，绝不抛异常 ────────────────────────
function send(level) {
  if (!CONFIG.enabled) return;
  const url = urlFor(level);

  // AbortController 保证一条卡住的请求不会堆积
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 1500);

  fetch(url, { signal: ctrl.signal })
    .then(() => { currentLevel = level; })
    .catch(() => { /* 灯泡不在线，静默失败，帮手用旋钮兜底 */ })
    .finally(() => clearTimeout(kill));
}


// ── 清掉所有正在进行的淡变 ────────────────────────────────────
function clearFade() {
  fadeTimers.forEach(t => clearTimeout(t));
  fadeTimers = [];
}


// ── 分步淡变 ─────────────────────────────────────────────────
// 用 easeInOutSine，比线性更像人手推的，但没有人手的抖
function fade(from, to, durMs) {
  clearFade();
  const n = Math.max(1, CONFIG.steps);

  for (let i = 1; i <= n; i++) {
    const p = i / n;
    const e = 0.5 - 0.5 * Math.cos(Math.PI * p);      // easeInOutSine
    const level = from + (to - from) * e;
    const at    = durMs * p;
    fadeTimers.push(setTimeout(() => send(level), at));
  }
}


// ── 对外的唯一入口 ────────────────────────────────────────────
function cue(action) {
  if (!CONFIG.enabled) return;

  switch (action) {
    case 'REVEAL_UP':
      console.log('[灯] 揭示光推起 ' + CONFIG.upMs + 'ms');
      fade(CONFIG.minLevel, CONFIG.maxLevel, CONFIG.upMs);
      break;

    case 'REVEAL_DOWN':
      console.log('[灯] 揭示光落下 ' + CONFIG.downMs + 'ms');
      fade(currentLevel, CONFIG.minLevel, CONFIG.downMs);
      break;

    case 'BLACKOUT':          // 紧急全灭（cue.html 的急停可以调它）
      clearFade();
      send(0);
      break;

    default:
      break;
  }
}


// ── 开机自检：告诉你灯泡在不在线 ──────────────────────────────
// 这一条最有用。装机那天开服务器就能立刻知道灯泡通没通，
// 不用等到第一次崩溃才发现光不亮。
function selfTest() {
  if (!CONFIG.enabled) {
    console.log('[灯] 自动灯光已关闭（CONFIG.enabled = false）');
    return;
  }
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 2000);

  fetch(urlFor(0), { signal: ctrl.signal })
    .then(() => console.log('[灯] ✅ 灯泡在线 ' + CONFIG.ip))
    .catch(() => console.log('[灯] ❌ 灯泡不在线 ' + CONFIG.ip +
                             ' —— 今天用旋钮手动推'))
    .finally(() => clearTimeout(kill));
}


// ── 手动测试用（命令行敲 node light.js 就能试）────────────────
if (require.main === module) {
  console.log('[灯] 单独测试模式');
  selfTest();
  setTimeout(() => { console.log('推起…'); cue('REVEAL_UP');   }, 2500);
  setTimeout(() => { console.log('落下…'); cue('REVEAL_DOWN'); }, 12000);
  setTimeout(() => process.exit(0), 18000);
}


module.exports = { cue, selfTest, CONFIG };
