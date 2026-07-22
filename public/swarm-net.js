/**
 * ============================================================================
 * SWARM · swarm-net.js  ——  屏幕端整合层（网络 + 闪亮 + 消退 + OFFLINE）
 * ============================================================================
 * 这个版本对接你的真实 sound.js（API 是 SwarmSound.* 对象）。
 *
 * 依赖顺序（index.html 里的引入顺序不能错）：
 *   ① Tone.js  →  ② sound.js  →  ③ swarm-net.js  →  ④ 画面代码
 *
 * 你在 index.html 里要做的事只有四处：
 *   1. 用户点击"开始"按钮时：调用 swarmInit()（它会初始化音频+连接服务器）
 *   2. draw() 第一行：swarmUpdate()
 *   3. draw() 最后一行：swarmDrawOverlay()
 *   4. 画线描透明度：swarmLineAlpha(你的值)  画视频透明度：swarmVideoAlpha(你的值)
 * ============================================================================
 */

// ── 全局对象：你的画面代码从这里读数据 ──────────────────────────────────────
const SWARM = {
  flashIntensity: 0,  // 0~1。每次触摸跳到1，然后每帧 *=0.92 衰减（线描闪亮）
  fade: 1,            // 0~1。长时间无人触摸时缓慢下降（消退感），有人摸就回升
  status: 'ONLINE',  // 'ONLINE' / 'OFFLINE'
  state: {
    energy: 100,
    totalTouches: 0,
    cycleTouches: 0,
    cycleProgress: 0,
    contribution: 4471902,
    threshold: 150,
  },
  connected: false,
  lastTouchTime: 0,
};

// ── 可调参数 ─────────────────────────────────────────────────────────────────
const NET_CONFIG = {
  SERVER_URL: '',        // 留空 = 自动连同源服务器（页面在 public/ 里时不用改）
  FLASH_DECAY: 0.92,    // 闪亮每帧衰减系数
  IDLE_DELAY_MS: 3000,  // 无人触摸超过这么久开始消退
  FADE_DOWN_SPEED: 0.004,
  FADE_UP_SPEED: 0.08,
  FADE_FLOOR: 0.25,     // 消退下限（不会全黑）
};

let swarmSocket = null;
let swarmInited = false;

// ── 声音工具：统一从 SwarmSound 调用，函数不存在时静默跳过 ──────────────────
function _sound(fn, ...args) {
  if (window.SwarmSound && typeof window.SwarmSound[fn] === 'function') {
    window.SwarmSound[fn](...args);
  }
}

// ============================================================================
// swarmInit() —— 在用户点击"开始"后调用一次
// 负责：初始化音频引擎 + 连接服务器
// ============================================================================
async function swarmInit() {
  if (swarmInited) return;
  swarmInited = true;

  // 初始化音频（必须在用户手势内调用，否则浏览器会拒绝播放声音）
  if (window.SwarmSound) {
    await SwarmSound.init();
    console.log('[SWARM] 音频引擎已初始化');
  }

  // 连接服务器
  swarmSocket = NET_CONFIG.SERVER_URL
    ? io(NET_CONFIG.SERVER_URL, { transports: ['websocket'] })
    : io({ transports: ['websocket'] });

  swarmSocket.on('connect', () => {
    SWARM.connected = true;
    console.log('[SWARM] 已连接服务器');
    _sound('startAmbient'); // 连上服务器后启动背景运转声
  });

  swarmSocket.on('disconnect', () => {
    SWARM.connected = false;
    console.log('[SWARM] 与服务器断开');
  });

  // 状态快照（每秒约10次）—— 只做赋值，不做任何绘图
  swarmSocket.on('state', (s) => {
    SWARM.state = s;
    SWARM.status = s.status;
  });

  // 糖信号 → 观众奖励音（音箱）+ 线描闪亮
  swarmSocket.on('triggerSugar', (d) => {
    // ★ 用 pickTier() 推进连击状态和运转声过载（忽略它的返回值，档位由服务器决定）
    if (window.SwarmSound) SwarmSound.pickTier();
    // 用服务器决定的档位播糖声
    _sound('playSugar', d.tier); // d.tier = 'small' / 'medium' / 'big'

    // 线描闪亮：大档位可以更亮一点
    SWARM.flashIntensity = d.tier === 'big' ? 1.2 : 1.0;
    SWARM.lastTouchTime = millis(); // 重置消退计时
  });

  // 刀信号 → 只进我耳机（★ 和糖完全相同的 tier，由服务器保证）
  swarmSocket.on('triggerKnife', (d) => {
    _sound('playKnife', d.tier);
  });

  // 系统垮掉
  swarmSocket.on('systemOffline', (d) => {
    SWARM.status = 'OFFLINE';
    console.log('[SWARM] SYSTEM OFFLINE，原因:', d.reason);
    _sound('stopAmbient');
    _sound('playOffline');
  });

  // 系统恢复
  swarmSocket.on('systemOnline', () => {
    SWARM.status = 'ONLINE';
    SWARM.flashIntensity = 0;
    SWARM.fade = 1;
    console.log('[SWARM] 系统恢复');
    _sound('startAmbient');
  });
}

// ============================================================================
// swarmUpdate() —— 在 draw() 第一行调用，每帧执行
// ============================================================================
function swarmUpdate() {
  // 闪亮衰减
  SWARM.flashIntensity *= NET_CONFIG.FLASH_DECAY;
  if (SWARM.flashIntensity < 0.01) SWARM.flashIntensity = 0;

  // 消退逻辑
  const idle = millis() - SWARM.lastTouchTime;
  if (idle > NET_CONFIG.IDLE_DELAY_MS) {
    SWARM.fade = max(NET_CONFIG.FADE_FLOOR, SWARM.fade - NET_CONFIG.FADE_DOWN_SPEED);
  } else {
    SWARM.fade = min(1, SWARM.fade + NET_CONFIG.FADE_UP_SPEED);
  }
}

// ============================================================================
// swarmDrawOverlay() —— 在 draw() 最后一行调用
// OFFLINE 时盖住整个画面
// ============================================================================
function swarmDrawOverlay() {
  if (SWARM.status !== 'OFFLINE') return;
  push();
  noStroke();
  fill(0);
  rect(0, 0, width, height);
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(min(width, height) * 0.06);
  textFont('monospace');
  text('SYSTEM OFFLINE', width / 2, height / 2);
  pop();
}

// ── 视觉亮度工具函数 ─────────────────────────────────────────────────────────
// 线描透明度（触摸时闪亮，无人时消退）
function swarmLineAlpha(baseAlpha) {
  return constrain(baseAlpha * SWARM.fade * (1 + SWARM.flashIntensity * 1.2), 0, 255);
}
// 底层视频透明度（无人时一起消退）
function swarmVideoAlpha(baseAlpha) {
  return constrain(baseAlpha * SWARM.fade, 0, 255);
}
