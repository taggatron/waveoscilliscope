// Basic audio + visualization engine for the guitar lab

let audioCtx;
let mainGain;
let oscilloscopeAnalyser;
let guitarOutput;
let distortion;
let micStream;
let micSource;

// Sample-based guitar
let baseSampleBuffer = null;
// 2nd fret low E string (F#2 ≈ 92.50 Hz)
const BASE_SAMPLE_FREQ = 92.5;
const MAX_SAMPLE_WINDOW = 0.8; // seconds from start of clip to use

const NUM_STRINGS = 6;
const NUM_FRETS = 16; // 0-15

// Standard tuning E2 A2 D3 G3 B3 E4 in Hz
const STRING_BASE_FREQS = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];

// Store active notes keyed by id
const activeVoices = new Map();

// Blues scale mode (A minor pentatonic over standard tuning)
let bluesMode = false;
// Semitone offsets within the minor pentatonic: 1, b3, 4, 5, b7
const MINOR_PENT_INTERVALS = [0, 3, 5, 7, 10];

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    mainGain = audioCtx.createGain();
    mainGain.gain.value = 0.3;

    distortion = audioCtx.createWaveShaper();
    distortion.curve = makeDistortionCurve(350);
    distortion.oversample = "4x";

    oscilloscopeAnalyser = audioCtx.createAnalyser();
    oscilloscopeAnalyser.fftSize = 2048;

    mainGain.connect(distortion);
    distortion.connect(oscilloscopeAnalyser);
    oscilloscopeAnalyser.connect(audioCtx.destination);

    startScopeDraw();
  }
}

async function ensureSampleLoaded() {
  ensureAudio();
  if (baseSampleBuffer) return baseSampleBuffer;
  const response = await fetch("son-10-83794.mp3");
  const arrayBuffer = await response.arrayBuffer();
  baseSampleBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  return baseSampleBuffer;
}

function makeDistortionCurve(amount) {
  const nSamples = 44100;
  const curve = new Float32Array(nSamples);
  const deg = Math.PI / 180;
  for (let i = 0; i < nSamples; ++i) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

async function createVoice(stringIndex, fret, id) {
  await ensureSampleLoaded();
  const base = STRING_BASE_FREQS[stringIndex];
  const freq = base * Math.pow(2, fret / 12);
  const playbackRate = freq / BASE_SAMPLE_FREQ;

  const src = audioCtx.createBufferSource();
  src.buffer = baseSampleBuffer;
  // Only use the first MAX_SAMPLE_WINDOW seconds of the clip
  src.loop = false;
  src.playbackRate.value = playbackRate;

  // Mild cab / tone shaping to sit well with distortion
  const cabLowpass = audioCtx.createBiquadFilter();
  cabLowpass.type = "lowpass";
  cabLowpass.frequency.value = 6000;
  cabLowpass.Q.value = 0.8;

  const midBoost = audioCtx.createBiquadFilter();
  midBoost.type = "peaking";
  midBoost.frequency.value = 900;
  midBoost.Q.value = 1.0;
  midBoost.gain.value = 3.5;

  const gain = audioCtx.createGain();

  const now = audioCtx.currentTime;

  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.95, now + 0.008); // fast attack
  gain.gain.linearRampToValueAtTime(0.8, now + 0.12); // quick rise to sustain
  // Hold sustain level; release is scheduled in stopVoice and
  // the underlying sample plays through its first 0.8s only.

  src.connect(cabLowpass);
  cabLowpass.connect(midBoost).connect(gain);
  gain.connect(mainGain);

  // Start playback from the beginning of the clip; we only
  // rely on the first MAX_SAMPLE_WINDOW seconds of audio.
  src.start(0, 0);

  const voice = {
    src,
    cabLowpass,
    midBoost,
    gain,
    baseFreq: freq,
    id,
    playbackRate,
    stringIndex,
    fret,
  };
  activeVoices.set(id, voice);
  return voice;
}

function stopVoice(id) {
  const voice = activeVoices.get(id);
  if (!voice) return;
  const now = audioCtx.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  const current = voice.gain.gain.value;
  voice.gain.gain.setValueAtTime(current, now);
  voice.gain.gain.linearRampToValueAtTime(0, now + 0.22); // slightly longer release
  if (voice.src) voice.src.stop(now + 0.25);
  activeVoices.delete(id);
}

function updateVoicePitch(id, semitoneOffset) {
  const voice = activeVoices.get(id);
  if (!voice) return;
  const baseFreq = STRING_BASE_FREQS[voice.stringIndex];
  let effectiveSemis = voice.fret + semitoneOffset;

  if (bluesMode) {
    // In blues mode, glide towards the nearest minor-pentatonic degree
    // so continuous slides naturally fall onto the next scale tone.
    const STRING_OFFSETS = [-5, 0, 5, 10, 14, 19];
    const semisFromA = STRING_OFFSETS[voice.stringIndex] + effectiveSemis;
    const mod = ((semisFromA % 12) + 12) % 12;

    let best = MINOR_PENT_INTERVALS[0];
    let bestDist = Math.abs(mod - best);
    for (let i = 1; i < MINOR_PENT_INTERVALS.length; i++) {
      const cand = MINOR_PENT_INTERVALS[i];
      const dist = Math.abs(mod - cand);
      if (dist < bestDist) {
        best = cand;
        bestDist = dist;
      }
    }

    const snapOffset = best - mod;
    let snappedSemisFromA = semisFromA + snapOffset;

    // Keep motion reasonably close to the physical position while sliding
    if (snappedSemisFromA - semisFromA > 2) snappedSemisFromA -= 12;
    if (snappedSemisFromA - semisFromA < -2) snappedSemisFromA += 12;

    effectiveSemis = snappedSemisFromA - STRING_OFFSETS[voice.stringIndex];
  }

  const newFreq = baseFreq * Math.pow(2, effectiveSemis / 12);
  const newRate = newFreq / BASE_SAMPLE_FREQ;

  if (voice.src) {
    voice.src.playbackRate.setTargetAtTime(newRate, audioCtx.currentTime, 0.03);
  }

  voice.baseFreq = newFreq;
  voice.playbackRate = newRate;
}

// Fretboard rendering and interaction

function buildFretboard() {
  const fretboardEl = document.getElementById("fretboard");
  fretboardEl.innerHTML = "";

  for (let s = 0; s < NUM_STRINGS; s++) {
    const y = ((s + 1) / (NUM_STRINGS + 1)) * 100;
    const stringEl = document.createElement("div");
    stringEl.className = "string-row";
    stringEl.style.top = `${y}%`;
    stringEl.dataset.string = s;

    const core = document.createElement("div");
    core.className = "string-core";

    const highlight = document.createElement("div");
    highlight.className = "string-highlight";

    const baseHue = 240 - s * 20;
    core.style.background = `linear-gradient(90deg, hsla(${baseHue}, 85%, 72%, 0.15), hsla(${baseHue}, 95%, 85%, 0.9), hsla(${baseHue}, 85%, 72%, 0.15))`;
    highlight.style.background = `radial-gradient(circle at 50% 50%, hsla(${baseHue}, 100%, 80%, 0.75), hsla(${baseHue}, 100%, 55%, 0.0))`;

    stringEl.appendChild(core);
    stringEl.appendChild(highlight);
    fretboardEl.appendChild(stringEl);
  }

  for (let f = 1; f <= NUM_FRETS; f++) {
    const x = (f / (NUM_FRETS + 1)) * 100;
    const fretLine = document.createElement("div");
    fretLine.className = "fret-line";
    fretLine.style.left = `${x}%`;
    fretboardEl.appendChild(fretLine);

    if ([3, 5, 7, 9, 12, 15].includes(f)) {
      const label = document.createElement("div");
      label.className = "fret-label";
      label.style.left = `${x}%`;
      label.textContent = f;
      fretboardEl.appendChild(label);
    }
  }

  const rect = fretboardEl.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  function posToFret(x) {
    const pct = x / width;
    let fret = Math.round(pct * (NUM_FRETS + 1));
    if (fret < 0) fret = 0;
    if (fret > NUM_FRETS) fret = NUM_FRETS;
    return fret;
  }

  for (let s = 0; s < NUM_STRINGS; s++) {
    for (let f = 0; f <= NUM_FRETS; f++) {
      const hotspot = document.createElement("div");
      hotspot.className = "note-hotspot";
      const xPct = ((f + 0.5) / (NUM_FRETS + 1)) * 100;
      const yPct = ((s + 1) / (NUM_STRINGS + 1)) * 100;
      hotspot.style.left = `${xPct}%`;
      hotspot.style.top = `${yPct}%`;

      const glow = document.createElement("div");
      glow.className = "note-glow";
      hotspot.appendChild(glow);
      const baseHue = 240 - s * 20 + f * 4;
      glow.style.background = `radial-gradient(circle, hsla(${baseHue}, 90%, 75%, 0.0), hsla(${baseHue}, 95%, 70%, 0.7))`;

      const id = `s${s}f${f}`;
      hotspot.dataset.id = id;
      hotspot.dataset.string = s;
      hotspot.dataset.fret = f;

      const snapped = getBluesSnapOffset(s, f);
      hotspot.dataset.snap = String(snapped);

      attachPointerHandlers(hotspot, s, f, id, posToFret);

      fretboardEl.appendChild(hotspot);
    }
  }
}

function getBluesSnapOffset(stringIndex, fret) {
  // Map each string to its open-string note in semitones relative to A2 = 0
  // E2: -5, A2: 0, D3: 5, G3: 10, B3: 14, E4: 19
  const STRING_OFFSETS = [-5, 0, 5, 10, 14, 19];
  const semisFromA = STRING_OFFSETS[stringIndex] + fret;
  const mod = ((semisFromA % 12) + 12) % 12;

  if (!bluesMode) return 0;

  // Find nearest minor-pentatonic interval in semitones
  let best = MINOR_PENT_INTERVALS[0];
  let bestDist = Math.abs(mod - best);
  for (let i = 1; i < MINOR_PENT_INTERVALS.length; i++) {
    const cand = MINOR_PENT_INTERVALS[i];
    const dist = Math.abs(mod - cand);
    if (dist < bestDist) {
      best = cand;
      bestDist = dist;
    }
  }

  // Snap offset (in semitones) from the physical fret pitch
  let offset = best - mod;
  // Keep offsets small (e.g. within ±2 semitones) for adjacent frets
  if (offset > 2) offset -= 12;
  if (offset < -2) offset += 12;
  return offset;
}

function attachPointerHandlers(el, stringIndex, fret, id, posToFret) {
  let tracking = false;
  let startX = 0;
  let startY = 0;

  const onDown = (ev) => {
    ev.preventDefault();
    const point = getPoint(ev);
    tracking = true;
    startX = point.x;
    startY = point.y;
    el.classList.add("active");

    const baseSnap = Number(el.dataset.snap || "0");
    const snappedFret = fret;
    const semitoneOffset = bluesMode ? baseSnap : 0;

    // createVoice always starts at the physical fret pitch; immediately bend
    // to the snapped blues pitch if blues mode is on.
    createVoice(stringIndex, snappedFret, id).then(() => {
      if (bluesMode && baseSnap !== 0) {
        updateVoicePitch(id, baseSnap);
      }
    });
  };

  const onMove = (ev) => {
    if (!tracking) return;
    ev.preventDefault();
    const point = getPoint(ev);
    const dx = point.x - startX;
    const dy = point.y - startY;

    const fretOffset = posToFret(point.relX) - fret;
    const bendSemis = -dy / 40;
    const baseSnap = Number(el.dataset.snap || "0");
    const semis = baseSnap + fretOffset + bendSemis;

    updateVoicePitch(id, semis);

    const intensity = Math.min(1.5, Math.sqrt(dx * dx + dy * dy) / 40);
    const glow = el.querySelector(".note-glow");
    glow.style.transform = `scale(${1 + intensity * 0.6})`;
    glow.style.boxShadow = `0 0 ${18 + intensity * 26}px rgba(255,255,255,${0.25 + intensity * 0.35})`;

    const fretboardEl = document.getElementById("fretboard");
    const rect = fretboardEl.getBoundingClientRect();
    const centerY = rect.top + ((stringIndex + 1) / (NUM_STRINGS + 1)) * rect.height;
    const offsetY = point.y - centerY;
    const bendAmount = Math.max(-22, Math.min(22, offsetY));

    const stringRow = fretboardEl.querySelector(`.string-row[data-string="${stringIndex}"]`);
    if (stringRow) {
      stringRow.classList.add("bending");
      stringRow.style.transform = `translateY(${bendAmount * 0.15}px)`;
    }
  };

  const onUp = (ev) => {
    if (!tracking) return;
    tracking = false;
    ev.preventDefault();
    el.classList.remove("active");
    const glow = el.querySelector(".note-glow");
    glow.style.transform = "scale(1)";
    glow.style.boxShadow = "none";

    const fretboardEl = document.getElementById("fretboard");
    const stringRow = fretboardEl.querySelector(`.string-row[data-string="${stringIndex}"]`);
    if (stringRow) {
      stringRow.classList.remove("bending");
      stringRow.style.transform = "translateY(0px)";
    }
    stopVoice(id);
  };

  el.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function getPoint(ev) {
  const isTouchLike = ev.touches && ev.touches[0];
  const clientX = isTouchLike ? ev.touches[0].clientX : ev.clientX;
  const clientY = isTouchLike ? ev.touches[0].clientY : ev.clientY;
  const fretboardEl = document.getElementById("fretboard");
  const rect = fretboardEl.getBoundingClientRect();
  return {
    x: clientX,
    y: clientY,
    relX: clientX - rect.left,
    relY: clientY - rect.top,
  };
}

// Oscilloscope from mic (and guitar output)

const scopeCanvas = document.getElementById("oscilloscope");
const scopeCtx = scopeCanvas.getContext("2d");
let scopeRunning = false;

function startScopeDraw() {
  if (scopeRunning) return;
  scopeRunning = true;
  const buffer = new Uint8Array(oscilloscopeAnalyser.frequencyBinCount);

  function draw() {
    if (!scopeRunning) return;
    requestAnimationFrame(draw);
    oscilloscopeAnalyser.getByteTimeDomainData(buffer);

    const w = scopeCanvas.width;
    const h = scopeCanvas.height;

    scopeCtx.clearRect(0, 0, w, h);

    const grd = scopeCtx.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, "rgba(67,233,255,0.6)");
    grd.addColorStop(0.5, "rgba(255,250,90,0.8)");
    grd.addColorStop(1, "rgba(255,90,241,0.6)");

    scopeCtx.lineWidth = 2;
    scopeCtx.strokeStyle = grd;
    scopeCtx.beginPath();

    const slice = w / buffer.length;
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i] / 128.0;
      const y = (v * h) / 2;
      const x = i * slice;
      if (i === 0) scopeCtx.moveTo(x, y);
      else scopeCtx.lineTo(x, y);
    }
    scopeCtx.stroke();
  }

  draw();
}

async function toggleMic() {
  ensureAudio();
  const button = document.getElementById("micToggle");

  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(oscilloscopeAnalyser);
      button.classList.add("active");
      button.textContent = "Mic On";
    } catch (err) {
      console.error("Mic error", err);
      alert("Could not access microphone. Check browser permissions.");
    }
  } else {
    micSource.disconnect();
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    micSource = null;
    button.classList.remove("active");
    button.textContent = "Enable Mic";
  }
}

function init() {
  buildFretboard();
  const btn = document.getElementById("micToggle");
  btn.addEventListener("click", toggleMic);

   const bluesBtn = document.getElementById("bluesToggle");
   const modeName = document.getElementById("modeName");
   bluesBtn.addEventListener("click", () => {
     bluesMode = !bluesMode;
     bluesBtn.classList.toggle("active", bluesMode);
     modeName.textContent = bluesMode ? "Blues (A minor pentatonic)" : "Full fretboard";

     // Rebuild fretboard so blues markers / allowed notes update
     buildFretboard();
   });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
