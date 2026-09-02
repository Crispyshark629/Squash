import { VisualConfig } from '../types';

class SlimeAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  
  // Continuous synthesizers for procedural backup
  private lowHumOsc: OscillatorNode | null = null;
  private lowHumGain: GainNode | null = null;
  private frictionNoiseFilter: BiquadFilterNode | null = null;
  private frictionNoiseGain: GainNode | null = null;

  // Custom uploaded Audio Buffers
  private customTouchBuffer: AudioBuffer | null = null;
  private customDragBuffer: AudioBuffer | null = null;
  private customReleaseBuffer: AudioBuffer | null = null;

  // Track the active looping source for drag friction
  private activeDragSource: AudioBufferSourceNode | null = null;
  private dragSourceGain: GainNode | null = null;

  private lastBubbleTime = 0;
  private lastWhipTime = 0;
  private currentDragSpeed = 0;
  private activeStiffness = 180;

  constructor() {}

  /**
   * Safe initialization of Web Audio synthesis nodes.
   * Triggered on user interaction to abide by browser security policies.
   */
  public init() {
    if (this.ctx) return;

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      this.ctx = new AudioContextClass();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.24, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      // Setup continuous low-frequency procedural drift carrier
      this.lowHumOsc = this.ctx.createOscillator();
      this.lowHumGain = this.ctx.createGain();

      this.lowHumOsc.type = 'triangle';
      this.lowHumOsc.frequency.setValueAtTime(45, this.ctx.currentTime);
      this.lowHumGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

      this.lowHumOsc.connect(this.lowHumGain);
      if (this.masterGain) {
        this.lowHumGain.connect(this.masterGain);
      }
      this.lowHumOsc.start();

      // Setup continuous sliding wet-friction procedural noise generator
      this.setupContinuousFrictionNoise();
    } catch (e) {
      console.warn('SlimeAudioEngine Web Audio Context init failure:', e);
    }
  }

  /**
   * Ensures AudioContext operates under active browser context.
   */
  public resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Continuous friction noise. It generates full spectrum white noise and runs it through
   * moist biquad filters to avoid crisp/sandy textures and maintain a gooey feel.
   */
  private setupContinuousFrictionNoise() {
    if (!this.ctx || !this.masterGain) return;

    try {
      const bufferSize = 4096;
      const processor = this.ctx.createScriptProcessor(bufferSize, 1, 1);

      processor.onaudioprocess = (e) => {
        const outputBuffer = e.outputBuffer;
        const channelData = outputBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          channelData[i] = Math.random() * 2.0 - 1.0;
        }
      };

      // Create a moist, liquid-like resonant bandpass filter
      this.frictionNoiseFilter = this.ctx.createBiquadFilter();
      this.frictionNoiseFilter.type = 'bandpass';
      this.frictionNoiseFilter.frequency.setValueAtTime(180, this.ctx.currentTime);
      this.frictionNoiseFilter.Q.setValueAtTime(6.0, this.ctx.currentTime);

      this.frictionNoiseGain = this.ctx.createGain();
      this.frictionNoiseGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

      processor.connect(this.frictionNoiseFilter);
      this.frictionNoiseFilter.connect(this.frictionNoiseGain);
      this.frictionNoiseGain.connect(this.masterGain);

      // Store source to prevent garbage collection
      (this as any)._noiseSourceNode = processor;
    } catch (err) {
      console.warn('Friction noise generator setup error:', err);
    }
  }

  /**
   * Helper to decode an raw uploaded arrayBuffer into an AudioBuffer.
   */
  public async decodeAudioFile(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    this.init();
    if (!this.ctx) {
      throw new Error('AudioContext could not be initialized.');
    }
    return await this.ctx.decodeAudioData(arrayBuffer);
  }

  /**
   * Assign custom uploaded audio buffers
   */
  public setCustomTouchBuffer(buffer: AudioBuffer | null) {
    this.customTouchBuffer = buffer;
  }

  public setCustomDragBuffer(buffer: AudioBuffer | null) {
    this.customDragBuffer = buffer;
    // Stop previous loop if we changed the setting
    this.stopCustomDragLoop();
  }

  public setCustomReleaseBuffer(buffer: AudioBuffer | null) {
    this.customReleaseBuffer = buffer;
  }

  /**
   * Get statuses to display in client UI
   */
  public hasCustomTouch() { return this.customTouchBuffer !== null; }
  public hasCustomDrag() { return this.customDragBuffer !== null; }
  public hasCustomRelease() { return this.customReleaseBuffer !== null; }

  /**
   * =========================================================================
   * 1. CORE TOUCH/CLICK SQUELCH (Instant tactile response on point-down)
   * =========================================================================
   */
  public triggerTouch(stiffness: number) {
    this.resume();
    if (!this.ctx || !this.masterGain || this.ctx.state === 'suspended') return;

    const t = this.ctx.currentTime;
    const kFactor = Math.min(1.0, Math.max(0.0, (stiffness - 5) / 445));
    // Audio pitch shifting randomizer (0.91x to 1.12x)
    const jitter = 0.91 + Math.random() * 0.21;

    // A. PLAY CUSTOM USER AUDIO BUFFER IF GIVEN
    if (this.customTouchBuffer) {
      try {
        const source = this.ctx.createBufferSource();
        source.buffer = this.customTouchBuffer;

        const gainNode = this.ctx.createGain();
        // Slightly softer buffer mix for cleanliness
        gainNode.gain.setValueAtTime(0.5, t);

        // Adjust play rate (pitch) based on physical stiffness + user motion jitter
        // Low stiffness = quicker, higher pitch; High stiffness = sluggish, lower pitch
        const pitchRate = (1.1 - kFactor * 0.3) * jitter;
        source.playbackRate.setValueAtTime(Math.max(0.2, pitchRate), t);

        // Filter out extreme high frequencies if stiffness is extremely high (muffled effect)
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(stiffness > 200 ? 800 : 8000, t);

        source.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(this.masterGain);

        source.start(t);
      } catch (err) {
        console.warn('Playing uploaded touch sound failed:', err);
      }
      return;
    }

    // B. FALLBACK TO ULTRA-SOFT DEEP PROCEDURAL MUDFLOW SQUELCH
    const touchBaseFreq = (130 * (1.1 - kFactor) + 40) * jitter;
    const touchEndFreq = (18 * (1.1 - kFactor) + 10) * jitter;
    const duration = (0.16 + kFactor * 0.12) * jitter;

    try {
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(touchBaseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(5, touchEndFreq), t + duration);

      oscGain.gain.setValueAtTime(0.0001, t);
      oscGain.gain.linearRampToValueAtTime(0.048 * (1.0 - kFactor * 0.4), t + 0.018);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

      osc.connect(oscGain);
      oscGain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + duration);

      // Low frequency air popping bubble
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(stiffness > 180 ? 120 : 250, t);
      const sub = this.ctx.createOscillator();
      const subG = this.ctx.createGain();

      sub.type = 'sine';
      sub.frequency.setValueAtTime(touchBaseFreq * 0.5, t);
      subG.gain.setValueAtTime(0.0001, t);
      subG.gain.linearRampToValueAtTime(0.035, t + 0.015);
      subG.gain.exponentialRampToValueAtTime(0.0001, t + duration);

      sub.connect(lp);
      lp.connect(subG);
      subG.connect(this.masterGain);
      sub.start(t);
      sub.stop(t + duration);
    } catch (err) {}
  }

  /**
   * =========================================================================
   * 2. CONTINUOUS KNEADING BUBBLES PROCEDURAL
   * =========================================================================
   */
  private playMuffledSquelch(stiffness: number) {
    if (!this.ctx || !this.masterGain || this.ctx.state === 'suspended') return;

    const t = this.ctx.currentTime;
    const kFactor = Math.min(1.0, Math.max(0.0, (stiffness - 5) / 445));
    const jitter = 0.88 + Math.random() * 0.24;

    const baseFreq = (100 + (1.0 - kFactor) * 70) * jitter;
    const endFreq = (16 + (1.0 - kFactor) * 8) * jitter;
    const decay = (0.1 + kFactor * 0.1) * jitter;

    try {
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(8, endFreq), t + decay);

      // Attack protection to avoid clicking clicks
      oscGain.gain.setValueAtTime(0.0001, t);
      oscGain.gain.linearRampToValueAtTime(0.038 * (1.0 - kFactor * 0.4), t + 0.02);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

      osc.connect(oscGain);
      oscGain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + decay);
    } catch (err) {}
  }

  /**
   * =========================================================================
   * 3. IN-AIR WHIP SWIPE PROCEDURAL
   * =========================================================================
   */
  private triggerWhipSwipe(speed: number, stiffness: number) {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;

    if (t - this.lastWhipTime < 0.4) return;
    this.lastWhipTime = t;

    const kFactor = Math.min(1.0, Math.max(0.0, (stiffness - 5) / 445));
    const jitter = 0.90 + Math.random() * 0.2;

    try {
      const whipNoiseOsc = this.ctx.createOscillator();
      const whipFilter = this.ctx.createBiquadFilter();
      const whipGain = this.ctx.createGain();

      whipFilter.type = 'bandpass';
      const startCutoff = (stiffness > 180 ? 220 : 500) * jitter;
      const endCutoff = (stiffness > 180 ? 400 : 900) * jitter;
      const duration = 0.24 * jitter;

      whipFilter.frequency.setValueAtTime(startCutoff, t);
      whipFilter.frequency.exponentialRampToValueAtTime(endCutoff, t + duration * 0.5);
      whipFilter.frequency.exponentialRampToValueAtTime(startCutoff * 0.3, t + duration);
      whipFilter.Q.setValueAtTime(3.0, t);

      whipNoiseOsc.type = 'sawtooth';
      whipNoiseOsc.frequency.setValueAtTime(80 * jitter, t);
      whipNoiseOsc.frequency.linearRampToValueAtTime(25, t + duration);

      whipGain.gain.setValueAtTime(0.0001, t);
      whipGain.gain.linearRampToValueAtTime(0.065 * Math.min(2.0, speed) * (1.1 - kFactor * 0.4), t + 0.05);
      whipGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

      whipNoiseOsc.connect(whipFilter);
      whipFilter.connect(whipGain);
      whipGain.connect(this.masterGain);

      whipNoiseOsc.start(t);
      whipNoiseOsc.stop(t + duration);
    } catch (e) {}
  }

  /**
   * =========================================================================
   * 4. MOUSE RELEASE / DETACH REBOUND (Suction vacuum snap on release)
   * =========================================================================
   */
  public triggerRelease(stiffness: number) {
    if (!this.ctx || !this.masterGain || this.ctx.state === 'suspended') return;

    const t = this.ctx.currentTime;
    const kFactor = Math.min(1.0, Math.max(0.0, (stiffness - 5) / 445));
    const jitter = 0.90 + Math.random() * 0.20;

    // A. PLAY CUSTOM USER REBOUND AUDIO FILE IF PROVIDED
    if (this.customReleaseBuffer) {
      try {
        const source = this.ctx.createBufferSource();
        source.buffer = this.customReleaseBuffer;

        const gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.48, t);

        // Map pitch rate based on stiffness: low stiffness = faster rebound; high stiffness = slow suction
        const pitchRate = (1.1 - kFactor * 0.35) * jitter;
        source.playbackRate.setValueAtTime(Math.max(0.2, pitchRate), t);

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(stiffness > 220 ? 600 : 6000, t);

        source.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(this.masterGain);

        source.start(t);
      } catch (err) {
        console.warn('Playing custom release sound failed:', err);
      }
      return;
    }

    // B. PROCEDURAL DEFAULT SUCTION POP
    const duration = (0.18 + kFactor * 0.15) * jitter;
    const releaseStartFreq = (40 + Math.random() * 10) * jitter;
    const releaseEndFreq = (150 + (1.0 - kFactor) * 100) * jitter;

    try {
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(releaseStartFreq, t);
      osc.frequency.exponentialRampToValueAtTime(releaseEndFreq, t + duration);

      const volumePeak = 0.05 * (1.0 - kFactor * 0.4);
      oscGain.gain.setValueAtTime(0.0001, t);
      oscGain.gain.linearRampToValueAtTime(volumePeak, t + duration * 0.3);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

      osc.connect(oscGain);
      oscGain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + duration);
    } catch (err) {}
  }

  /**
   * Helper to initiate or adjust loop for continuous custom dragging sound
   */
  private verifyCustomDragLoop(stiffness: number) {
    if (!this.ctx || !this.masterGain || !this.customDragBuffer) return;

    if (!this.activeDragSource) {
      try {
        const t = this.ctx.currentTime;
        this.activeDragSource = this.ctx.createBufferSource();
        this.activeDragSource.buffer = this.customDragBuffer;
        this.activeDragSource.loop = true;

        this.dragSourceGain = this.ctx.createGain();
        this.dragSourceGain.gain.setValueAtTime(0.0, t);

        this.activeDragSource.connect(this.dragSourceGain);
        this.dragSourceGain.connect(this.masterGain);

        this.activeDragSource.start(t);
      } catch (err) {
        console.warn('Failed to start looping custom drag source:', err);
      }
    }
  }

  /**
   * Safe termination of custom dragging sound loop
   */
  private stopCustomDragLoop() {
    if (this.activeDragSource) {
      try {
        this.activeDragSource.stop();
        this.activeDragSource.disconnect();
      } catch (err) {}
      this.activeDragSource = null;
    }
    this.dragSourceGain = null;
  }

  /**
   * Dynamic continuous mixer updates called inside ThreeStage.tsx render loop.
   * Maps live hand/pointer speed and stiffness parameters into mud friction/gurgling synthesizers.
   */
  public update(
    dragSpeed: number,
    stiffness: number,
    preset_placeholder_not_used?: string,
    enabled = true
  ) {
    if (!enabled) {
      this.muteContinuousGuides();
      return;
    }

    this.resume();
    if (!this.ctx || this.ctx.state === 'suspended') return;

    this.currentDragSpeed = dragSpeed;
    this.activeStiffness = stiffness;

    const t = this.ctx.currentTime;
    const isInteracting = dragSpeed > 0.04;

    const kFactor = Math.min(1.0, Math.max(0.0, (stiffness - 5) / 445));

    // Fast whipping effect
    if (isInteracting && dragSpeed > 1.8) {
      this.triggerWhipSwipe(dragSpeed, stiffness);
    }

    if (isInteracting) {
      // ----------------------------------------------------
      // CASE A: USER HAS UPLOADED A CUSTOM DRAGGING LOOP
      // ----------------------------------------------------
      if (this.customDragBuffer) {
        this.verifyCustomDragLoop(stiffness);

        if (this.dragSourceGain && this.activeDragSource) {
          // Dynamic volume maps to the movement velocity
          const targetVol = Math.min(0.65, dragSpeed * 0.42);
          
          // Dynamic Pitch (playbackRate) tracks physics speed and stiffness in real-time
          // - High speed = higher pitch/fast movement (shear tearing)
          // - High stiffness = heavy/dense rate lag
          const baseRate = 0.85 + dragSpeed * 0.12;
          const adjustedRate = baseRate * (1.1 - kFactor * 0.35);

          this.dragSourceGain.gain.setTargetAtTime(targetVol, t, 0.08);
          this.activeDragSource.playbackRate.setTargetAtTime(Math.max(0.15, adjustedRate), t, 0.12);
        }

        // Mute alternate procedural continuous channels to guarantee custom loops dominance
        if (this.lowHumGain) this.lowHumGain.gain.setTargetAtTime(0.0, t, 0.08);
        if (this.frictionNoiseGain) this.frictionNoiseGain.gain.setTargetAtTime(0.0, t, 0.08);
        return;
      }

      // Stop custom drag loop if user suddenly cleared it
      this.stopCustomDragLoop();

      // ----------------------------------------------------
      // CASE B: FALLBACK PROCEDURAL CONTINUOUS ADHESIVE FRICTION
      // ----------------------------------------------------
      // 1. Continuous viscous low hum modulation (Kneading weight humming)
      if (this.lowHumGain && this.lowHumOsc) {
        const targetHumFreq = 32 + (1.0 - kFactor) * 18 + Math.sin(t * 11) * 3;
        const targetHumVol = Math.min(0.045, dragSpeed * 0.03);

        this.lowHumOsc.frequency.setTargetAtTime(targetHumFreq, t, 0.09);
        this.lowHumGain.gain.setTargetAtTime(targetHumVol, t, 0.05);
      }

      // 2. Squelchy friction sliding noise modulation (Friction skin rubbing mud)
      if (this.frictionNoiseGain && this.frictionNoiseFilter) {
        const filterFreq = 120 + (1.0 - kFactor) * 240 + Math.sin(t * 15) * 30;
        const resonanceQ = 5.0 + (1.0 - kFactor) * 3.0;
        const volumeGain = 0.024 * (1.0 - kFactor * 0.45);

        this.frictionNoiseFilter.frequency.setTargetAtTime(Math.max(35, filterFreq), t, 0.12);
        this.frictionNoiseFilter.Q.setTargetAtTime(resonanceQ, t, 0.08);
        this.frictionNoiseGain.gain.setTargetAtTime(Math.min(volumeGain, dragSpeed * volumeGain * 0.75), t, 0.06);
      }

      // 3. Adaptive bubbler & pocket squelch grain scheduler
      const elapsed = t - this.lastBubbleTime;
      const adaptiveInterval = Math.max(0.07, 0.25 - Math.min(0.16, dragSpeed * 0.06));

      if (elapsed > adaptiveInterval) {
        if (Math.random() < 0.52 + Math.min(0.35, dragSpeed * 0.06)) {
          this.playMuffledSquelch(stiffness);
        }
        this.lastBubbleTime = t + (Math.random() * 0.025 - 0.0125);
      }
    } else {
      // Quiet down immediately upon zero pointer speeds
      this.muteContinuousGuides();
    }
  }

  /**
   * Gracefully fade out continuous hum/friction oscillators.
   */
  private muteContinuousGuides() {
    const t = this.ctx ? this.ctx.currentTime : 0;
    
    // Smoothly fade the custom drag buffer loop rather than stopping instantly, 
    // ensuring ultra-continuous realistic friction trails.
    if (this.dragSourceGain) {
      this.dragSourceGain.gain.setTargetAtTime(0.0, t, 0.12);
    }

    if (this.lowHumGain) {
      this.lowHumGain.gain.setTargetAtTime(0.0, t, 0.09);
    }
    if (this.frictionNoiseGain) {
      this.frictionNoiseGain.gain.setTargetAtTime(0.0, t, 0.09);
    }
  }
}

export const SlimeAudio = new SlimeAudioEngine();
