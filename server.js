/**
 * ============================================================================
 * SWARM · server.js  ——  游戏状态机 / "大脑"（Render 就绪版）
 * ============================================================================
 * 这一版基于你旧的 relay server 结构（express + public/ + Render 保活）改造：
 *   - 保留：express 提供 public/ 页面、process.env.PORT、CORS、/health 保活。
 *   - 换掉：旧的"分配角色 / 摇一摇转发"，装进新的"触摸游戏状态机"。
 *
 * 数据流：手机(触摸) ──▶ 服务器(算状态) ──▶ 广播给所有人(屏幕/声音/灯箱一起响应)
 * ============================================================================
 */

const express = require('express');            // 提供网页 + 静态文件
const http = require('http');                  // Node 自带，起服务器
const path = require('path');                  // Node 自带，拼路径
const { Server } = require('socket.io');       // 实时通信

const app = express();
const server = http.createServer(app);

// 把 public/ 文件夹作为静态目录：手机端页面、调试用 monitor.html 都放这里
// 例如 public/monitor.html → 浏览器访问 http://.../monitor.html
app.use(express.static(path.join(__dirname, 'public')));

// 允许任何来源的页面连进来（屏幕/手机/灯箱可能来自不同地址，务必开）
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});


// ── 所有可调参数都在这里，改这里就够了 ──────────────────────────────────────
const CONFIG = {
  MAX_ENERGY: 100,              // 能量上限
  START_ENERGY: 100,           // 每一轮开始时的能量（想更脆弱可改成 50）
  ENERGY_DECAY_PER_SEC: 4,     // 每秒自然衰减（没人摸就慢慢掉）
  ENERGY_PER_TOUCH: 6,         // 每次触摸回升的能量（想更难维持可改成 3）
  TICK_MS: 100,                // 状态心跳间隔（100ms = 每秒10次）
  OFFLINE_TOUCH_THRESHOLD: 150,// 本轮累积触摸数达到此值 → OFFLINE（可调）
  OFFLINE_RECOVER_MS: 20000,   // OFFLINE 后自动恢复的等待（20 秒）
  CONTRIBUTION_START: 4471902, // 贡献计数起始值（只增不减）
  BIG_REWARD_CHANCE: 0.12,     // 变率强化：每次触摸约 1/8 是"大奖励"
};


// ── 游戏状态：整个作品的"当前真相" ──────────────────────────────────────────
let state = {
  energy: CONFIG.START_ENERGY,             // 能量 0~100
  totalTouches: 0,                         // 总触摸数（整场累计，只增不减）
  cycleTouches: 0,                         // 本轮触摸数（每次恢复后归零，用来比阈值）
  contribution: CONFIG.CONTRIBUTION_START, // 贡献计数（灯箱那个荒诞大数字，只增不减）
  status: 'ONLINE',                        // 'ONLINE' 运行 / 'OFFLINE' 垮掉
};

let recovering = false; // 内部开关：防止重复安排恢复定时器


// ── 广播完整状态给所有客户端 ────────────────────────────────────────────────
function broadcastState() {
  const progress = state.cycleTouches / CONFIG.OFFLINE_TOUCH_THRESHOLD; // 本轮进度 0~1
  io.emit('state', {
    energy: Math.round(state.energy),
    totalTouches: state.totalTouches,
    cycleTouches: state.cycleTouches,
    cycleProgress: Math.min(progress, 1), // 视觉窗口做"脸的演化程度"最好用这个
    contribution: state.contribution,
    status: state.status,
    threshold: CONFIG.OFFLINE_TOUCH_THRESHOLD,
  });
}


// ── 让系统垮掉（OFFLINE），并安排自动恢复。所有 OFFLINE 的唯一入口 ────────────
// 以后你加心率/姿态检测触发，只要调用 goOffline('heartrate') 就行。
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
      state.energy = CONFIG.START_ENERGY; // 能量充满
      state.cycleTouches = 0;             // 本轮触摸归零（避免刚恢复又触发）
      recovering = false;                 // totalTouches / contribution 不归零
      console.log('【ONLINE】系统恢复，新的一轮开始。');
      io.emit('systemOnline', {});
      broadcastState();
    }, CONFIG.OFFLINE_RECOVER_MS);
  }
}


// ── 处理一次触摸：整个游戏最核心的一步 ──────────────────────────────────────
function handleTouch(payload) {
  if (state.status === 'OFFLINE') return; // 垮掉期间触摸无效

  state.totalTouches += 1;   // 总触摸数 +1
  state.cycleTouches += 1;   // 本轮触摸数 +1
  state.contribution += 1;   // 贡献计数 +1
  state.energy = Math.min(state.energy + CONFIG.ENERGY_PER_TOUCH, CONFIG.MAX_ENERGY); // 能量回升

  // 变率强化：服务器统一掷骰子，保证糖音/手机闪光/脸的高光在同一次触摸一起爆
  const big = Math.random() < CONFIG.BIG_REWARD_CHANCE;

  // 糖信号 → 声音窗口播观众奖励音；手机窗口做闪光
  io.emit('triggerSugar', { big: big, x: payload && payload.x, y: payload && payload.y });

  // 刀信号 → 声音窗口给"我"的耳机播折磨音，intensity 随本轮进度上升
  const intensity = Math.min(state.cycleTouches / CONFIG.OFFLINE_TOUCH_THRESHOLD, 1);
  io.emit('triggerKnife', { intensity: intensity });

  broadcastState();

  // 检查阈值：最后一次触摸把 contribution 推到下一格、糖刀都发完，然后一切归于黑暗
  if (state.cycleTouches >= CONFIG.OFFLINE_TOUCH_THRESHOLD) {
    goOffline('threshold');
  }
}


// ── 心跳循环：每 100ms 跑一次，负责能量衰减 + 定时广播 ──────────────────────
setInterval(() => {
  if (state.status === 'ONLINE') {
    state.energy -= CONFIG.ENERGY_DECAY_PER_SEC * (CONFIG.TICK_MS / 1000);
    if (state.energy <= 0) {
      state.energy = 0;
      goOffline('energy'); // 没人维持 → 能量耗尽 → 垮掉
    }
  }
  broadcastState(); // 每秒10次，让能量条平滑地动
}, CONFIG.TICK_MS);


// ── 客户端连接 ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`【连接】id=${socket.id}，当前在线数：${io.engine.clientsCount}`);

  // 一连上立刻发当前状态，客户端不用等就能同步
  socket.emit('state', {
    energy: Math.round(state.energy),
    totalTouches: state.totalTouches,
    cycleTouches: state.cycleTouches,
    cycleProgress: Math.min(state.cycleTouches / CONFIG.OFFLINE_TOUCH_THRESHOLD, 1),
    contribution: state.contribution,
    status: state.status,
    threshold: CONFIG.OFFLINE_TOUCH_THRESHOLD,
  });

  // 【核心】收到手机的 touch 事件
  socket.on('touch', (payload) => handleTouch(payload));

  // 现场调试用的管理员事件（可选）
  socket.on('admin:setThreshold', (value) => {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n > 0) { CONFIG.OFFLINE_TOUCH_THRESHOLD = n; console.log(`【管理】阈值改为 ${n}`); broadcastState(); }
  });
  socket.on('admin:forceOffline', () => { console.log('【管理】手动 OFFLINE'); goOffline('manual'); });
  socket.on('admin:reset', () => {
    state.energy = CONFIG.START_ENERGY; state.cycleTouches = 0; state.status = 'ONLINE'; recovering = false;
    console.log('【管理】手动重置本轮'); broadcastState();
  });

  socket.on('disconnect', () => console.log(`【断开】id=${socket.id}，当前在线数：${io.engine.clientsCount}`));
});


// ── Render 保活：健康检查 + 每14分钟自己 ping 自己（沿用你旧代码的做法）─────────
app.get('/health', (req, res) => res.send('ok'));
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }, 14 * 60 * 1000);
}


// ── 启动服务器。Render 会自动给一个 PORT，本地就用 3000 ──────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('============================================================');
  console.log(` SWARM 服务器已启动，端口 ${PORT}`);
  console.log(` 本机调试页面：http://localhost:${PORT}/monitor.html`);
  console.log(` 当前阈值：${CONFIG.OFFLINE_TOUCH_THRESHOLD}，恢复时间：${CONFIG.OFFLINE_RECOVER_MS / 1000}秒`);
  console.log('============================================================');
});
