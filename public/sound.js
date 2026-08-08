/* ════════════════════════════════════════════════════════════════
   SWARM · sound.js v3  (2026-08-04)
   独立声音模块 —— 封装五音色（糖 / 刀 / 运转声 / 断电 / 机构人声）

   ============================================================
   怎么在主 HTML 里引入（两行）
   ============================================================
     <script src="https://cdnjs.cloudflare.com/ajax/libs/tone/14.7.77/Tone.js"></script>
     <script src="sound.js"></script>

   ============================================================
   sound.html 里调用方式（不变）
   ============================================================
     socket.on('triggerSugar', (data) => {
       SwarmSound.registerTouch();
       SwarmSound.playSugar(data.tier);
     });
     socket.on('triggerKnife', (data) => {
       SwarmSound.playKnife(data.tier);
     });
     socket.on('knifeToSpeakers', (data) => {
       SwarmSound.playKnifeToSpeakers(data.tier, data.db);
     });
     socket.on('systemOffline', () => {
       SwarmSound.playOffline();
       SwarmSound.stopAmbient();
     });
     socket.on('systemOnline', () => {
       SwarmSound.startAmbient();
     });

   ============================================================
   音频路由总览（v3 最终定稿）
   ============================================================
   headphoneBus → Tone.Destination → 系统默认输出 = 耳机（3.5mm 插上就是）
     · 刀声 playKnife()

   speakerBus → MediaStreamDest → <audio setSinkId> → 笔记本音箱
     · 糖声 playSugar()
     · 机构人声 _maybeSpeakReward()           ← v3 修复点
     · 运转声 startAmbient() / stopAmbient()
     · 断电 playOffline()
     · 崩溃倒带刀声 playKnifeToSpeakers()

   下拉框选【笔记本音箱（Speakers / Realtek）】，不是耳机。

   ============================================================
   v3 改动列表
   ============================================================
   [1] 08-04 路由修复：headphoneBus ↔ speakerBus 架构互换
       headphoneBus = Tone.Destination（OS 默认=耳机），
       speakerBus   = MediaStreamDest → setSinkId → 笔记本音箱

   [2] 08-04 高频无声修复：_fireKnifeOn() 触发前 cancel() 残留包络

   [3] 08-04 PolySynth maxPolyphony:16 防堆积

   [4] 08-04 jitter 定时器改为单例管理

   [5] 08-04 SpeechSynthesis → Tone.Player（本次修复核心）
       根本原因：SpeechSynthesis 是浏览器独立子系统，
       强制走 OS 系统默认设备（= 耳机），
       没有任何 Web API 可以重定向它。
       唯一可靠方案：把四句台词预录成 mp3，
       通过 Tone.Player → speakerBus → setSinkId → 笔记本音箱。
       同时实现了旧代码注释里提到的"电话质感带通滤波"（300–3400Hz）。

   ============================================================
   ★ 配套：需要录制四个语音文件放进 public/ ★
   ============================================================
   文件名          台词
   speech_01.mp3   Thank you.
   speech_02.mp3   Noted.
   speech_03.mp3   Contribution recorded.
   speech_04.mp3   Thank you for your care.

   录制方法（任选一种）：
   A. 用 Windows 录音机 / Audacity，在关掉耳机的状态下用系统 TTS 录制
   B. 用任意 TTS 网站生成 mp3（naturalreaders.com 等），选 British English
   C. 本人录音（机构感更强，推荐）
   建议参数：单声道，44100Hz，-12dBFS 音量，不需要处理（代码已加滤波）
   ════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 音箱总线 / 耳机总线
  // ────────────────────────────────────────────────────────────
  let speakerBus   = null;   // → MediaStreamDest → <audio setSinkId> → 笔记本音箱
  let headphoneBus = null;   // → Tone.Destination → 系统默认 = 3.5mm 耳机

  // speakerBus 的独立通道元件
  let _spkStreamDest = null;   // MediaStreamAudioDestinationNode
  let _spkAudioEl    = null;   // 隐藏 <audio>，用 setSinkId 指向笔记本音箱

  function _initBuses() {
    // ── 耳机通道：刀声专用，走 Tone.Destination（= OS 默认 = 耳机） ──
    headphoneBus = new Tone.Gain(1).toDestination();

    // ── 音箱通道：糖声/人声/运转声/断电，走 setSinkId → 笔记本音箱 ──
    var raw = Tone.getContext().rawContext;
    _spkStreamDest = raw.createMediaStreamDestination();

    speakerBus = new Tone.Gain(1);
    // ★ 用原生 Web Audio API 连接，绕过 Tone.js connect() 对原生节点的兼容问题
    speakerBus.output.connect(_spkStreamDest);

    _spkAudioEl          = document.createElement('audio');
    _spkAudioEl.autoplay  = true;
    _spkAudioEl.srcObject = _spkStreamDest.stream;
    _spkAudioEl.style.display = 'none';
    document.body.appendChild(_spkAudioEl);   // ★ 必须挂进 DOM 才不会被 GC
    _spkAudioEl.play().catch(function(e) {
      console.warn('[SwarmSound] 音箱通道启动失败:', e);
    });

    console.log('[SwarmSound] 双输出总线已建立');
    console.log('  刀声   → Tone.Destination（系统默认=耳机）');
    console.log('  糖/人声 → setSinkId（下拉框选笔记本音箱）');
  }

  // ── 指定音箱走哪个物理设备（糖声/人声/运转声都走这里）──
  // sound.html 下拉框选【笔记本音箱】后点"应用"就调这个
  async function setHeadphoneDevice(deviceId) {
    if (!_spkAudioEl) {
      console.warn('[SwarmSound] 还没 init()，先点 START');
      return false;
    }
    if (typeof _spkAudioEl.setSinkId !== 'function') {
      console.warn('[SwarmSound] 这个浏览器不支持 setSinkId（需要 Chrome 110+）');
      return false;
    }
    try {
      await _spkAudioEl.setSinkId(deviceId);
      console.log('[SwarmSound] ★ 糖声/人声/音箱输出已切到:', deviceId);
      return true;
    } catch (e) {
      console.error('[SwarmSound] 切换音箱输出失败:', e);
      return false;
    }
  }


  // ────────────────────────────────────────────────────────────
  // 参数配置区
  // ────────────────────────────────────────────────────────────
  const CONFIG = {
    sugar: {
      attack: 0.004, decay: 0.08, sustain: 0.10, release: 0.40,
      decorVolume: -26,
      comboWindowMs: 1200,
      arpGap: 0.06,
      volSmall: -12, volMedium: -7, volBig: -3
    },

    knife: {
      // ── v5 高压硬针架构 ──
      peak1: 3850,               // 双不和谐峰1（Hz）
      peak2: 4310,               // 双不和谐峰2（Hz），差460Hz，极度不谐和
      peakJitter: 30,            // 峰频率每次触发的随机浮动 ±Hz
      oscVolDb: 0,               // 振荡器层增益（0dB）
      distortionAmount: 40,      // WaveShaper 削顶失真量（0-100）
      fmDepth: 220,              // FM 噪音调制强度（Hz）
      fmBandwidth: 800,          // FM 噪音带宽（低通截止，Hz）
      noiseVolDb: -6,            // 刮擦噪音层增益
      bp1Freq: 4100,             // 毒针带通1中心频率
      bp2Freq: 4700,             // 毒针带通2中心频率
      bpQ: 55,                   // 级联带通 Q 值（极窄高压）
      jitterIntervalMs: 30,      // 微抖动间隔（ms）
      jitterAmountHz: 120,       // 微抖动幅度 ±Hz
      panRange: 0.60,            // 声道随机偏移范围
      MAX_DB: -10,               // ★ 总输出安全硬顶 —— 绝不动 ★
      volBig: -10,               // 大档 = 安全上限
      volMedium: -15,            // 中档
      volSmall: -20,             // 小档
      stutterCount: 5,           // C 形态：断续脉冲数
      stutterGap: 0.045,         // C 形态：脉冲间隔（秒）
      scrape: {
        url: 'scrape.mp3',
        offsets: [0.1, 1.1, 2.1, 3.1],
        offsetJitter: 0.03,
        sliceDurMin: 0.20,
        sliceDurMax: 0.30,
        rateMin: 1.5,
        rateMax: 2.0,
        volOffsetDb: -6
      },
      shapes: {
        A: { attack:0.001, decay:0.09, sustain:0,    release:0.02, dur:0.16 },
        B: { attack:0.003, decay:0.05, sustain:0.35, release:0.18, dur:0.42 },
        C: { attack:0.001, decay:0.03, sustain:0.12, release:0.06, dur:0.28 }
      }
    },

    ambient: {
      lowpassCutoff: 80, rolloff: -24,
      lfoMin: 0.15, lfoMax: 0.20,
      gainMin: 0.15, gainMax: 0.55,
      volume: -15,
      escalation: { satTouches: 150, maxCutoffAddHz: 30, maxVolAddDb: 2.0 }
    },

    offline: {
      version: 'A',
      attack: 0.001,
      A: { decay: 0.20, hpFreq: 300 },
      B: { decay: 0.25, lpFreq: 900 },
      volume: -3
    },

    speech: {
      // ★★★ v3 重写：SpeechSynthesis 完全替换为 Tone.Player → speakerBus ★★★
      //
      // 根本原因：SpeechSynthesis 是浏览器独立子系统，强制走 OS 默认设备。
      // 插上耳机后 OS 默认 = 耳机，人声就从耳机出来，Web API 无法重定向。
      // 唯一解：预录 mp3 → Tone.Player → speakerBus → setSinkId → 笔记本音箱。
      //
      // 录制说明（见文件头部注释）
      files: [
        'speech_01.mp3',   // "Thank you."
        'speech_02.mp3',   // "Noted."
        'speech_03.mp3',   // "Contribution recorded."
        'speech_04.mp3'    // "Thank you for your care."
      ],
      cooldownMs: 18000,   // 18 秒冷却，不能连续触发
      volumeDb: -9,        // ≈ 旧版 SpeechSynthesis volume:0.35（线性）的 dB 等效
      // 电话质感带通滤波（300–3400Hz）——这是旧代码里"将来用预录文件才能实现"的效果
      // 现在用 Tone.Filter 级联 HPF + LPF 实现，完全在 speakerBus 管辖内
      hpFreq: 300,         // 高通截止：去掉低频嗡嗡（< 300Hz）
      lpFreq: 3400         // 低通截止：去掉高频气声（> 3400Hz）
    }
  };


  const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50, 1174.66, 1318.51];


  // ────────────────────────────────────────────────────────────
  // 内部状态
  // ────────────────────────────────────────────────────────────
  let ready = false;
  let comboIndex = 0, lastTouchMs = 0, touchCount = 0;

  // 系统人声状态（v3：从 SpeechSynthesis 切换到 Tone.Player）
  let lastSpeechMs   = 0;     // 上一次播放时间戳（冷却判断）
  let _speechPlayers = [];    // Tone.Player 数组，每个对应一个 mp3 文件
  let _speechHPF     = null;  // 高通滤波（300Hz）
  let _speechLPF     = null;  // 低通滤波（3400Hz）
  let _speechVol     = null;  // 音量控制节点

  // 糖声
  let sugarCore, sugarDecor;

  // 刀声：两套完整合成链（耳机 / 音箱倒带各一套）
  let knifeH = null;   // Headphone chain
  let knifeS = null;   // Speaker chain (knifeToSpeakers 用)

  // jitter 单例管理（v3 修复：防止多个 interval 并发堆积）
  var _jitterTimers = { H: null, S: null };

  // 运转声
  let ambNoise, ambFilter, ambMasterGain, ambMuteGain;
  let ambBreathTimer = null, ambBreathPhase = 0, ambLfoHz = 0.15;
  let ambEscBoostDb = 0, ambRunning = false;

  // 断电
  let offNoiseA, offHPFA, offEnvA, offGainA;
  let offNoiseB, offFilterB, offEnvB, offGainB;


  // ────────────────────────────────────────────────────────────
  // 初始化
  // ────────────────────────────────────────────────────────────
  async function init() {
    if (ready) return;
    await Tone.start();
    _initBuses();
    _initSugar();
    _initSpeech();          // ★ v3 新增：预录人声 → speakerBus
    knifeH = _buildKnifeChain(headphoneBus);
    knifeS = _buildKnifeChain(speakerBus);
    _initAmbient();
    _initOffline();
    ready = true;
    console.log('[SwarmSound] 音频引擎已就绪（v3 / 刀声 v5 高压硬针）');
  }


  // ════════════════════════════════════════════════════════════
  // ① 糖声 —— 观众奖励音，走 speakerBus → 笔记本音箱
  // ════════════════════════════════════════════════════════════
  function _initSugar() {
    const c = CONFIG.sugar;
    sugarCore = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 16,   // ★ v3 修复：限制复音数，防高频触发时节点堆积静默
      oscillator: { type: 'triangle' },
      envelope: { attack: c.attack, decay: c.decay, sustain: c.sustain, release: c.release }
    }).connect(speakerBus);
    sugarDecor = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 16,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.06, sustain: 0.05, release: 0.30 },
      volume: c.decorVolume
    }).connect(speakerBus);
  }

  function playSugar(tier) {
    if (!_guard()) return;
    const c = CONFIG.sugar;
    const dur = c.decay + c.release * 0.4;

    // ★ 轻微音高漂移（Pitch Drift）
    // 在五声音阶框架上叠加 ±4% 频率偏差（≈ ±65 音分，低于一个半音）。
    // 目的：防止听觉习惯化——连续相同音高会在约 8-12 次后触发听觉适应，
    // 让观众感知不到声音的存在（这会破坏"每次摸都有反馈"的因果链）。
    // 范围刻意设计为"机器精度"级别的偏差：人耳能感知但不会觉得是"走调"，
    // 保持临床严肃质感，不引入音乐性或情绪性变化。
    const pitchDrift = 1 + (Math.random() - 0.5) * 0.08;

    if (tier === 'small') {
      const freq = PENTATONIC[comboIndex] * pitchDrift;
      sugarCore.volume.value = c.volSmall;
      sugarCore.triggerAttackRelease(freq, dur);
      sugarDecor.triggerAttackRelease(freq * 2, dur);

    } else if (tier === 'medium') {
      const idx = Math.min(comboIndex + 1, PENTATONIC.length - 1);
      const freq = PENTATONIC[idx] * pitchDrift;
      sugarCore.volume.value = c.volMedium;
      sugarCore.triggerAttackRelease(freq, dur * 1.2);
      sugarDecor.triggerAttackRelease(freq * 2, dur * 1.2);

    } else {
      // big：3-5 音琶音，每音独立 pitchDrift（相邻音之间有细微差异）
      const numNotes = 3 + Math.floor(Math.random() * 3);
      const now = Tone.now();
      sugarCore.volume.value = c.volBig;
      for (let i = 0; i < numNotes; i++) {
        const idx = Math.min(comboIndex + i, PENTATONIC.length - 1);
        const noteDrift = 1 + (Math.random() - 0.5) * 0.08;   // 每音独立漂移
        const freq = PENTATONIC[idx] * noteDrift;
        const t = now + i * c.arpGap;
        sugarCore.triggerAttackRelease(freq, dur * 0.6, t);
        sugarDecor.triggerAttackRelease(freq * 2, dur * 0.6, t);
      }
    }

    // big 时触发机构人声（18 秒冷却）
    _maybeSpeakReward(tier);
  }


  // ════════════════════════════════════════════════════════════
  // 机构人声 —— v3 完整重写
  //
  // 旧版使用 SpeechSynthesis，无法路由到 speakerBus（耳机路由问题根源）。
  // v3 改为：预录 mp3 → Tone.Player → HPF(300Hz) → LPF(3400Hz)
  //         → Volume(-9dB) → speakerBus → 笔记本音箱
  //
  // 同时实现了旧代码注释里说"将来才能做"的电话质感滤波。
  //
  // ★ 文件还没录好时：静默跳过（Console 提示），不影响其他声音。
  // ════════════════════════════════════════════════════════════

  function _initSpeech() {
    var sc = CONFIG.speech;

    // 信号链：Player → HPF → LPF → Volume → speakerBus
    //   HPF(300Hz) 去掉低频嗡嗡，LPF(3400Hz) 去掉高频气声
    //   两者合并 = 电话频带（300–3400Hz）
    _speechVol = new Tone.Volume(sc.volumeDb).connect(speakerBus);
    _speechLPF = new Tone.Filter({
      type: 'lowpass',  frequency: sc.lpFreq, rolloff: -12
    }).connect(_speechVol);
    _speechHPF = new Tone.Filter({
      type: 'highpass', frequency: sc.hpFreq, rolloff: -12
    }).connect(_speechLPF);

    // 为每个 mp3 文件创建一个 Tone.Player
    _speechPlayers = sc.files.map(function(url) {
      var p = new Tone.Player({
        url: url,
        onload: function() {
          console.log('[SwarmSound] ★ 人声文件已加载:', url);
        },
        onerror: function() {
          // 文件不存在时静默降级，不报错中断启动
          console.warn('[SwarmSound] 人声文件未找到:', url,
            '→ 请录制并放入 public/ 文件夹（见 sound.js 头部说明）');
        }
      });
      // Player 输出 → 电话质感滤波链 → speakerBus
      p.connect(_speechHPF);
      return p;
    });
  }

  function _maybeSpeakReward(tier) {
    // 只在大奖励时触发
    if (tier !== 'big') return;

    // 18 秒冷却
    var now = Date.now();
    if (now - lastSpeechMs < CONFIG.speech.cooldownMs) return;
    lastSpeechMs = now;

    // 找出已加载的文件（Tone.Player.loaded 在文件加载完成后变 true）
    var available = _speechPlayers.filter(function(p) { return p.loaded; });
    if (available.length === 0) {
      // 文件还没录制/还没加载完：静默跳过，不影响表演
      console.warn('[SwarmSound] 人声文件未就绪，跳过本次（请录制 speech_01~04.mp3）');
      return;
    }

    // 随机选一条台词
    var player = available[Math.floor(Math.random() * available.length)];

    try {
      // 如果上一条还在播就先停掉（同一个 Player 不能并发播放两次）
      if (player.state === 'started') player.stop();
      player.start();
    } catch (e) {
      console.warn('[SwarmSound] 人声播放出错:', e);
    }
  }


  // ════════════════════════════════════════════════════════════
  // ② 刀声 v5 —— 高压硬针架构（信号链见注释，架构不变）
  //
  // 两套独立合成链：
  //   knifeH → headphoneBus → Tone.Destination → 系统默认 = 耳机
  //   knifeS → speakerBus  → setSinkId → 音箱（崩溃倒带专用）
  // ════════════════════════════════════════════════════════════

  function _makeClipCurve(amount) {
    const n = 1024, curve = new Float32Array(n);
    const k = (amount / 100) * 40;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = k < 0.01 ? x : (1 + k) * x / (1 + k * Math.abs(x));
    }
    return curve;
  }

  function _buildKnifeChain(outputBus) {
    const c = CONFIG.knife;

    // 总输出：增益(硬顶-10dB) → 声像 → 输出总线
    var panner = new Tone.Panner(0).connect(outputBus);
    var gain   = new Tone.Gain(Tone.dbToGain(c.volSmall)).connect(panner);

    // 振荡器层：双不和谐峰 → 包络 → 削顶失真 → 层增益
    var oscGain = new Tone.Gain(Tone.dbToGain(c.oscVolDb)).connect(gain);
    var shaper  = new Tone.WaveShaper(_makeClipCurve(c.distortionAmount)).connect(oscGain);
    var env     = new Tone.AmplitudeEnvelope({
      attack: c.shapes.A.attack, decay: c.shapes.A.decay,
      sustain: c.shapes.A.sustain, release: c.shapes.A.release
    }).connect(shaper);
    var osc1 = new Tone.Oscillator({ type:'sawtooth', frequency: c.peak1 }).connect(env);
    var osc2 = new Tone.Oscillator({ type:'sawtooth', frequency: c.peak2 }).connect(env);
    osc1.start(); osc2.start();

    // FM 噪音调制（轻微打碎波形）
    var fmNoise  = new Tone.Noise('white').start();
    var fmFilter = new Tone.Filter({ type:'lowpass', frequency: c.fmBandwidth });
    fmNoise.connect(fmFilter);
    var fmS1 = new Tone.Gain(c.fmDepth);
    var fmS2 = new Tone.Gain(c.fmDepth);
    fmFilter.connect(fmS1); fmFilter.connect(fmS2);
    fmS1.connect(osc1.frequency); fmS2.connect(osc2.frequency);

    // 极窄高压金属针：白噪音 → 2级级联高Q带通 → 包络 → 层增益
    var noiseGain = new Tone.Gain(Tone.dbToGain(c.noiseVolDb)).connect(gain);
    var noiseEnv  = new Tone.AmplitudeEnvelope({
      attack: c.shapes.A.attack, decay: c.shapes.A.decay,
      sustain: c.shapes.A.sustain, release: c.shapes.A.release
    }).connect(noiseGain);
    var bp2   = new Tone.Filter({ type:'bandpass', frequency: c.bp2Freq, Q: c.bpQ }).connect(noiseEnv);
    var bp1   = new Tone.Filter({ type:'bandpass', frequency: c.bp1Freq, Q: c.bpQ }).connect(bp2);
    var noise = new Tone.Noise('white').connect(bp1);
    noise.start();

    // 第四层：真实刮擦采样
    var scrapeGain   = new Tone.Gain(Tone.dbToGain(c.scrape.volOffsetDb + c.oscVolDb)).connect(gain);
    var scrapePlayer = new Tone.Player({
      url: c.scrape.url, fadeIn: 0.005, fadeOut: 0.005
    }).connect(scrapeGain);

    return { panner, gain, oscGain, shaper,
             env, osc1, osc2, noiseGain,
             noiseEnv, bp1, bp2,
             scrapePlayer, scrapeGain };
  }

  // bypassMaxDb：
  //   false（默认）= 表演者耳机，受 MAX_DB=-10dB 硬顶约束
  //   true          = 音箱倒带，直接使用传入的 db，-3dB 首发可以通过
  function _fireKnifeOn(chain, tier, overrideDb, bypassMaxDb) {
    if (!chain) return;
    const c = CONFIG.knife;

    const p = Math.random();
    const shapeKey = p < 0.4 ? 'A' : p < 0.75 ? 'B' : 'C';
    const s = c.shapes[shapeKey];

    // ★ 整体音高偏移（Pitch Variation）
    // 每次触发在同一"高频刺耳"音色框架内取不同音高，防止听觉习惯化。
    // 范围：±6%（约 ±100 音分），峰1/峰2/带通三者等比例偏移：
    //   → 内部比例保持不变（音色不变，只是音高感变化）
    //   → 0.94~1.06 × 3850Hz = 3619~4081Hz（仍在高频刺耳区）
    const pitchRatio = 0.94 + Math.random() * 0.12;

    // 峰频率：全局音高偏移 × 本次 jitter（两层随机叠加）
    const pk1 = c.peak1 * pitchRatio + (Math.random() * 2 - 1) * c.peakJitter;
    const pk2 = c.peak2 * pitchRatio + (Math.random() * 2 - 1) * c.peakJitter;
    chain.osc1.frequency.value = pk1;
    chain.osc2.frequency.value = pk2;

    // ★ 带通中心频率跟随全局音高偏移（保持音色一致性）
    chain.bp1.frequency.value = c.bp1Freq * pitchRatio;
    chain.bp2.frequency.value = c.bp2Freq * pitchRatio;

    // 声道随机偏移
    chain.panner.pan.value = (Math.random() * 2 - 1) * c.panRange;

    // 总输出音量
    // ★ bypassMaxDb=true（音箱倒带）：直接使用传入的 db，不受 MAX_DB 限制
    //    （首发 -3dB 的冲击效果必须能通过，MAX_DB 硬顶只约束表演者耳机）
    // ★ bypassMaxDb=false/undefined（耳机）：强制不超过 MAX_DB=-10dB
    const volDb = typeof overrideDb === 'number'
      ? (bypassMaxDb ? overrideDb : Math.min(overrideDb, c.MAX_DB))
      : _tierToDb(tier);
    chain.gain.gain.value = Tone.dbToGain(volDb);

    // 设置包络参数
    chain.env.attack   = s.attack;  chain.env.decay   = s.decay;
    chain.env.sustain  = s.sustain; chain.env.release  = s.release;
    chain.noiseEnv.attack  = s.attack;  chain.noiseEnv.decay  = s.decay;
    chain.noiseEnv.sustain = s.sustain; chain.noiseEnv.release = s.release;

    // ★ v3 修复：高频触摸时包络卡死
    // 上一次 triggerAttackRelease 的 release 还没走完，新的 trigger 进入 Tone.js 内部
    // 排程队列但无法执行，导致后续所有触发静默（high-energy 无声的根源）。
    // cancel() 清掉所有未执行的排程，让新的 trigger 立刻生效。
    chain.env.cancel();
    chain.noiseEnv.cancel();

    // 触发
    if (shapeKey === 'C') {
      // C 形态：断续快速脉冲
      const now = Tone.now();
      const burstDur = s.decay + 0.01;
      for (let i = 0; i < c.stutterCount; i++) {
        const t = now + i * c.stutterGap;
        chain.env.triggerAttackRelease(burstDur, t);
        chain.noiseEnv.triggerAttackRelease(burstDur, t);
      }
    } else {
      chain.env.triggerAttackRelease(s.dur);
      chain.noiseEnv.triggerAttackRelease(s.dur);
    }

    // 微抖动
    _startJitterOn(chain, pk1, pk2, s.dur);

    // 第四层：刮擦采样
    _fireScrapeOn(chain);
  }

  // ★ v3 修复：jitter 定时器单例管理
  // 旧代码每次 _fireKnifeOn 创建新 interval，高频触摸时堆积 → 音频线程过载 → 静默
  function _startJitterOn(chain, basePk1, basePk2, durSec) {
    var c   = CONFIG.knife;
    var key = (chain === knifeH) ? 'H' : 'S';

    // 先清掉同一条链上的旧定时器
    if (_jitterTimers[key]) {
      clearInterval(_jitterTimers[key].iv);
      clearTimeout(_jitterTimers[key].to);
    }

    var iv = setInterval(function() {
      chain.osc1.frequency.value = basePk1 + (Math.random() * 2 - 1) * c.jitterAmountHz;
      chain.osc2.frequency.value = basePk2 + (Math.random() * 2 - 1) * c.jitterAmountHz;
    }, c.jitterIntervalMs);

    var to = setTimeout(function() {
      clearInterval(iv);
      _jitterTimers[key] = null;
    }, durSec * 1000 + 80);

    _jitterTimers[key] = { iv: iv, to: to };
  }

  function _fireScrapeOn(chain) {
    var player = chain.scrapePlayer;
    if (!player || !player.loaded) return;

    var sc = CONFIG.knife.scrape;
    var baseOffset = sc.offsets[Math.floor(Math.random() * sc.offsets.length)];
    var offset = Math.max(0, baseOffset + (Math.random() * 2 - 1) * sc.offsetJitter);
    var sliceDur = sc.sliceDurMin + Math.random() * (sc.sliceDurMax - sc.sliceDurMin);
    player.playbackRate = sc.rateMin + Math.random() * (sc.rateMax - sc.rateMin);

    try { player.stop(); } catch (e) { /* 可能不在播放状态，忽略 */ }
    player.start(Tone.now(), offset, sliceDur);
  }

  function _tierToDb(tier) {
    const c = CONFIG.knife;
    if (tier === 'big')    return Math.min(c.MAX_DB, c.volBig);
    if (tier === 'medium') return Math.min(c.MAX_DB, c.volMedium);
    return Math.min(c.MAX_DB, c.volSmall);
  }

  // 刀声 → 耳机（表演者听到）
  function playKnife(tier) {
    if (!_guard()) return;
    _fireKnifeOn(knifeH, tier);
  }

  // 刀声 → 音箱（崩溃倒带时观众听到）
  // db  由服务器按 index 分层：index=0 → -3dB，index>0 → -10dB
  // ★ bypassMaxDb=true：音箱倒带不受耳机硬顶限制，-3dB 首发可以通过
  function playKnifeToSpeakers(tier, db, index) {
    if (!_guard()) return;
    _fireKnifeOn(knifeS, tier, typeof db === 'number' ? db : -18, true);
  }


  // ════════════════════════════════════════════════════════════
  // 触摸注册（服务器直接发 tier，不需要客户端掷骰子）
  // ════════════════════════════════════════════════════════════
  function registerTouch() {
    const nowMs = Date.now();
    if (nowMs - lastTouchMs > CONFIG.sugar.comboWindowMs) {
      comboIndex = Math.floor(Math.random() * PENTATONIC.length);
    } else {
      comboIndex = Math.min(comboIndex + 1, PENTATONIC.length - 1);
    }
    lastTouchMs = nowMs;
    touchCount++;
    _updateAmbientEscalation();
  }


  // ════════════════════════════════════════════════════════════
  // ③ 运转声 → speakerBus → 笔记本音箱
  // ════════════════════════════════════════════════════════════
  function _initAmbient() {
    const c = CONFIG.ambient;
    ambMuteGain   = new Tone.Gain(0).connect(speakerBus);
    ambMasterGain = new Tone.Gain(Tone.dbToGain(c.volume)).connect(ambMuteGain);
    ambFilter     = new Tone.Filter({
      frequency: c.lowpassCutoff, type: 'lowpass', rolloff: c.rolloff
    }).connect(ambMasterGain);
    ambNoise = new Tone.Noise('brown').connect(ambFilter);
    ambNoise.start();
    ambLfoHz       = c.lfoMin + Math.random() * (c.lfoMax - c.lfoMin);
    ambBreathPhase = 0;
    ambBreathTimer = setInterval(_ambientBreathTick, 50);
  }

  function _ambientBreathTick() {
    if (!ambMasterGain) return;
    const c = CONFIG.ambient;
    ambBreathPhase += 2 * Math.PI * ambLfoHz * 0.05;
    var lfoVal = c.gainMin + (c.gainMax - c.gainMin) * (0.5 + 0.5 * Math.sin(ambBreathPhase));
    ambMasterGain.gain.value = Tone.dbToGain(c.volume + ambEscBoostDb) * lfoVal;
  }

  function _updateAmbientEscalation() {
    if (!ambFilter) return;
    var e = CONFIG.ambient.escalation;
    var ratio = Math.min(touchCount / e.satTouches, 1);
    ambFilter.frequency.value = CONFIG.ambient.lowpassCutoff + ratio * e.maxCutoffAddHz;
    ambEscBoostDb = ratio * e.maxVolAddDb;
  }

  function startAmbient() {
    if (_guard()) { ambMuteGain.gain.rampTo(1, 0.8); ambRunning = true; }
  }

  // hardCut = true  → 10ms 硬切（崩溃瞬间用，确保 2.5 秒绝对死寂）
  // hardCut = false → 0.8s 淡出（正常停止 / sessionReset 用）
  // 10ms 而非 0ms：消除因突然截断产生的爆破音（click）；
  // 体感上与瞬间无异，完全不影响"断裂认知重击"的效果。
  function stopAmbient(hardCut) {
    if (!_guard()) return;
    ambMuteGain.gain.rampTo(0, hardCut ? 0.01 : 0.8);
    ambRunning = false;
  }


  // ════════════════════════════════════════════════════════════
  // ④ 断电 → speakerBus → 笔记本音箱
  // ════════════════════════════════════════════════════════════
  function _initOffline() {
    var c = CONFIG.offline;
    offGainA  = new Tone.Gain(Tone.dbToGain(c.volume)).connect(speakerBus);
    offHPFA   = new Tone.Filter({ frequency: c.A.hpFreq, type: 'highpass' }).connect(offGainA);
    offEnvA   = new Tone.AmplitudeEnvelope({
      attack: c.attack, decay: c.A.decay, sustain: 0, release: 0.001
    }).connect(offHPFA);
    offNoiseA = new Tone.Noise('white').connect(offEnvA);
    offNoiseA.start();

    offGainB   = new Tone.Gain(Tone.dbToGain(c.volume)).connect(speakerBus);
    offFilterB = new Tone.Filter({ frequency: c.B.lpFreq, type: 'lowpass' }).connect(offGainB);
    offEnvB    = new Tone.AmplitudeEnvelope({
      attack: c.attack, decay: c.B.decay, sustain: 0, release: 0.001
    }).connect(offFilterB);
    offNoiseB = new Tone.Noise('white').connect(offEnvB);
    offNoiseB.start();
  }

  function playOffline() {
    if (!_guard()) return;
    var c = CONFIG.offline;
    if (c.version === 'A') offEnvA.triggerAttackRelease(c.A.decay + 0.002);
    else                   offEnvB.triggerAttackRelease(c.B.decay + 0.002);
  }


  // ────────────────────────────────────────────────────────────
  function _guard() {
    if (!ready) { console.warn('[SwarmSound] 尚未初始化，先点 START'); return false; }
    return true;
  }


  // ────────────────────────────────────────────────────────────
  // 对外暴露的接口（和 v2 完全兼容，sound.html 无需改动）
  // ────────────────────────────────────────────────────────────
  global.SwarmSound = {
    init:                init,
    setHeadphoneDevice:  setHeadphoneDevice,   // 选笔记本音箱（不是耳机）
    registerTouch:       registerTouch,
    playSugar:           playSugar,
    playKnife:           playKnife,            // → 耳机
    playKnifeToSpeakers: playKnifeToSpeakers,  // → 音箱（崩溃倒带）
    startAmbient:        startAmbient,
    stopAmbient:         stopAmbient,
    playOffline:         playOffline
  };

})(window);
