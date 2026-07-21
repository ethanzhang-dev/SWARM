/* ════════════════════════════════════════════════════════════════
   SWARM · sound.js
   独立声音模块 —— 封装四音色（糖 / 刀 / 运转声 / 断电）
   参数来自测试台 v2 里已经调好、确认满意的最终数值

   ============================================================
   怎么在主 HTML 里引入这个文件（三步）
   ============================================================

   第一步：在 <head> 或 <body> 最上面，先加载 Tone.js，
          再加载 sound.js（顺序不能反）：

     <script src="https://cdnjs.cloudflare.com/ajax/libs/tone/14.7.77/Tone.js"></script>
     <script src="sound.js"></script>

   第二步：需要一次"用户手势"来解锁音频（浏览器安全策略要求，
          不能自动播放）。通常是表演开始前的一个按钮：

     <button id="startBtn">开始表演</button>
     <script>
       document.getElementById('startBtn').onclick = async () => {
         await SwarmSound.init();   // 必须 await，初始化是异步的
         SwarmSound.startAmbient(); // 运转声可以在这里就开始播放
       };
     </script>

   第三步：收到 Socket.io 的触摸事件时，调用 SwarmSound 的函数。
          【关键】糖和刀必须用同一次 pickTier() 的结果，
          这样观众收到大奖励的同一瞬间，你耳机里收到对应的刀声：

     socket.on('touch', () => {
       const tier = SwarmSound.pickTier();  // 只掷一次骰子！
       SwarmSound.playSugar(tier);          // 音箱：观众奖励音
       SwarmSound.playKnife(tier);          // 耳机：表演者刀声，同一档位
     });

     socket.on('systemOffline', () => {
       SwarmSound.playOffline();
       SwarmSound.stopAmbient();
     });

     socket.on('systemOnline', () => {
       SwarmSound.startAmbient();
     });

   ============================================================
   【重要】关于音频路由的现状和将来的升级路径
   ============================================================
   现在笔记本只有一个 Realtek 内置声卡，3.5mm 孔插耳机不会
   产生新的设备 ID，所以 setSinkId() 暂时没法真正把糖声和刀声
   分到两个物理设备上。现在两者其实都从同一个默认输出播放。

   为了不影响以后接入 USB 音频设备，下面代码特意把"音箱总线"
   （speakerBus）和"耳机总线"（headphoneBus）分开声明成两个
   独立的节点 —— 糖声/运转声/断电永远连到 speakerBus，
   刀声永远连到 headphoneBus。

   USB 设备到货、新设备 ID 出现之后，你只需要改
   _initBuses() 这一个函数里的两行连接代码，把 speakerBus 和
   headphoneBus 各自路由到正确的输出设备，下面所有播放逻辑
   （playSugar/playKnife/等等）完全不用动一个字。

   今天的测试方法（单输出验证法）：
   摘掉耳机 → 声音从笔记本喇叭出来 → 触发 playSugar() 确认糖声正确
   戴上耳机 → 声音从耳机出来（这时候喇叭通常会被笔记本自动静音，
   这是 Windows 耳机孔的标准行为）→ 触发 playKnife() 确认刀声正确
   两个分开单独测试，不是同时分路对比。
   ════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 音箱总线 / 耳机总线
  // ────────────────────────────────────────────────────────────
  let speakerBus = null;   // 此处 = 音箱输出。糖声、运转声、断电都汇入这里
  let headphoneBus = null; // 此处 = 耳机输出。只有刀声走这里

  function _initBuses() {
    // 【此处 = 音箱输出，将来改为 speakerCtx】
    // 现在：默认输出设备（笔记本喇叭）
    // 将来：USB设备到货后，把 .toDestination() 换成连到
    //       speakerCtx 对应的目标节点（比如通过 setSinkId 选定的
    //       喇叭设备），下面用到 speakerBus 的代码不用改
    speakerBus = new Tone.Gain(1).toDestination();

    // 【此处 = 耳机输出，将来改为 headphoneCtx】
    // 现在：默认输出设备（和上面是同一个，暂时没法分开）
    // 将来：USB设备到货后，把 .toDestination() 换成连到
    //       headphoneCtx 对应的目标节点（耳机设备），
    //       下面用到 headphoneBus 的代码不用改
    headphoneBus = new Tone.Gain(1).toDestination();
  }

  // ────────────────────────────────────────────────────────────
  // 参数配置区 —— 测试台 v2 调好的最终数值
  // 想微调声音效果，只改这里的数字就够了，不用碰下面的逻辑代码
  // ────────────────────────────────────────────────────────────
  const CONFIG = {
    sugar: {
      attack: 0.004, decay: 0.08, sustain: 0.10, release: 0.40,
      decorVolume: -26,      // 装饰层音量，永远很轻，永远伴随触发
      comboWindowMs: 1200,   // 连击窗口 1.2 秒
      arpGap: 0.06,          // 大奖励琶音音符间隔（秒）
      volSmall: -12,
      volMedium: -7,
      volBig: -3
    },
    knife: {
      baseFreqCenter: 800,   // 基频中心 800Hz
      baseFreqRange: 20,     // ± 20Hz 随机浮动
      dfOptions: [5, 15, 28],// 拍频差三选一，每次触发随机挑
      attack: 0.002, decay: 0.08, sustain: 0, release: 0.020,
      envDuration: 0.15,     // 包络总时长
      transientFreq: 4200,   // 瞬态尖峰频率
      transientDuration: 0.010,
      panRange: 0.60,        // 声道随机偏移范围 ±0.60
      MAX_DB: -10,           // 安全上限——写死在代码里，任何情况都不能超过
      volBig: -10,           // 大档 = 安全上限本身
      volMedium: -15,
      volSmall: -20
    },
    ambient: {
      lowpassCutoff: 80, rolloff: -24,
      lfoMin: 0.15, lfoMax: 0.20, // 呼吸速度范围，运行时随机取一个固定值
      gainMin: 0.15, gainMax: 0.55, // 呼吸低谷 / 峰值
      volume: -15,
      escalation: {
        satTouches: 150,       // 饱和所需触摸次数
        maxCutoffAddHz: 30,    // 饱和时截止频率最多加多少Hz
        maxVolAddDb: 2.0       // 饱和时音量最多加多少dB
      }
    },
    offline: {
      // 版本切换：改这一个字母就行，'A'=清脆(300Hz高通) 'B'=沉闷(900Hz低通)
      // 【待定】还没最终选定版本，先默认 A，你可以现场用耳朵定下来再改这里
      version: 'A',
      attack: 0.001,
      A: { decay: 0.20, hpFreq: 300 },
      B: { decay: 0.25, lpFreq: 900 },
      volume: -3
    }
  };

  // 五声音阶：C5 D5 E5 G5 A5 C6 D6 E6（十二平均律频率，Hz）
  const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50, 1174.66, 1318.51];

  // ────────────────────────────────────────────────────────────
  // 内部状态（外部不需要直接碰这些变量）
  // ────────────────────────────────────────────────────────────
  let ready = false;

  let comboIndex = 0;    // 当前在五声音阶里的位置
  let lastTouchMs = 0;   // 上一次触摸的时间戳，用来判断连击是否还在窗口内
  let touchCount = 0;    // 累计触摸总数，驱动运转声过载

  let sugarCore, sugarDecor;

  let knifeOsc1, knifeOsc2, knifeEnv, knifeGain, knifePanner;
  let knifeTransientOsc, knifeTransientEnv;

  let ambNoise, ambFilter, ambMasterGain, ambMuteGain;
  let ambBreathTimer = null, ambBreathPhase = 0, ambLfoHz = 0.15;
  let ambEscBoostDb = 0;
  let ambRunning = false;

  let offNoiseA, offHPFA, offEnvA, offGainA;
  let offNoiseB, offFilterB, offEnvB, offGainB;

  // ────────────────────────────────────────────────────────────
  // 初始化 —— 必须在用户点击之后调用（浏览器音频解锁策略要求）
  // ────────────────────────────────────────────────────────────
  async function init() {
    if (ready) return;
    await Tone.start(); // 解锁 Web Audio API，必须响应用户手势才能成功

    _initBuses();
    _initSugar();
    _initKnife();
    _initAmbient();
    _initOffline();

    ready = true;
    console.log('[SwarmSound] 音频引擎已就绪');
  }

  // ════════════════════════════════════════════════════════════
  // ① 糖声 —— 观众奖励音，走 speakerBus
  // ════════════════════════════════════════════════════════════
  function _initSugar() {
    const c = CONFIG.sugar;

    // 核心层：三角波，承担主音高；用 PolySynth 支持大奖励快速多音琶音
    sugarCore = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: c.attack, decay: c.decay, sustain: c.sustain, release: c.release }
    }).connect(speakerBus);

    // 装饰层：固定正弦波，永远高核心层一个八度，永远伴随触发（不管哪一档）
    sugarDecor = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.06, sustain: 0.05, release: 0.30 },
      volume: c.decorVolume
    }).connect(speakerBus);
  }

  // 播放糖声。tier 必须是 'small' / 'medium' / 'big' 之一
  function playSugar(tier) {
    if (!_guard()) return;
    const c = CONFIG.sugar;
    const dur = c.decay + c.release * 0.4;

    if (tier === 'small') {
      // 70% 小反馈：单个复合音（核心+装饰），轻
      const freq = PENTATONIC[comboIndex];
      sugarCore.volume.value = c.volSmall;
      sugarCore.triggerAttackRelease(freq, dur);
      sugarDecor.triggerAttackRelease(freq * 2, dur);

    } else if (tier === 'medium') {
      // 25% 中反馈：比当前连击位置再高一级，更亮更响
      const idx = Math.min(comboIndex + 1, PENTATONIC.length - 1);
      const freq = PENTATONIC[idx];
      sugarCore.volume.value = c.volMedium;
      sugarCore.triggerAttackRelease(freq, dur * 1.2);
      sugarDecor.triggerAttackRelease(freq * 2, dur * 1.2);

    } else {
      // 5% 大反馈：3-5个音快速上行琶音
      const numNotes = 3 + Math.floor(Math.random() * 3); // 3~5
      const now = Tone.now();
      sugarCore.volume.value = c.volBig;
      for (let i = 0; i < numNotes; i++) {
        const idx = Math.min(comboIndex + i, PENTATONIC.length - 1);
        const freq = PENTATONIC[idx];
        const t = now + i * c.arpGap;
        sugarCore.triggerAttackRelease(freq, dur * 0.6, t);
        sugarDecor.triggerAttackRelease(freq * 2, dur * 0.6, t);
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // ② 刀声 —— 只有表演者听到，走 headphoneBus
  // ════════════════════════════════════════════════════════════
  function _initKnife() {
    const c = CONFIG.knife;

    // 共用输出链：增益（音量，硬顶-10dB）→ 声像 → 耳机总线
    knifeGain = new Tone.Gain(Tone.dbToGain(c.volSmall));
    knifePanner = new Tone.Panner(0).connect(headphoneBus);
    knifeGain.connect(knifePanner);

    // 包络：控制核心层+失谐层的"有声/无声"
    knifeEnv = new Tone.AmplitudeEnvelope({
      attack: c.attack, decay: c.decay, sustain: c.sustain, release: c.release
    }).connect(knifeGain);

    // 核心层振荡器A + 失谐伴侣振荡器B（持续运行，由包络门控制）
    knifeOsc1 = new Tone.Oscillator({ type: 'sawtooth', frequency: c.baseFreqCenter }).connect(knifeEnv);
    knifeOsc2 = new Tone.Oscillator({ type: 'sawtooth', frequency: c.baseFreqCenter + 15 }).connect(knifeEnv);
    knifeOsc1.start();
    knifeOsc2.start();

    // 瞬态尖峰层：独立包络，极短，固定正弦波
    knifeTransientEnv = new Tone.AmplitudeEnvelope({
      attack: 0.0005, decay: 0.01, sustain: 0, release: 0.005
    }).connect(knifeGain);
    knifeTransientOsc = new Tone.Oscillator({ type: 'sine', frequency: c.transientFreq }).connect(knifeTransientEnv);
    knifeTransientOsc.start();
  }

  // 安全上限：任何情况下刀声都不能超过这个音量，代码层面强制约束
  function _clampKnifeVol(v) {
    return Math.min(v, CONFIG.knife.MAX_DB);
  }

  // 每次触发都重新随机化基频/失谐差/声像——这是"抗听觉适应"的核心机制
  function _randomizeKnifeParams() {
    const c = CONFIG.knife;
    const baseFreq = c.baseFreqCenter + (Math.random() * 2 - 1) * c.baseFreqRange;
    const df = c.dfOptions[Math.floor(Math.random() * c.dfOptions.length)];

    knifeOsc1.frequency.value = baseFreq;
    knifeOsc2.frequency.value = baseFreq + df;

    knifePanner.pan.value = (Math.random() * 2 - 1) * c.panRange;
  }

  // 播放刀声。tier 必须和同一次触摸传给 playSugar 的 tier 完全一致
  function playKnife(tier) {
    if (!_guard()) return;
    const c = CONFIG.knife;

    _randomizeKnifeParams(); // 每次触发都重新随机，防止表演者听觉适应

    const vol = tier === 'big' ? c.volBig : (tier === 'medium' ? c.volMedium : c.volSmall);
    knifeGain.gain.value = Tone.dbToGain(_clampKnifeVol(vol));

    knifeEnv.triggerAttackRelease(c.envDuration);
    knifeTransientEnv.triggerAttackRelease(c.transientDuration);
  }

  // ════════════════════════════════════════════════════════════
  // 变率强化掷骰子 —— 糖和刀必须使用同一次结果，保证同一瞬间绑定
  // 同时在这里推进连击音阶位置、累加触摸计数（驱动运转声过载）
  // ════════════════════════════════════════════════════════════
  function pickTier() {
    // 连击逻辑：1.2秒内连续触摸 → 音阶上爬一级；超时 → 随机新起点
    const nowMs = Date.now();
    if (nowMs - lastTouchMs > CONFIG.sugar.comboWindowMs) {
      comboIndex = Math.floor(Math.random() * PENTATONIC.length);
    } else {
      comboIndex = Math.min(comboIndex + 1, PENTATONIC.length - 1);
    }
    lastTouchMs = nowMs;

    // 累计触摸计数，用于运转声的缓慢过载
    touchCount++;
    _updateAmbientEscalation();

    // 变率强化：70% 小 / 25% 中 / 5% 大
    const r = Math.random();
    if (r < 0.70) return 'small';
    if (r < 0.95) return 'medium';
    return 'big';
  }

  // ════════════════════════════════════════════════════════════
  // ③ 运转声 —— 持续背景音，走 speakerBus
  // 信号链：棕噪音 → 低通滤波器 → 主增益（呼吸感）→ 静音门
  // ════════════════════════════════════════════════════════════
  function _initAmbient() {
    const c = CONFIG.ambient;

    ambMuteGain = new Tone.Gain(0).connect(speakerBus);
    ambMasterGain = new Tone.Gain(Tone.dbToGain(c.volume)).connect(ambMuteGain);
    ambFilter = new Tone.Filter({ frequency: c.lowpassCutoff, type: 'lowpass', rolloff: c.rolloff }).connect(ambMasterGain);
    ambNoise = new Tone.Noise('brown').connect(ambFilter);
    ambNoise.start();

    // 呼吸速度在 0.15-0.20Hz 之间随机取一个值，本次运行全程固定不变
    ambLfoHz = c.lfoMin + Math.random() * (c.lfoMax - c.lfoMin);

    // 用 setInterval 每 50ms 直接写 gain.value 做呼吸效果
    // （不用 Tone.LFO，因为 Tone.js 某些版本下 LFO→Gain(0) 的叠加可能失效，
    //  实测 setInterval 方案稳定可靠）
    ambBreathPhase = 0;
    ambBreathTimer = setInterval(_ambientBreathTick, 50);
  }

  function _ambientBreathTick() {
    if (!ambMasterGain) return;
    const c = CONFIG.ambient;
    ambBreathPhase += 2 * Math.PI * ambLfoHz * 0.05;
    const sinVal = Math.sin(ambBreathPhase);
    const lfoVal = c.gainMin + (c.gainMax - c.gainMin) * (0.5 + 0.5 * sinVal);
    const volDb = c.volume + ambEscBoostDb;
    ambMasterGain.gain.value = Tone.dbToGain(volDb) * lfoVal;
  }

  // 随累计触摸叠加过载效果（截止频率缓慢爬升 + 音量微增）
  function _updateAmbientEscalation() {
    if (!ambFilter) return;
    const e = CONFIG.ambient.escalation;
    const ratio = Math.min(touchCount / e.satTouches, 1);
    ambFilter.frequency.value = CONFIG.ambient.lowpassCutoff + ratio * e.maxCutoffAddHz;
    ambEscBoostDb = ratio * e.maxVolAddDb; // _ambientBreathTick 会在下一次 tick 自动用到
  }

  function startAmbient() {
    if (!_guard()) return;
    ambMuteGain.gain.rampTo(1, 0.8);
    ambRunning = true;
  }

  function stopAmbient() {
    if (!_guard()) return;
    ambMuteGain.gain.rampTo(0, 0.8);
    ambRunning = false;
  }

  // ════════════════════════════════════════════════════════════
  // ④ 断电音效 —— 走 speakerBus，两个版本都建好，用 CONFIG.offline.version 切换
  // ════════════════════════════════════════════════════════════
  function _initOffline() {
    const c = CONFIG.offline;

    // 版本 A：清脆电流感（300Hz高通）
    offGainA = new Tone.Gain(Tone.dbToGain(c.volume)).connect(speakerBus);
    offHPFA = new Tone.Filter({ frequency: c.A.hpFreq, type: 'highpass' }).connect(offGainA);
    offEnvA = new Tone.AmplitudeEnvelope({ attack: c.attack, decay: c.A.decay, sustain: 0, release: 0.001 }).connect(offHPFA);
    offNoiseA = new Tone.Noise('white').connect(offEnvA);
    offNoiseA.start();

    // 版本 B：沉闷断裂感（900Hz低通）
    offGainB = new Tone.Gain(Tone.dbToGain(c.volume)).connect(speakerBus);
    offFilterB = new Tone.Filter({ frequency: c.B.lpFreq, type: 'lowpass' }).connect(offGainB);
    offEnvB = new Tone.AmplitudeEnvelope({ attack: c.attack, decay: c.B.decay, sustain: 0, release: 0.001 }).connect(offFilterB);
    offNoiseB = new Tone.Noise('white').connect(offEnvB);
    offNoiseB.start();
  }

  // 播放断电音效。用哪个版本由 CONFIG.offline.version 决定（'A' 或 'B'）
  function playOffline() {
    if (!_guard()) return;
    const c = CONFIG.offline;
    if (c.version === 'A') {
      offEnvA.triggerAttackRelease(c.A.decay + 0.002);
    } else {
      offEnvB.triggerAttackRelease(c.B.decay + 0.002);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 工具函数
  // ────────────────────────────────────────────────────────────
  function _guard() {
    if (!ready) {
      console.warn('[SwarmSound] 尚未初始化，请先在用户点击后调用 SwarmSound.init()');
      return false;
    }
    return true;
  }

  // ────────────────────────────────────────────────────────────
  // 对外暴露的接口 —— 主系统只需要用这几个函数
  // ────────────────────────────────────────────────────────────
  global.SwarmSound = {
    init: init,               // 异步，必须在用户点击后调用一次
    pickTier: pickTier,       // 掷骰子，返回 'small'/'medium'/'big'，同时推进连击和计数
    playSugar: playSugar,     // playSugar(tier)
    playKnife: playKnife,     // playKnife(tier) —— tier 要和 playSugar 用同一个
    startAmbient: startAmbient,
    stopAmbient: stopAmbient,
    playOffline: playOffline
  };

})(window);
