// 程序化声音引擎：全部音效由 WebAudio 合成，无外部素材
// 包含：环境底噪（风 / 虫鸣 / 水）、生物叫声、脚步声（随星球材质变化）、
// 能量枪、飞船引擎与大气呼啸、起飞/着陆低频轰鸣，以及生成式氛围音乐。
import * as THREE from 'three';

const NOTE = (semi) => 55 * Math.pow(2, semi / 12); // A1 基频

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.started = false;
    this.musicVol = 0.5;
    this.sfxVol = 0.8;
    this.planet = 'verdant';
    this.layers = {};
    this.musicTimer = 0;
    this.step = 0;
    this.bpm = 64;
    this.engineNode = null;
    this.reverb = null;
    this.lastPlayed = {};
  }

  async init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const ctx = this.ctx;
    // 主混响
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(3.6, 2.2);
    const revGain = ctx.createGain();
    revGain.gain.value = 0.45;
    this.reverb.connect(revGain);
    // 压缩 + 主音量
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.compressor.connect(this.master);
    this.master.connect(ctx.destination);
    revGain.connect(this.compressor);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVol;
    this.sfxBus.connect(this.compressor);
    this.sfxBus.connect(this.reverb);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVol;
    this.musicBus.connect(this.compressor);
    this.musicBus.connect(this.reverb);
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0.8;
    this.ambBus.connect(this.compressor);
    this.ambBus.connect(this.reverb);

    this.noiseBuf = this._makeNoise(3.0, 'white');
    this.brownBuf = this._makeNoise(4.0, 'brown');
    this.pinkBuf = this._makeNoise(3.0, 'pink');
    this.started = true;
    await ctx.resume();
    this._startAmbience();
    this._startMusic();
  }

  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _makeNoise(seconds, type) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    let last = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else if (type === 'pink') {
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
      } else d[i] = w;
    }
    return buf;
  }

  _noiseSource(buf, loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    return s;
  }

  _env(gain, t0, a, d, peak, sustain = 0) {
    const g = gain.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t0 + a + d);
  }

  _panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.rolloffFactor = 1.4;
    if (pos) p.positionX.value = pos.x, p.positionY.value = pos.y, p.positionZ.value = pos.z;
    return p;
  }

  setListener(camera) {
    if (!this.ctx || !camera) return;
    const l = this.ctx.listener;
    const p = camera.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z;
      l.upX.value = u.x; l.upY.value = u.y; l.upZ.value = u.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  // ---------------- 音效 ----------------
  play(name, opts = {}) {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = opts.vol ?? 1;
    let dest = this.sfxBus;
    let node = null;
    if (opts.pos && opts.pos.distanceTo) {
      node = this._panner(opts.pos);
      node.connect(dest);
      dest = node;
    }
    switch (name) {
      case 'laser': {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const base = 1250 * (opts.pitch || 1);
        o.frequency.setValueAtTime(base, t);
        o.frequency.exponentialRampToValueAtTime(base * 0.18, t + 0.16);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 3;
        bp.frequency.setValueAtTime(base * 1.2, t);
        bp.frequency.exponentialRampToValueAtTime(base * 0.3, t + 0.14);
        const g = ctx.createGain();
        this._env(g, t, 0.004, 0.16, 0.32 * vol);
        o.connect(bp).connect(g).connect(dest);
        o.start(t); o.stop(t + 0.2);
        // 空中"嗖"声
        const n = this._noiseSource(this.noiseBuf);
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
        const ng = ctx.createGain(); this._env(ng, t, 0.003, 0.09, 0.1 * vol);
        n.connect(hp).connect(ng).connect(dest);
        n.start(t); n.stop(t + 0.12);
        break;
      }
      case 'hit': {
        const o = ctx.createOscillator(); o.type = 'triangle';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
        const g = ctx.createGain(); this._env(g, t, 0.002, 0.13, 0.35 * vol);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 0.16);
        const n = this._noiseSource(this.pinkBuf);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3400; bp.Q.value = 1.2;
        const ng = ctx.createGain(); this._env(ng, t, 0.001, 0.07, (opts.crit ? 0.3 : 0.16) * vol);
        n.connect(bp).connect(ng).connect(dest); n.start(t); n.stop(t + 0.1);
        if (opts.crit) {
          const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.setValueAtTime(1760, t); o2.frequency.exponentialRampToValueAtTime(880, t + 0.25);
          const g2 = ctx.createGain(); this._env(g2, t, 0.002, 0.25, 0.12 * vol);
          o2.connect(g2).connect(dest); o2.start(t); o2.stop(t + 0.3);
        }
        break;
      }
      case 'creatureHit': this.play('hit', { ...opts, vol: 0.5 }); break;
      case 'creatureDie': {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.9);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(200, t + 0.9);
        const g = ctx.createGain(); this._env(g, t, 0.02, 0.9, 0.22 * vol);
        o.connect(lp).connect(g).connect(dest); o.start(t); o.stop(t + 1.0);
        break;
      }
      case 'creatureAlert': {
        const o = ctx.createOscillator(); o.type = 'square';
        o.frequency.setValueAtTime(180, t); o.frequency.linearRampToValueAtTime(90, t + 0.35);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
        const g = ctx.createGain(); this._env(g, t, 0.03, 0.35, 0.12 * vol);
        o.connect(lp).connect(g).connect(dest); o.start(t); o.stop(t + 0.4);
        break;
      }
      case 'creatureCurious': {
        // 温和巨兽的轻声鸣叫
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(220, t); o.frequency.linearRampToValueAtTime(330, t + 0.3); o.frequency.linearRampToValueAtTime(260, t + 0.7);
        const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.setValueAtTime(440, t); o2.frequency.linearRampToValueAtTime(520, t + 0.6);
        const g = ctx.createGain(); this._env(g, t, 0.12, 0.6, 0.12 * vol);
        const g2 = ctx.createGain(); this._env(g2, t, 0.2, 0.5, 0.04 * vol);
        o.connect(g).connect(dest); o2.connect(g2).connect(dest);
        o.start(t); o.stop(t + 0.9); o2.start(t); o2.stop(t + 0.9);
        break;
      }
      case 'step': {
        const g = ctx.createGain();
        if (this.planet === 'verdant') {
          const n = this._noiseSource(this.pinkBuf);
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900 + Math.random() * 400;
          this._env(g, t, 0.004, 0.12, 0.10 * vol);
          n.connect(lp).connect(g).connect(dest); n.start(t); n.stop(t + 0.15);
        } else if (this.planet === 'emer') {
          const n = this._noiseSource(this.noiseBuf);
          const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2800; bp.Q.value = 0.7;
          this._env(g, t, 0.003, 0.16, 0.07 * vol);
          n.connect(bp).connect(g).connect(dest); n.start(t); n.stop(t + 0.2);
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.08);
          const og = ctx.createGain(); this._env(og, t, 0.002, 0.08, 0.05 * vol);
          o.connect(og).connect(dest); o.start(t); o.stop(t + 0.1);
        } else {
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.2);
          const og = ctx.createGain(); this._env(og, t, 0.01, 0.22, 0.09 * vol);
          o.connect(og).connect(dest); o.start(t); o.stop(t + 0.3);
          const n = this._noiseSource(this.brownBuf);
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
          this._env(g, t, 0.01, 0.2, 0.05 * vol);
          n.connect(lp).connect(g).connect(dest); n.start(t); n.stop(t + 0.25);
        }
        break;
      }
      case 'jump': {
        const n = this._noiseSource(this.pinkBuf);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(400, t); lp.frequency.linearRampToValueAtTime(1600, t + 0.15);
        const g = ctx.createGain(); this._env(g, t, 0.01, 0.18, 0.08 * vol);
        n.connect(lp).connect(g).connect(dest); n.start(t); n.stop(t + 0.22);
        break;
      }
      case 'land': {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.3);
        const g = ctx.createGain(); this._env(g, t, 0.005, 0.3, 0.25 * vol);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 0.35);
        break;
      }
      case 'pickup': {
        const f = [880, 1320, 1760];
        f.forEach((fr, i) => {
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr;
          const g = ctx.createGain(); this._env(g, t + i * 0.07, 0.005, 0.25, 0.12 * vol);
          o.connect(g).connect(dest); o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.3);
        });
        break;
      }
      case 'scan': {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(440, t); o.frequency.exponentialRampToValueAtTime(1760, t + 0.9);
        const g = ctx.createGain(); this._env(g, t, 0.1, 0.8, 0.08 * vol);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 1.0);
        break;
      }
      case 'uiTick': {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 1480;
        const g = ctx.createGain(); this._env(g, t, 0.002, 0.05, 0.05 * vol);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 0.07);
        break;
      }
      case 'uiConfirm': {
        [660, 990].forEach((fr, i) => {
          const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = fr;
          const g = ctx.createGain(); this._env(g, t + i * 0.08, 0.004, 0.2, 0.07 * vol);
          o.connect(g).connect(dest); o.start(t + i * 0.08); o.stop(t + i * 0.08 + 0.25);
        });
        break;
      }
      case 'uiError': {
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 140;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
        const g = ctx.createGain(); this._env(g, t, 0.005, 0.2, 0.06 * vol);
        o.connect(lp).connect(g).connect(dest); o.start(t); o.stop(t + 0.25);
        break;
      }
      case 'build': {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(300, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.4);
        const g = ctx.createGain(); this._env(g, t, 0.01, 0.45, 0.12 * vol);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 0.5);
        const n = this._noiseSource(this.pinkBuf);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200;
        const ng = ctx.createGain(); this._env(ng, t + 0.2, 0.02, 0.35, 0.06 * vol);
        n.connect(bp).connect(ng).connect(dest); n.start(t); n.stop(t + 0.6);
        break;
      }
      case 'hurt': {
        const n = this._noiseSource(this.brownBuf);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
        const g = ctx.createGain(); this._env(g, t, 0.004, 0.3, 0.3 * vol);
        n.connect(lp).connect(g).connect(dest); n.start(t); n.stop(t + 0.35);
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.25);
        const og = ctx.createGain(); this._env(og, t, 0.003, 0.25, 0.2 * vol);
        o.connect(og).connect(dest); o.start(t); o.stop(t + 0.3);
        break;
      }
      case 'heavyLand': {
        // 着陆冲击
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
        const g = ctx.createGain(); this._env(g, t, 0.01, 1.5, 0.55 * vol);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 1.6);
        const n = this._noiseSource(this.brownBuf);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
        const ng = ctx.createGain(); this._env(ng, t, 0.02, 1.8, 0.4 * vol);
        n.connect(lp).connect(ng).connect(dest); n.start(t); n.stop(t + 1.9);
        break;
      }
      case 'door': {
        const n = this._noiseSource(this.brownBuf);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
        bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(180, t + 0.8);
        const g = ctx.createGain(); this._env(g, t, 0.05, 0.85, 0.18 * vol);
        n.connect(bp).connect(g).connect(dest); n.start(t); n.stop(t + 0.95);
        break;
      }
      case 'thruster': {
        // 点火：低频轰鸣 + 气流
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(40, t); o.frequency.linearRampToValueAtTime(72, t + 1.2);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(200, t); lp.frequency.linearRampToValueAtTime(900, t + 1.5);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.35 * vol, t + 0.8); g.gain.linearRampToValueAtTime(0.18 * vol, t + 3);
        o.connect(lp).connect(g).connect(dest); o.start(t); o.stop(t + 3.2);
        break;
      }
      case 'warp': {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(1200, t + 1.2);
        const g = ctx.createGain(); this._env(g, t, 0.4, 0.8, 0.16 * vol);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 1.3);
        break;
      }
      case 'chime': {
        const f = [523.25, 659.25, 783.99];
        f.forEach((fr, i) => {
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr;
          const g = ctx.createGain(); this._env(g, t + i * 0.12, 0.01, 1.6, 0.06 * vol);
          o.connect(g).connect(dest); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 1.8);
        });
        break;
      }
      default: break;
    }
  }

  // ---------------- 环境底噪 ----------------
  _startAmbience() {
    const ctx = this.ctx;
    const mkWind = () => {
      const n = this._noiseSource(this.brownBuf, true);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380; lp.Q.value = 0.6;
      const g = ctx.createGain(); g.gain.value = 0.0;
      // 缓慢阵风
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.25;
      lfo.connect(lfoG).connect(g.gain);
      n.connect(lp).connect(g).connect(this.ambBus);
      n.start(); lfo.start();
      return g;
    };
    const mkAir = () => {
      const n = this._noiseSource(this.pinkBuf, true);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
      const g = ctx.createGain(); g.gain.value = 0.0;
      n.connect(hp).connect(g).connect(this.ambBus);
      n.start();
      return g;
    };
    const mkCrickets = () => {
      const g = ctx.createGain(); g.gain.value = 0;
      g.connect(this.ambBus);
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 4200;
      const tremolo = ctx.createOscillator(); tremolo.type = 'sine'; tremolo.frequency.value = 11;
      const tg = ctx.createGain(); tg.gain.value = 0.5;
      const amp = ctx.createGain(); amp.gain.value = 0; // 由定时器控制
      this.cricketAmp = amp;
      tremolo.connect(tg).connect(amp.gain);
      o.connect(amp).connect(g);
      o.start(); tremolo.start();
      return g;
    };
    this.layers.wind = mkWind();
    this.layers.air = mkAir();
    this.layers.crickets = mkCrickets();
    this._cricketTimer = 0;
    // 引擎层（飞行时启用）
    const eo = ctx.createOscillator(); eo.type = 'sawtooth'; eo.frequency.value = 60;
    const elp = ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 300;
    const eg = ctx.createGain(); eg.gain.value = 0;
    eo.connect(elp).connect(eg).connect(this.master);
    eo.start();
    this.engineLayer = { o: eo, lp: elp, g: eg };
    this.setPlanet('verdant');
  }

  setPlanet(id) {
    this.planet = id;
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const target = {
      verdant: { wind: 0.10, air: 0.012 },
      emer: { wind: 0.16, air: 0.035 },
      lumina: { wind: 0.07, air: 0.006 },
    }[id] || { wind: 0.1, air: 0.01 };
    for (const k of ['wind', 'air']) {
      this.layers[k].gain.cancelScheduledValues(t);
      this.layers[k].gain.setTargetAtTime(target[k], t, 1.5);
    }
    this.layers.crickets.gain.setTargetAtTime(id === 'verdant' ? 0.02 : 0.0, t, 2);
  }

  setEngine(level, speed = 0) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.engineLayer.g.gain.setTargetAtTime(level * 0.22, t, 0.4);
    this.engineLayer.o.frequency.setTargetAtTime(52 + speed * 26, t, 0.4);
    this.engineLayer.lp.frequency.setTargetAtTime(200 + speed * 900, t, 0.4);
    this.layers.air.gain.setTargetAtTime(0.006 + speed * 0.06, t, 0.5);
  }

  // ---------------- 生成式氛围音乐 ----------------
  _startMusic() {
    this.chordIdx = 0;
    this.musicStep = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.6;
    const scales = [
      [0, 3, 7, 10, 12, 15, 19], // A 小调加九
      [-2, 2, 7, 9, 14, 16, 21],
      [-4, 0, 5, 9, 12, 16, 19],
    ];
    this.scales = scales;
  }

  updateMusic(dt, intensity = 0) {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const beat = 60 / this.bpm;
    if (ctx.currentTime < this.nextNoteTime) return;
    const t = this.nextNoteTime;
    this.musicStep++;
    const scale = this.scales[this.chordIdx % this.scales.length];
    // 和声铺底：每 8 拍换一次和弦
    if (this.musicStep % 8 === 1) {
      this._pad(t, scale, 8 * beat + 1.5);
      this.chordIdx++;
    }
    // 旋律：稀疏的琶音
    if (Math.random() < 0.55) {
      const semis = scale[Math.floor(Math.random() * scale.length)] + 24;
      const f = NOTE(semis);
      const o = ctx.createOscillator(); o.type = Math.random() < 0.5 ? 'sine' : 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.035, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      const dly = ctx.createDelay(1.0);
      dly.delayTime.value = beat * 0.75;
      const fb = ctx.createGain(); fb.gain.value = 0.35;
      o.connect(g).connect(this.musicBus);
      g.connect(dly); dly.connect(fb); fb.connect(dly); dly.connect(this.musicBus);
      o.start(t); o.stop(t + 1.6);
    }
    // 低频脉冲
    if (this.musicStep % 4 === 0) {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.value = NOTE(scale[0] - 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06 + intensity * 0.04, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 2.5);
      o.connect(g).connect(this.musicBus);
      o.start(t); o.stop(t + beat * 2.6);
    }
    this.nextNoteTime = t + beat * (this.musicStep % 2 === 0 ? 1 : 1.5);
  }

  _pad(t, scale, dur) {
    const ctx = this.ctx;
    const root = scale[0] + 12;
    for (let i = 0; i < 3; i++) {
      const semi = root + scale[i * 2];
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = NOTE(semi) * Math.pow(2, det / 1200);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.011, t + 1.4);
        g.gain.linearRampToValueAtTime(0.006, t + dur * 0.7);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(lp).connect(g).connect(this.musicBus);
        o.start(t); o.stop(t + dur + 0.1);
      }
    }
  }

  // 虫鸣随机
  updateAmbient(dt, timeOfDay) {
    if (!this.started) return;
    this._cricketTimer -= dt;
    if (this.planet === 'verdant' && this._cricketTimer <= 0) {
      this._cricketTimer = 1.5 + Math.random() * 3.5;
      const o = this.ctx.createOscillator();
      const f = 3400 + Math.random() * 1600;
      o.type = 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      const t = this.ctx.currentTime;
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < 3; i++) {
        g.gain.linearRampToValueAtTime(0.012, t + i * 0.09 + 0.01);
        g.gain.linearRampToValueAtTime(0.0, t + i * 0.09 + 0.06);
      }
      o.connect(g).connect(this.ambBus);
      o.start(t); o.stop(t + 0.35);
    }
  }

  setMusicVolume(v) { this.musicVol = v; if (this.musicBus) this.musicBus.gain.value = v; }
  setSfxVolume(v) { this.sfxVol = v; if (this.sfxBus) this.sfxBus.gain.value = v; }
}
