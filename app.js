const TUNINGS = {
  "Estándar": [ { n: "E2", m: 40 }, { n: "A2", m: 45 }, { n: "D3", m: 50 }, { n: "G3", m: 55 }, { n: "B3", m: 59 }, { n: "E4", m: 64 } ],
  "Drop D":   [ { n: "D2", m: 38 }, { n: "A2", m: 45 }, { n: "D3", m: 50 }, { n: "G3", m: 55 }, { n: "B3", m: 59 }, { n: "E4", m: 64 } ],
  "Drop C":   [ { n: "C2", m: 36 }, { n: "G2", m: 43 }, { n: "C3", m: 48 }, { n: "F3", m: 53 }, { n: "A3", m: 57 }, { n: "D4", m: 62 } ],
  "Eb":       [ { n: "Eb2", m: 39 }, { n: "Ab2", m: 44 }, { n: "Db3", m: 49 }, { n: "Gb3", m: 54 }, { n: "Bb3", m: 58 }, { n: "Eb4", m: 63 } ],
  "DADGAD":   [ { n: "D2", m: 38 }, { n: "A2", m: 45 }, { n: "D3", m: 50 }, { n: "G3", m: 55 }, { n: "A3", m: 57 }, { n: "D4", m: 62 } ],
  "Open D":   [ { n: "D2", m: 38 }, { n: "A2", m: 45 }, { n: "D3", m: 50 }, { n: "F#3", m: 54 }, { n: "A3", m: 57 }, { n: "D4", m: 62 } ],
  "Open G":   [ { n: "D2", m: 38 }, { n: "G2", m: 43 }, { n: "D3", m: 50 }, { n: "G3", m: 55 }, { n: "B3", m: 59 }, { n: "D4", m: 62 } ]
};

let a4 = 440;
let currentTuningKey = "Estándar";
let selectedStringIdx = null; // null = Auto mode
let audioCtx = null;
let analyser = null;
let buffer = null;
let isRunning = false;
let wasTuned = false;

// Variables para suavizado LERP de la aguja
let currentRotation = 0;
let targetRotation = 0;

// DOM Elements
const tuningSelect = document.getElementById("tuning-select");
const a4Slider = document.getElementById("a4-slider");
const a4Val = document.getElementById("a4-val");
const micBtn = document.getElementById("mic-btn");
const modeBtn = document.getElementById("mode-btn");
const noteDisplay = document.getElementById("note-display");
const freqDisplay = document.getElementById("freq-display");
const centsDisplay = document.getElementById("cents-display");
const needle = document.getElementById("gauge-needle");
const gaugeBox = document.querySelector(".gauge-box");
const gaugeArc = document.querySelector(".gauge-arc");
const pegBtns = document.querySelectorAll(".peg-btn");

function getTargetFreq(midiNote) {
  return a4 * Math.pow(2, (midiNote - 69) / 12);
}

function updatePegLabels() {
  const current = TUNINGS[currentTuningKey];
  pegBtns.forEach(btn => {
    const idx = parseInt(btn.dataset.string);
    btn.querySelector(".peg-note").textContent = current[idx].n;
  });
}

// Reproductor de tonos senoidales para afinar de oído
function playTone(freq) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

    const now = audioCtx.currentTime;
    const duration = 1.5;

    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start(now);
    osc.stop(now + duration);
  } catch (e) {
    console.error("Error reproduciendo tono:", e);
  }
}

// Señal sonora y háptica al alcanzar la afinación exacta
function playTunedChime() {
  try {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // Tono armónico cristalino A5 (880 Hz)
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.25);

    // Vibración háptica en celulares soportados
    if (navigator.vibrate) {
      navigator.vibrate(80);
    }
  } catch (e) {}
}

tuningSelect.addEventListener("change", (e) => {
  currentTuningKey = e.target.value;
  updatePegLabels();
});

a4Slider.addEventListener("input", (e) => {
  a4 = parseFloat(e.target.value);
  a4Val.textContent = a4;
});

pegBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const idx = parseInt(btn.dataset.string);
    const tuning = TUNINGS[currentTuningKey];

    if (tuning && tuning[idx]) {
      const noteFreq = getTargetFreq(tuning[idx].m);
      playTone(noteFreq);
    }

    if (selectedStringIdx === idx) {
      selectedStringIdx = null;
      modeBtn.textContent = "Modo: Auto";
      btn.classList.remove("active");
    } else {
      selectedStringIdx = idx;
      modeBtn.textContent = `Modo: Cuerda ${idx + 1}`;
      pegBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    }
  });
});

modeBtn.addEventListener("click", () => {
  selectedStringIdx = null;
  modeBtn.textContent = "Modo: Auto";
  pegBtns.forEach(b => b.classList.remove("active"));
});

// Autocorrelación para detección precisa de cuerda grave
function autoCorrelate(buf, sampleRate) {
  let SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // Silencio

  let r1 = 0, r2 = SIZE - 1, thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  }

  buf = buf.slice(r1, r2);
  SIZE = buf.length;

  let c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) {
    for (let j = 0; j < SIZE - i; j++) c[i] = c[i] + buf[j] * buf[j + i];
  }

  let d = 0;
  while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < SIZE; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  let T0 = maxpos;
  return sampleRate / T0;
}

// Bucle continuo de renderizado suave (LERP) para la aguja
function animateNeedle() {
  currentRotation += (targetRotation - currentRotation) * 0.15;
  needle.style.transform = `translateX(-50%) rotate(${currentRotation.toFixed(2)}deg)`;
  requestAnimationFrame(animateNeedle);
}
requestAnimationFrame(animateNeedle);

function processPitch() {
  if (!isRunning) return;
  analyser.getFloatTimeDomainData(buffer);
  const pitch = autoCorrelate(buffer, audioCtx.sampleRate);

  if (pitch !== -1 && pitch >= 60 && pitch <= 450) {
    freqDisplay.textContent = `${pitch.toFixed(1)} Hz`;
    const tuning = TUNINGS[currentTuningKey];

    let target = null;
    let targetIdx = selectedStringIdx;

    if (targetIdx !== null) {
      target = tuning[targetIdx];
    } else {
      // Auto-detect: busca la cuerda más cercana en semitonos
      let minDiff = Infinity;
      tuning.forEach((str, i) => {
        const tf = getTargetFreq(str.m);
        const diff = Math.abs(1200 * Math.log2(pitch / tf));
        if (diff < minDiff) {
          minDiff = diff;
          target = str;
          targetIdx = i;
        }
      });
    }

    const targetFreq = getTargetFreq(target.m);
    const cents = 1200 * Math.log2(pitch / targetFreq);

    // Actualizar nota e indicador de cents
    noteDisplay.textContent = target.n;
    centsDisplay.textContent = `${cents > 0 ? "+" : ""}${Math.round(cents)} cents`;

    const clampedCents = Math.max(-50, Math.min(50, cents));
    targetRotation = (clampedCents / 50) * 45; // -45 a +45 grados

    const isTuned = Math.abs(cents) <= 3;
    needle.classList.toggle("tuned", isTuned);
    noteDisplay.classList.toggle("tuned", isTuned);
    centsDisplay.classList.toggle("tuned", isTuned);
    if (gaugeBox) gaugeBox.classList.toggle("tuned", isTuned);
    if (gaugeArc) gaugeArc.classList.toggle("tuned", isTuned);

    // Disparar señal sonora y háptica de afinación al entrar en afinación correcta
    if (isTuned && !wasTuned) {
      playTunedChime();
    }
    wasTuned = isTuned;

    if (selectedStringIdx === null) {
      pegBtns.forEach((b, i) => b.classList.toggle("active", i === targetIdx));
    }
  }
  requestAnimationFrame(processPitch);
}

async function startMicrophone() {
  if (isRunning) return;

  const hasMediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasLegacyGetUserMedia = !!(navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);

  if (!hasMediaDevices && !hasLegacyGetUserMedia) {
    alert("Atención: Tu navegador requiere abrir esta página con conexión HTTPS (o enlace de servidor) para activar el micrófono.");
    return;
  }

  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    let stream;
    if (hasMediaDevices) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
      } catch (e) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } else {
      const getUserMediaLegacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
      stream = await new Promise((resolve, reject) => getUserMediaLegacy.call(navigator, { audio: true }, resolve, reject));
    }

    const source = audioCtx.createMediaStreamSource(stream);

    const lowpassFilter = audioCtx.createBiquadFilter();
    lowpassFilter.type = "lowpass";
    lowpassFilter.frequency.setValueAtTime(800, audioCtx.currentTime);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    buffer = new Float32Array(analyser.fftSize);

    source.connect(lowpassFilter);
    lowpassFilter.connect(analyser);

    isRunning = true;
    micBtn.textContent = "Escuchando...";
    micBtn.style.background = "#555";
    localStorage.setItem('micAutoStart', 'true');
    processPitch();
  } catch (err) {
    console.error("Error micrófono:", err);
    alert("Error al solicitar acceso al micrófono: " + (err.message || err.name || "Permiso denegado"));
  }
}

micBtn.addEventListener("click", startMicrophone);

// Auto-iniciar micrófono al interactuar con cualquier parte de la pantalla si ya fue concedido previamente
document.body.addEventListener("pointerdown", () => {
  if (!isRunning && localStorage.getItem('micAutoStart') === 'true') {
    startMicrophone();
  }
});

// Registro del Service Worker para PWA Offline
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service Worker v2 registrado con éxito:', reg.scope))
      .catch((err) => console.error('Error al registrar Service Worker:', err));
  });
}

updatePegLabels();