/**
 * ============================================================================
 * SWARM · swarm-net.js  ——  屏幕端"整合层"（网络 + 状态 + 闪亮 + 消退 + OFFLINE）
 * ============================================================================
 * 这个文件是你现有视觉代码(sketch.js)和服务器之间的"中间层"。
 * 设计原则：你的视觉代码几乎不用改，只需在 setup/draw 里加三行调用。
 *
 * 你要在 sketch.js 里做的事，只有三处（详见整合说明文档）：
 *   setup()  最后一行： swarmConnect();
 *   draw()   第一行  ： swarmUpdate();
 *   draw()   最后一行： swarmDrawOverlay();
 * 然后在你画线描的地方，用 SWARM.flashIntensity 和 SWARM.fade 调节亮度。
 *
 * 所有数据都挂在一个全局对象 SWARM 上，避免和你现有的变量重名。
 * ============================================================================
 */

// ── 全局对象：你的 sketch.js 从这里读数据 ────────────────────────────────────
const SWARM = {
  // —— 视觉可直接用的三个值 ——
  flashIntensity: 0,   // 0~1。每次触摸跳到1，然后每帧 *=0.92 衰减（线描闪亮）
  fade: 1,             // 0~1。长时间无人触摸时缓慢下降（消退感），有人摸就回升
  status: 'ONLINE',    // 'ONLINE' / 'OFFLINE'

  // —— 服务器完整状态（想显示数字时用）——
  state: {
    energy: 100,
    totalTouches: 0,
    cycleTouches: 0,
    cycleProgress: 0,   // 本轮进度 0~1，做"脸的演化程度"最好用
    contribution: 4471902,
    threshold: 150,
  },

  connected: false,     // 是否连上服务器
  lastTouchTime: 0,     // 最后一次触摸的时间戳（毫秒）
};


// ── 可调参数：整合层的手感都在这里 ──────────────────────────────────────────
const NET_CONFIG = {
  // 服务器地址。页面就放在服务器 public/ 里时，留空字符串即可（自动连同源）。
  // 若你把页面单独打开，改成 'http://localhost:3000' 或你的 Render 网址。
  SERVER_URL: '',

  FLASH_DECAY: 0.92,      // 闪亮每帧衰减系数（越接近1衰减越慢）
  IDLE_DELAY_MS: 3000,    // 无人触摸超过这么久，开始消退
  FADE_DOWN_SPEED: 0.004, // 消退速度（每帧减少多少）
  FADE_UP_SPEED: 0.08,    // 有触摸时恢复速度（每帧增加多少）
  FADE_FLOOR: 0.25,       // 消退的下限（不会全黑，留一点残影）
};


let swarmSocket = null; // socket 连接对象


// ============================================================================
// 1) 连接服务器 —— 在 sketch.js 的 setup() 最后调用一次
// ============================================================================
function swarmConnect() {
  // transports 只用 websocket，跳过低效的轮询，能省一点性能
  swarmSocket = NET_CONFIG.SERVER_URL
    ? io(NET_CONFIG.SERVER_URL, { transports: ['websocket'] })
    : io({ transports: ['websocket'] });

  swarmSocket.on('connect', () => {
    SWARM.connected = true;
    console.log('[SWARM] 已连接服务器');
    // 屏幕端负责放声音：连上后启动背景运转声
    if (typeof startAmbient === 'function') startAmbient();
  });

  swarmSocket.on('disconnect', () => {
    SWARM.connected = false;
    console.log('[SWARM] 与服务器断开');
  });

  // —— 状态快照（每秒约10次）——
  // 注意：这里只做"赋值"，绝不做任何绘图或重计算，否则会拖慢帧率。
  swarmSocket.on('state', (s) => {
    SWARM.state = s;
    SWARM.status = s.status;
  });

  // —— 糖：观众的奖励（音箱）——
  // 视觉的"闪亮"也挂在这里，因为糖和触摸是一一对应的。
  swarmSocket.on('triggerSugar', (d) => {
    // ① 线描闪亮：跳到1（大档位可以更亮一点点）
    SWARM.flashIntensity = 1;
    // ② 记录触摸时间，用于消退判断
    SWARM.lastTouchTime = millis();
    // ③ 播糖声（到音箱）。你的 sound.js 若接收数字，把 d.tier 换成 d.level
    if (typeof playSugar === 'function') playSugar(d.tier);
  });

  // —— 刀：只进我的耳机 ——
  // ★和糖用的是【同一个 tier】，由服务器统一决定，这里绝不再随机。
  swarmSocket.on('triggerKnife', (d) => {
    if (typeof playKnife === 'function') playKnife(d.tier);
  });

  // —— 系统垮掉 ——
  swarmSocket.on('systemOffline', (d) => {
    SWARM.status = 'OFFLINE';
    console.log('[SWARM] SYSTEM OFFLINE，原因:', d.reason);
    if (typeof stopAmbient === 'function') stopAmbient();  // 所有声音停止
    if (typeof playOffline === 'function') playOffline();  // 断电音效
  });

  // —— 系统恢复 ——
  swarmSocket.on('systemOnline', () => {
    SWARM.status = 'ONLINE';
    SWARM.flashIntensity = 0;
    SWARM.fade = 1;                                        // 恢复到正常亮度
    console.log('[SWARM] 系统恢复');
    if (typeof startAmbient === 'function') startAmbient(); // 运转声重新开始
  });
}


// ============================================================================
// 2) 每帧更新 —— 在 sketch.js 的 draw() 第一行调用
//    负责：闪亮衰减、无人触摸时的消退
// ============================================================================
function swarmUpdate() {
  // —— 闪亮衰减：每帧 *= 0.92，约几百毫秒回到正常 ——
  SWARM.flashIntensity *= NET_CONFIG.FLASH_DECAY;
  if (SWARM.flashIntensity < 0.01) SWARM.flashIntensity = 0; // 够小就归零，省得一直算

  // —— 消退：超过 IDLE_DELAY_MS 没人碰，亮度缓慢下降 ——
  const idle = millis() - SWARM.lastTouchTime;
  if (idle > NET_CONFIG.IDLE_DELAY_MS) {
    SWARM.fade = max(NET_CONFIG.FADE_FLOOR, SWARM.fade - NET_CONFIG.FADE_DOWN_SPEED);
  } else {
    SWARM.fade = min(1, SWARM.fade + NET_CONFIG.FADE_UP_SPEED);
  }
}


// ============================================================================
// 3) 覆盖层 —— 在 sketch.js 的 draw() 最后一行调用
//    OFFLINE 时盖住整个画面，显示 SYSTEM OFFLINE
// ============================================================================
function swarmDrawOverlay() {
  if (SWARM.status !== 'OFFLINE') return;

  push();
  // 纯黑盖住一切
  noStroke();
  fill(0);
  rect(0, 0, width, height);

  // 中央文字
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(min(width, height) * 0.06);
  textFont('monospace');
  text('SYSTEM OFFLINE', width / 2, height / 2);
  pop();
}


// ============================================================================
// 辅助：给视觉用的两个便捷函数（可选）
// ============================================================================

// 线描的最终不透明度 = 基础亮度 × 消退 ×（1 + 闪亮加成）
// 用法示例：stroke(255, swarmLineAlpha(180));
function swarmLineAlpha(baseAlpha) {
  const a = baseAlpha * SWARM.fade * (1 + SWARM.flashIntensity * 1.2);
  return constrain(a, 0, 255);
}

// 底层真实视频的不透明度（无人触摸时一起消退）
function swarmVideoAlpha(baseAlpha) {
  return constrain(baseAlpha * SWARM.fade, 0, 255);
}
