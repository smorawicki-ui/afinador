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
let deferredPrompt = null;
let wakeLock = null;

// Hysteresis & Estabilización de Cuerda Auto
let lockedStringIdx = null;
let candidateStringIdx = null;
let switchCounter = 0;

// Filtro de Mediana para evitar picos de ruido (Jitter/Saltos bruscos)
let pitchHistory = [];
const HIST_SIZE = 5;

function getMedianPitch(newPitch) {
  pitchHistory.push(newPitch);
  if (pitchHistory.length > HIST_SIZE) {
    pitchHistory.shift();
  }
  const sorted = [...pitchHistory].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Registro de cuerdas afinadas
let tunedStrings = [false, false, false, false, false, false];
let tunedTimer = null;
let currentTunedIdx = null;

// Variables para suavizado LERP de la aguja
let currentRotation = 0;
let targetRotation = 0;

// DOM Elements
const tuningSelect = document.getElementById("tuning-select");
const a4Slider = document.getElementById("a4-slider");
const a4Val = document.getElementById("a4-val");
const micBtn = document.getElementById("mic-btn");
const modeBtn = document.getElementById("mode-btn");
const installBtn = document.getElementById("install-btn");
const noteDisplay = document.getElementById("note-display");
const freqDisplay = document.getElementById("freq-display");
const centsDisplay = document.getElementById("cents-display");
const needle = document.getElementById("gauge-needle");
const gaugeBox = document.querySelector(".gauge-box");
const gaugeArc = document.querySelector(".gauge-arc");
const pegBtns = document.querySelectorAll(".peg-btn");
const progressCount = document.getElementById("progress-count");
const resetBtn = document.getElementById("reset-btn");

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

function updateTunedStringsUI() {
  const count = tunedStrings.filter(Boolean).length;
  if (progressCount) {
    if (count === 6) {
      progressCount.textContent = "🎉 ¡Guitarra Completa!";
    } else {
      progressCount.textContent = `${count} / 6 cuerdas`;
    }
  }

  pegBtns.forEach(btn => {
    const idx = parseInt(btn.dataset.string);
    btn.classList.toggle("is-tuned", !!tunedStrings[idx]);
  });
}

if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    tunedStrings = [false, false, false, false, false, false];
    updateTunedStringsUI();
  });
}

// Mantiene la pantalla encendida (Screen Wake Lock API)
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Pantalla del celular mantenida encendida (Wake Lock activo)');
    }
  } catch (err) {
    console.log('Wake Lock no disponible:', err);
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// Gestor de instalación PWA
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) {
    installBtn.style.display = "block";
  }
});

if (installBtn) {
  installBtn.addEventListener("click", async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        installBtn.style.display = "none";
      }
      deferredPrompt = null;
    }
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
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.25);

    if (navigator.vibrate) {
      navigator.vibrate(80);
    }
  } catch (e) {}
}

tuningSelect.addEventListener("change", (e) => {
  currentTuningKey = e.target.value;
  updatePegLabels();
  tunedStrings = [false, false, false, false, false, false];
  lockedStringIdx = null;
  updateTunedStringsUI();
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

// Autocorrelación con Noise Gate RMS y selección de pico fundamental
function autoCorrelate(buf, sampleRate) {
  let SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);

  // Noise Gate: Ignorar silencio y ruido ambiental tenue
  if (rms < 0.018) return -1;

  let c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) {
    for (let j = 0; j < SIZE - i; j++) {
      c[i] += buf[j] * buf[j + i];
    }
  }

  let d = 0;
  while (d < SIZE - 1 && c[d] > c[d + 1]) d++;

  const minLag = Math.floor(sampleRate / 450);
  const maxLag = Math.min(SIZE - 1, Math.ceil(sampleRate / 60));

  let maxval = -1;
  for (let i = Math.max(d, minLag); i <= maxLag; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
    }
  }

  if (maxval <= 0) return -1;

  // Seleccionar el PRIMER pico local que supere el 80% del máximo global
  let maxpos = -1;
  const threshold = maxval * 0.80;
  for (let i = Math.max(d, minLag); i <= maxLag; i++) {
    if (c[i] >= threshold && c[i] > c[i - 1] && c[i] >= c[i + 1]) {
      maxpos = i;
      break;
    }
  }

  if (maxpos === -1) return -1;

  // Interpolación parabólica sub-sample
  let T0 = maxpos;
  const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a !== 0) {
    T0 = T0 - b / (2 * a);
  }

  return sampleRate / T0;
}

// Bucle continuo de renderizado ultra suave (LERP + damping) para la aguja
function animateNeedle() {
  currentRotation += (targetRotation - currentRotation) * 0.12;
  needle.style.transform = `translateX(-50%) rotate(${currentRotation.toFixed(2)}deg)`;
  requestAnimationFrame(animateNeedle);
}
requestAnimationFrame(animateNeedle);

function processPitch() {
  if (!isRunning) return;
  analyser.getFloatTimeDomainData(buffer);
  const rawPitch = autoCorrelate(buffer, audioCtx.sampleRate);

  if (rawPitch !== -1 && rawPitch >= 60 && rawPitch <= 450) {
    const pitch = getMedianPitch(rawPitch);
    freqDisplay.textContent = `${pitch.toFixed(1)} Hz`;
    const tuning = TUNINGS[currentTuningKey];

    let targetIdx = selectedStringIdx;

    if (targetIdx === null) {
      // Auto-detect con Hysteresis para fijar la cuerda y evitar saltos
      let closestIdx = 0;
      let minDiff = Infinity;
      tuning.forEach((str, i) => {
        const tf = getTargetFreq(str.m);
        const diff = Math.abs(1200 * Math.log2(pitch / tf));
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      });

      if (lockedStringIdx === null) {
        lockedStringIdx = closestIdx;
      } else {
        const currentTf = getTargetFreq(tuning[lockedStringIdx].m);
        const currentDiff = Math.abs(1200 * Math.log2(pitch / currentTf));
        if (currentDiff < 160) {
          closestIdx = lockedStringIdx;
          switchCounter = 0;
        } else {
          if (candidateStringIdx === closestIdx) {
            switchCounter++;
            if (switchCounter >= 5) {
              lockedStringIdx = closestIdx;
              switchCounter = 0;
            } else {
              closestIdx = lockedStringIdx;
            }
          } else {
            candidateStringIdx = closestIdx;
            switchCounter = 1;
            closestIdx = lockedStringIdx;
          }
        }
      }
      targetIdx = closestIdx;
    }

    const target = tuning[targetIdx];
    const targetFreq = getTargetFreq(target.m);
    const cents = 1200 * Math.log2(pitch / targetFreq);

    noteDisplay.textContent = target.n;
    centsDisplay.textContent = `${cents > 0 ? "+" : ""}${Math.round(cents)} cents`;

    // Zona de amortiguación cerca del centro (Deadband stability ±4 cents)
    let effectiveCents = cents;
    if (Math.abs(cents) <= 4) {
      effectiveCents = cents * 0.35; // Calma la aguja en el centro perfecto
    }

    const clampedCents = Math.max(-50, Math.min(50, effectiveCents));
    targetRotation = (clampedCents / 50) * 45;

    const isTuned = Math.abs(cents) <= 4;
    needle.classList.toggle("tuned", isTuned);
    noteDisplay.classList.toggle("tuned", isTuned);
    centsDisplay.classList.toggle("tuned", isTuned);
    if (gaugeBox) gaugeBox.classList.toggle("tuned", isTuned);
    if (gaugeArc) gaugeArc.classList.toggle("tuned", isTuned);

    if (isTuned) {
      if (targetIdx !== null && targetIdx >= 0 && targetIdx < 6) {
        if (currentTunedIdx !== targetIdx) {
          currentTunedIdx = targetIdx;
          clearTimeout(tunedTimer);
          tunedTimer = setTimeout(() => {
            if (!tunedStrings[targetIdx]) {
              tunedStrings[targetIdx] = true;
              updateTunedStringsUI();
            }
          }, 350);
        }
      }
    } else {
      currentTunedIdx = null;
      clearTimeout(tunedTimer);
    }

    if (isTuned && !wasTuned) {
      playTunedChime();
    }
    wasTuned = isTuned;

    if (selectedStringIdx === null) {
      pegBtns.forEach((b, i) => b.classList.toggle("active", i === targetIdx));
    }
  } else {
    // Al haber silencio o decaimiento, retornar suavemente la aguja al centro sin saltos bruscos
    pitchHistory = [];
    targetRotation = targetRotation * 0.88;
    switchCounter = 0;
  }
  requestAnimationFrame(processPitch);
}

async function startMicrophone() {
  if (isRunning) return;

  const hasMediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasLegacyGetUserMedia = !!(navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);

  if (!hasMediaDevices && !hasLegacyGetUserMedia) {
    alert("Atención: Para usar el micrófono en el celular debes abrir la app desde un servidor con conexión HTTPS (como el enlace de GitHub Pages). En archivos locales por WhatsApp o HTTP no se permite acceso al micrófono.");
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
    micBtn.style.background = "#1a202c";
    micBtn.style.color = "#00e676";
    micBtn.style.boxShadow = "0 0 16px rgba(0, 230, 118, 0.4)";
    localStorage.setItem('micAutoStart', 'true');
    requestWakeLock();
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
  requestWakeLock();
});

// Registro del Service Worker para PWA Offline
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service Worker registrado con éxito:', reg.scope))
      .catch((err) => console.error('Error al registrar Service Worker:', err));
  });
}

updatePegLabels();
updateTunedStringsUI();