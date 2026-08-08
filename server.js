// ============================================================
//  THE WATCH · server.js · v3.2  (2026-08-04)
//  作者：Yihang Zhang
//
//  v3.2 改动（相对 v3.1）：
//
//  [1] 明确声明 onTouch() 无 energy 门控
//      ——energy 在任何值（0~100）时 triggerSugar / triggerKnife
//        均无条件下发，不存在能量高了就拦截事件的逻辑。
//      ——旧代码本来就没有，这里加注释 + 结构显式化，防止日后误加。
//
//  [2] 防抖改为「每 socket 独立」
//      旧版全局 _lastTouchMs：两台手机同时触摸时，
//      第二台的事件会被全局 30ms 门控误杀 50% 以上。
//      新版每个 socket 自己维护时间戳，互不干扰。
//
//  [3] 全局滑动窗口限速（新）
//      防止高频 Socket 冲击（所有手机合并）把大量事件
//      在同一 JS 微任务批次里推进前端，导致音频引擎排程
//      积压挂起。
//      参数：RATE_WINDOW_MS=1000ms，MAX_TOUCH_PER_SEC=20。
//      逻辑：超过上限的触摸完全丢弃（不计数、不广播）。
//      正常两台手机各 10 次/秒 = 合计 20 次/秒，恰好在上限内。
//
//  [4] 数据回填：baseThreshold 451（8/4 实测）
//  [5] 看门狗 offlineStartTime 修复（来自 v3.1）
// ============================================================

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.get('/health', (req, res) => res.send('ok'));


// ═══════════════════════════════════════════════
//  模式参数
// ═══════════════════════════════════════════════
const MODES = {
  installation: {                 // 我不在场，观众自己玩
    minCycleSec       : 200,
    maxCycleSec       : 480,
    baseThreshold     : 190,
    ratchet           : 1.00,
    ratchetCap        : 0,
    residuePerCycle   : 0.05,
    residuePerTouch   : 0.00012,
    energyDecayPerSec : 8,
    energyPerTouch    : 8,
  },
  performance: {                  // 我在场表演
    minCycleSec       : 45,       // 只防刷屏下限，不是叙事门控
    maxCycleSec       : 300,      // 无人时的兜底上限
    baseThreshold     : 451,      // ★ 8/4 实测：246次÷180秒×330秒≈451
    ratchet           : 1.22,     // 451→550→671→818（ratchetCap=3，最多递增3次）
    ratchetCap        : 3,
    residuePerCycle   : 0.10,
    residuePerTouch   : 0.00015,
    energyDecayPerSec : 12,       // energy 只驱动画面消退，可以掉得快
    energyPerTouch    : 10,       // 停手约 4 秒画面明显垮，摸一下立刻回来
  },
};

let mode = 'installation';
let P    = MODES[mode];


// ═══════════════════════════════════════════════
//  ★ TODO（第四批 · 8月5日/6日）：phone.html 临床感样式优化 ★
//  本批（第三批）专注于后端状态机绝对稳态，不触碰 phone.html。
//  下一批交付目标：phone.html 触摸界面的展览级样式完善（amber 余烬效果、
//  全屏触摸区、安卓适配）
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
//  单人展场自动化排程（Task 2 · 08-04）
//  enabled 默认 false，展览前把 enabled 改为 true 即可。
//  无需改代码逻辑，只需改这里的参数。
// ═══════════════════════════════════════════════
const AUTO_SCHEDULE = {
  enabled          : false,   // ★ 展览前设为 true
  performanceStart : 11,      // 每天几点自动切 performance（24h制）
  performanceEnd   : 18,      // 每天几点自动切 installation
  // 提示：performanceStart 到 performanceEnd 是展览时段，
  // 其余时间自动回 installation（允许观众无监控自由体验）
};

// 自动排程检查（每分钟一次，不到 1ms CPU 占用）
setInterval(() => {
  if (!AUTO_SCHEDULE.enabled) return;
  const h = new Date().getHours();
  const inExhibition = h >= AUTO_SCHEDULE.performanceStart
                    && h <  AUTO_SCHEDULE.performanceEnd;
  const targetMode = inExhibition ? 'performance' : 'installation';
  if (targetMode !== mode) {
    console.log(`[AUTO] 时间触发模式切换: ${mode} → ${targetMode} (${h}:xx)`);
    mode = targetMode;
    P    = MODES[mode];
    broadcastState();
  }
}, 60 * 1000);
const SESSION = { cycle: 0, residue: 0 };
const BOOT_TIME = Date.now();

let energy         = 100;
let cycleTouches   = 0;
let totalTouches   = 0;
let contribution   = 4471902;
let isOnline       = true;
let cycleStartTime = Date.now();
let knifeLog       = [];
let offlineStartTime = 0;


function currentThreshold() {
  const c = Math.min(SESSION.cycle, P.ratchetCap);
  return Math.round(P.baseThreshold * Math.pow(P.ratchet, c));
}


function residueEffects(r) {
  const L = (a, b) => a + (b - a) * r;
  return {
    videoAlphaCeiling : Math.max(26,   L(80,   26)),
    confidenceFloor   : Math.min(0.58, L(0,    0.58)),
    driftBaseline     : Math.min(7.0,  L(0,    7.0)),
    meshInstability   : Math.min(0.72, L(0,    0.72)),
    flashCeiling      : Math.max(0.62, L(1.00, 0.62)),
    lightboxSpeed     : Math.max(44,   L(85,   44)),
    lightboxGap       : Math.min(4300, L(2500, 4300)),
    feedbackDelay     : Math.min(145,  L(50,   145)),
    trackingLightLevel: Math.max(0.58, L(1.00, 0.58)),
  };
}


function rollTier() {
  const r = Math.random();
  if (r < 0.05) return 'big';       //  5%
  if (r < 0.30) return 'medium';    // 25%
  return 'small';                   // 70%
}


function broadcastState() {
  const threshold = currentThreshold();
  io.emit('state', {
    energy, cycleTouches, totalTouches, contribution, isOnline, mode,
    cycle         : SESSION.cycle,
    residue       : SESSION.residue,
    threshold,
    cycleProgress : Math.min(1, cycleTouches / threshold),
    elapsedSec    : (Date.now() - cycleStartTime) / 1000,
    fx            : residueEffects(SESSION.residue),
  });
}


// ═══════════════════════════════════════════════
//  ★★★ 触摸防护 —— 两层结构 ★★★
//
//  第一层：每 socket 独立防抖（TOUCH_DEBOUNCE_MS）
//    用途：过滤同一台手机在 30ms 内的重复事件（幽灵触摸）。
//    实现：Map<socketId, lastTouchMs>，每个 socket 独立计时。
//    ★ 不影响两台手机同时触摸——两个 socket 各自独立。
//
//  第二层：全局滑动窗口限速（MAX_TOUCH_PER_SEC）
//    用途：防止所有手机合并触摸率过高冲击前端音频引擎。
//    逻辑：过去 1000ms 内接受的触摸数 ≥ 上限时，丢弃此次触摸。
//    ★ 超速时完全丢弃（不计数、不广播），日志标记 [RATE]。
//
//  ★★★ energy 在任何值（0~100）时不影响以上两层逻辑。★★★
//  ★★★ triggerSugar / triggerKnife 没有 energy 门控。  ★★★
// ═══════════════════════════════════════════════

const TOUCH_DEBOUNCE_MS  = 30;   // 每 socket：两次触摸最小间隔（ms）
const RATE_WINDOW_MS     = 1000; // 全局限速窗口（ms）
const MAX_TOUCH_PER_SEC  = 20;   // 全局限速上限（次/窗口）

// 每 socket 的上次触摸时间戳
const _socketLastTouch = new Map();

// 滑动窗口：记录最近接受的触摸时间戳（只保留窗口内的）
let _touchWindow = [];


// ── 核心触摸处理 ────────────────────────────────────────────────────
// 调用时机：已通过两层防护，确认是合法触摸。
//
// ★ 关键设计声明（勿删）：
//   这里没有任何 energy 判断，也不应该有。
//   energy 只控制"画面消退快慢"（在 index.html 的 getStageParams 里处理）。
//   无论 energy=0 还是 energy=100，triggerSugar 和 triggerKnife 必须正常下发。
//   如果你看到"energy 高的时候没有声音"，根因在前端音频引擎（see sound.js），
//   不要在这里加 energy 门控来"修复"它——那只会把有声音变成永远没声音。
function onTouch() {
  if (!isOnline) return;

  cycleTouches++;
  totalTouches++;
  contribution++;
  energy = Math.min(100, energy + P.energyPerTouch);
  SESSION.residue = Math.min(1, SESSION.residue + P.residuePerTouch);

  // ★ 服务器掷一次骰子，同时发给 triggerSugar 和 triggerKnife
  // 铁律：tier 只在服务器掷一次，两个事件共享同一个 tier。
  // 任何窗口不许在客户端重掷。
  const tier = rollTier();

  // ★★★ 无 energy 门控：直接下发，不看 energy 值 ★★★
  io.emit('triggerSugar', { tier, residue: SESSION.residue });
  io.emit('triggerKnife', { tier, residue: SESSION.residue });

  knifeLog.push({ t: Date.now(), tier });
  if (knifeLog.length > 40) knifeLog.shift();

  const elapsed = ((Date.now() - BOOT_TIME) / 1000).toFixed(3);
  console.log(`[touch] ${cycleTouches}/${currentThreshold()} · tier=${tier} · energy=${energy.toFixed(1)} · residue=${SESSION.residue.toFixed(3)}`);
  console.log(`[LOG] ${elapsed} touch ${tier}`);

  broadcastState();
  checkOffline();
}


function checkOffline() {
  const elapsed = (Date.now() - cycleStartTime) / 1000;
  const reachedByTouch = (elapsed >= P.minCycleSec)
                      && (cycleTouches >= currentThreshold());
  const reachedByTime  = elapsed >= P.maxCycleSec;
  if (reachedByTouch || reachedByTime) goOffline();
}


// 能量自然衰减（每 500ms 一次）
setInterval(() => {
  if (!isOnline) return;

  // 无人守卫：本轮零触摸 → 不衰减、不推进计时、不检查崩溃
  // 防止空场时系统自己崩溃，违背"是观众造成了这一切"的核心机制
  if (cycleTouches === 0) {
    cycleStartTime = Date.now();
    broadcastState();
    return;
  }

  energy = Math.max(0, energy - P.energyDecayPerSec / 2);
  broadcastState();
  checkOffline();
}, 500);


// ═══════════════════════════════════════════════
//  崩溃倒带：把最后 N 次刀声压进固定 3.5 秒窗口播给观众
// ═══════════════════════════════════════════════
const DUMP_DELAY_MS  = 2500;   // 崩溃后沉默 2.5 秒再开始倒带
const DUMP_WINDOW_MS = 3500;   // 倒带总时长固定 3.5 秒（等比压缩）
const DUMP_COUNT     = 15;

function dumpKnifeBuffer() {
  const recent = knifeLog.slice(-DUMP_COUNT);
  knifeLog = [];
  if (recent.length < 2) return;

  const t0   = recent[0].t;
  const span = (recent[recent.length - 1].t - t0) || 1;

  setTimeout(() => {
    console.log(`[dump] 刀声倒带：${recent.length} 次，窗口 3.5 秒`);
    recent.forEach((k, i) => {
      const at = ((k.t - t0) / span) * DUMP_WINDOW_MS;
      // ★ 倒带音量分层：
      //   index=0  → -3dB：首发强冲击，在嘈杂展厅里强行打断认知
      //   index>0  → -10dB：后续记录清晰可数，比之前 -18dB 响 8dB
      const db = (i === 0) ? -3 : -10;
      setTimeout(() => {
        io.emit('knifeToSpeakers', { tier: k.tier, db, index: i });
      }, at);
    });
  }, DUMP_DELAY_MS);
}


// ═══════════════════════════════════════════════
//  崩溃 / 恢复
// ═══════════════════════════════════════════════
const OFFLINE_DURATION_MS = 25000;

function goOffline() {
  if (!isOnline) return;

  isOnline = false;
  offlineStartTime = Date.now();
  SESSION.cycle++;
  SESSION.residue = Math.min(1, SESSION.residue + P.residuePerCycle);
  contribution++;

  const elapsed = ((Date.now() - BOOT_TIME) / 1000).toFixed(3);
  console.log(`\n[OFFLINE] 第${SESSION.cycle}次 · residue=${SESSION.residue.toFixed(3)}\n`);
  console.log(`[LOG] ${elapsed} OFFLINE cycle=${SESSION.cycle} residue=${SESSION.residue.toFixed(3)}`);

  io.emit('systemOffline', {
    residue : SESSION.residue,
    cycle   : SESSION.cycle,
    fx      : residueEffects(SESSION.residue),
  });
  io.emit('lightCue', { action: 'TRACKING_OFF', at: Date.now() });

  dumpKnifeBuffer();

  setTimeout(() => io.emit('lightCue', { action: 'REVEAL_UP',   at: Date.now() }),  7000);
  setTimeout(() => io.emit('lightCue', { action: 'REVEAL_DOWN', at: Date.now() }), 22000);

  setTimeout(() => {
    isOnline       = true;
    cycleTouches   = 0;
    cycleStartTime = Date.now();

    // ★★★ Task 1 核心修复：阶段单向递进保证 ★★★
    //
    // 原问题：每次 OFFLINE 恢复后 energy 硬写为 50，正好在 Stage 1 边界（e≥50）。
    // 前端 getStageParams(50, 0) 返回 chaosFromNeglect=0，
    // 视觉上与"第一轮刚开始"无法区分 —— 观众看到"回到第一阶段"。
    //
    // 修复：恢复 energy 随周期递减。每完成一轮，起始 energy 低 8 点：
    //   cycle 1 → 42（刚过 Stage 2 临界）
    //   cycle 2 → 34（明显 Stage 2）
    //   cycle 3 → 26（深 Stage 2，随即向 Stage 2底部衰竭）
    //   floor 15 → 始终保留足够能量让观众"有东西可维持"
    //
    // 不变量：SESSION.cycle 和 SESSION.residue 严格单调递增，
    // 任何代码路径不得让它们减小（resetSession 除外 = 整场重来）。
    energy = Math.max(15, 50 - SESSION.cycle * 8);

    io.emit('lightCue',     { action: 'TRACKING_ON', at: Date.now() });
    io.emit('systemOnline', {
      residue : SESSION.residue,
      cycle   : SESSION.cycle,
      fx      : residueEffects(SESSION.residue),
      energy  : energy,   // ★ 新增：前端 setSystemOnline() 用这个值，不再硬写 100
    });
    console.log(`[ONLINE] 恢复 · cycle=${SESSION.cycle} · residue=${SESSION.residue.toFixed(3)} · energy=${energy.toFixed(0)}`);
    broadcastState();
  }, OFFLINE_DURATION_MS);
}


function resetSession(newMode) {
  if (newMode && MODES[newMode]) { mode = newMode; P = MODES[mode]; }
  SESSION.cycle   = 0;
  SESSION.residue = 0;
  cycleTouches    = 0;
  cycleStartTime  = Date.now();
  energy          = 100;
  isOnline        = true;
  knifeLog        = [];
  _touchWindow    = [];   // ★ 重置时同时清空限速窗口
  console.log(`\n[RESET] 模式=${mode} · residue=0\n`);
  io.emit('sessionReset', { mode });
  broadcastState();
}


// 看门狗：卡在 OFFLINE 超过 60 秒则强制恢复
// ★ 使用 offlineStartTime，不是 cycleStartTime，防止崩溃瞬间就误触发
setInterval(() => {
  if (!isOnline && (Date.now() - offlineStartTime) > 60000) {
    console.log('[看门狗] OFFLINE 超过 60 秒，强制恢复');
    isOnline       = true;
    cycleTouches   = 0;
    cycleStartTime = Date.now();
    energy         = 50;
    io.emit('systemOnline', {
      residue : SESSION.residue,
      cycle   : SESSION.cycle,
      fx      : residueEffects(SESSION.residue),
    });
    io.emit('lightCue', { action: 'TRACKING_ON', at: Date.now() });
  }
}, 5000);


// ═══════════════════════════════════════════════
//  Socket.IO 连接处理
//  ★ 两层防护在这里应用，onTouch() 本身只做业务逻辑
// ═══════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('[连接] ' + socket.id);
  _socketLastTouch.set(socket.id, 0);
  broadcastState();

  // ── Task 2：灯光控制器注册 ─────────────────────────────────────
  // light.html 打开后发送 join:lightController 加入 'lights' 房间。
  // goOffline() 的所有 lightCue 已经用 io.emit()（广播全体），
  // light.html 无论有没有 join 都能收到。join:lightController 的
  // 额外好处：可以在 light.html 初始化时同步当前灯态（light:init）。
  socket.on('join:lightController', () => {
    socket.join('lights');
    console.log('[灯控] 已注册: ' + socket.id);
    socket.emit('light:init', {
      isOnline,
      cycle   : SESSION.cycle,
      residue : SESSION.residue,
    });
  });

  socket.on('touch', () => {
    const now = Date.now();

    // ── 第一层：每 socket 独立防抖 ──────────────────────────
    const lastMs = _socketLastTouch.get(socket.id) || 0;
    if (now - lastMs < TOUCH_DEBOUNCE_MS) return;
    _socketLastTouch.set(socket.id, now);

    // ── 第二层：全局滑动窗口限速 ──────────────────────────
    _touchWindow = _touchWindow.filter(t => now - t < RATE_WINDOW_MS);
    if (_touchWindow.length >= MAX_TOUCH_PER_SEC) {
      console.log(`[RATE] 触摸超速丢弃（当前 ${_touchWindow.length + 1}/sec · energy=${energy.toFixed(0)}）`);
      return;
    }
    _touchWindow.push(now);

    onTouch();
  });

  socket.on('ctrl:reset',        ({ mode: m }) => resetSession(m));
  socket.on('ctrl:mode',         ({ mode: m }) => {
    if (MODES[m]) { mode = m; P = MODES[mode]; broadcastState(); }
  });
  socket.on('ctrl:forceOffline', () => goOffline());

  socket.on('disconnect', () => {
    _socketLastTouch.delete(socket.id);
    console.log('[断开] ' + socket.id);
  });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  THE WATCH · server v3.2 · port ' + PORT);
  console.log('  模式：' + mode);
  console.log('  防抖：' + TOUCH_DEBOUNCE_MS + 'ms/socket');
  console.log('  限速：' + MAX_TOUCH_PER_SEC + '次/秒（全局）');
  console.log('══════════════════════════════════════════════\n');
});

// Render.com 保活（本地运行时 RENDER_EXTERNAL_URL 不存在，自动跳过）
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }
}, 14 * 60 * 1000);
