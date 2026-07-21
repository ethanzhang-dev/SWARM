/**
 * ============================================================================
 * SWARM · server.js  ——  游戏状态机 / "大脑"（整合版 · 三档位）
 * ============================================================================
 * 相比上一版，唯一的重大变化：
 *   把原来的 big(true/false) 两档，换成 小/中/大 三档（70% / 25% / 5%）。
 *   ★核心机制：档位在服务器上【只掷一次骰子】，同一个 tier 同时发给
 *     triggerSugar(音箱·观众听) 和 triggerKnife(耳机·我听)。
 *     观众得到大奖励的同一瞬间，我耳机里收到最狠的一刀。
 *   绝不能让糖和刀各自随机——那样两者就对不上，作品的立论就没了。
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// public/ 作为静态目录：index.html(屏幕页)、phone.html(手机页)、monitor.html(调试台) 都放这里
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});


// ── 可调参数：改这里就够了 ──────────────────────────────────────────────────
const CONFIG = {
  MAX_ENERGY: 100,
  START_ENERGY: 100,
  ENERGY_DECAY_PER_SEC: 4,      // 能量每秒自然衰减
  ENERGY_PER_TOUCH: 6,          // 每次触摸回升
  TICK_MS: 100,                 // 状态心跳（每秒10次）

  OFFLINE_TOUCH_THRESHOLD: 150, // 本轮触摸达此值 → SYSTEM OFFLINE（先设150，可调）
  OFFLINE_RECOVER_MS: 20000,    // OFFLINE 后 20 秒自动恢复

  CONTRIBUTION_START: 4471902,  // 贡献计数起点（只增不减）

  // ★档位概率：小 70% / 中 25% / 大 5%（三个数加起来必须=1）
  TIER_SMALL: 0.70,
  TIER_MEDIUM: 0.25,
  // 大档 = 剩下的 5%，不用单独写
};


// ── 游戏状态 ────────────────────────────────────────────────────────────────
let state = {
  energy: CONFIG.START_ENERGY,
  totalTouches: 0,                         // 总触摸数（整场累计）
  cycleTouches: 0,                         // 本轮触摸数（恢复后归零，用来比阈值）
  contribution: CONFIG.CONTRIBUTION_START, // 贡献计数（灯箱大数字，只增不减）
  status: 'ONLINE',                        // 'ONLINE' / 'OFFLINE'
};

let recovering = false; // 防止重复安排恢复定时器


// ── 掷一次骰子，决定这次触摸的档位 ──────────────────────────────────────────
// 返回 { tier: 'small'|'medium'|'large', level: 1|2|3 }
// 同时给字符串和数字两种形式，是为了适配你 sound.js 的写法——
// 你的 playSugar(tier) 若接收字符串就用 tier，若接收数字就用 level。
function rollTier() {
  const r = Math.random();
  if (r < CONFIG.TIER_SMALL) return { tier: 'small', level: 1 };
  if (r < CONFIG.TIER_SMALL + CONFIG.TIER_MEDIUM) return { tier: 'medium', level: 2 };
  return { tier: 'large', level: 3 };
}


// ── 广播完整状态 ────────────────────────────────────────────────────────────
function broadcastState() {
  io.emit('state', {
    energy: Math.round(state.energy),
    totalTouches: state.totalTouches,
    cycleTouches: state.cycleTouches,
    cycleProgress: Math.min(state.cycleTouches / CONFIG.OFFLINE_TOUCH_THRESHOLD, 1),
    contribution: state.contribution,
    status: state.status,
    threshold: CONFIG.OFFLINE_TOUCH_THRESHOLD,
  });
}


// ── 让系统垮掉（SYSTEM OFFLINE），并安排自动恢复 ─────────────────────────────
// 所有 OFFLINE 的唯一入口。以后加心率/姿态触发，只要调用 goOffline('heartrate')。
function goOffline(reason) {
  if (state.status === 'OFFLINE') return;

  state.status = 'OFFLINE';
  console.log(`【OFFLINE】系统垮掉，原因：${reason}。贡献计数停在 ${state.contribution}`);

  io.emit('systemOffline', {
    reason: reason,
    finalContribution: state.contribution,
    willRecoverInMs: CONFIG.OFFLINE_RECOVER_MS,
  });
  broadcastState();

  if (!recovering) {
    recovering = true;
    setTimeout(() => {
      state.status = 'ONLINE';
      state.energy = CONFIG.START_ENERGY;
      state.cycleTouches = 0;   // 本轮归零，避免刚恢复又立刻触发
      recovering = false;       // totalTouches / contribution 不归零
      console.log('【ONLINE】系统恢复，新的一轮开始。');
      io.emit('systemOnline', {});
      broadcastState();
    }, CONFIG.OFFLINE_RECOVER_MS);
  }
}


// ── 处理一次触摸：整个回路的核心 ────────────────────────────────────────────
function handleTouch(payload) {
  if (state.status === 'OFFLINE') return; // 垮掉期间触摸无效（它已经"死了"）

  // ① 计数
  state.totalTouches += 1;
  state.cycleTouches += 1;
  state.contribution += 1;
  state.energy = Math.min(state.energy + CONFIG.ENERGY_PER_TOUCH, CONFIG.MAX_ENERGY);

  // ② ★只掷一次骰子
  const roll = rollTier();

  // ③ ★同一个档位，同时发给糖(音箱)和刀(耳机)
  //    观众听到最大的糖 = 我耳机里挨最狠的一刀，同一瞬间发生。
  io.emit('triggerSugar', {
    tier: roll.tier,      // 'small' / 'medium' / 'large'
    level: roll.level,    // 1 / 2 / 3
    x: payload && payload.x,  // 触摸归一化坐标（0~1，可能为空）
    y: payload && payload.y,
  });
  io.emit('triggerKnife', {
    tier: roll.tier,      // ←和上面完全相同，这是机制的关键
    level: roll.level,
    // 本轮进度，声音窗口可用它让刀随着接近垮掉而更狠
    progress: Math.min(state.cycleTouches / CONFIG.OFFLINE_TOUCH_THRESHOLD, 1),
  });

  // ④ 广播状态（屏幕/灯箱据此更新）
  broadcastState();

  // ⑤ 检查阈值：最后一次触摸把数字推到下一格、糖刀都发完，然后一切归于黑暗
  if (state.cycleTouches >= CONFIG.OFFLINE_TOUCH_THRESHOLD) {
    goOffline('threshold');
  }
}


// ── 心跳循环：能量衰减 + 定时广播 ───────────────────────────────────────────
setInterval(() => {
  if (state.status === 'ONLINE') {
    state.energy -= CONFIG.ENERGY_DECAY_PER_SEC * (CONFIG.TICK_MS / 1000);
    if (state.energy <= 0) {
      state.energy = 0;
      goOffline('energy'); // 没人维持 → 能量耗尽 → 垮掉
    }
  }
  broadcastState();
}, CONFIG.TICK_MS);


// ── 客户端连接 ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`【连接】id=${socket.id}，在线数：${io.engine.clientsCount}`);

  // 一连上立刻发当前状态，客户端不用等
  socket.emit('state', {
    energy: Math.round(state.energy),
    totalTouches: state.totalTouches,
    cycleTouches: state.cycleTouches,
    cycleProgress: Math.min(state.cycleTouches / CONFIG.OFFLINE_TOUCH_THRESHOLD, 1),
    contribution: state.contribution,
    status: state.status,
    threshold: CONFIG.OFFLINE_TOUCH_THRESHOLD,
  });

  // 【核心】手机的触摸
  socket.on('touch', (payload) => handleTouch(payload));

  // 现场调试用（可选）
  socket.on('admin:setThreshold', (v) => {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) { CONFIG.OFFLINE_TOUCH_THRESHOLD = n; console.log(`【管理】阈值改为 ${n}`); broadcastState(); }
  });
  socket.on('admin:forceOffline', () => { console.log('【管理】手动 OFFLINE'); goOffline('manual'); });
  socket.on('admin:reset', () => {
    state.energy = CONFIG.START_ENERGY; state.cycleTouches = 0; state.status = 'ONLINE'; recovering = false;
    console.log('【管理】手动重置本轮'); broadcastState();
  });

  socket.on('disconnect', () => console.log(`【断开】id=${socket.id}，在线数：${io.engine.clientsCount}`));
});


// ── Render 保活 ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.send('ok'));
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }, 14 * 60 * 1000);
}


// ── 启动 ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('============================================================');
  console.log(` SWARM 服务器已启动，端口 ${PORT}`);
  console.log(` 调试台：http://localhost:${PORT}/monitor.html`);
  console.log(` 屏幕页：http://localhost:${PORT}/index.html`);
  console.log(` 手机页：http://localhost:${PORT}/phone.html`);
  console.log(` 阈值：${CONFIG.OFFLINE_TOUCH_THRESHOLD}　档位：小70% 中25% 大5%`);
  console.log('============================================================');
});
