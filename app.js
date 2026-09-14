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

// Filtro de Rechazo Armónico
let lastValidPitch = null;
let harmonicJumpCount = 0;

// Filtro de Mediana para evitar picos de ruido (Jitter)
let pitchHistory = [];
const HIST_SIZE = 5;

// ---- New smoothing & stability constants ----
const EMA_ALPHA = 0.2;               // pitch EMA smoothing factor
const NEEDLE_JITTER_THRESHOLD = 1;   // cents change ignored
const MAX_NEEDLE_DELTA = 5;          // max degrees per frame
const STABLE_FRAME_COUNT = 4;        // frames needed to lock string
const TUNED_DEADZONE = 4;            // cents within which we consider tuned
const CONFIDENCE_THRESHOLD = 0.7;    // minimum confidence for auto‑detect

// EMA pitch accumulator
let emaPitch = null;
// Previous effective cents for jitter filtering
let prevEffectiveCents = 0;
// Counter for stable detection of a candidate string
let stableCount = 0;

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

// Variables para inercia física y LERP suave de aguja (reposo en -45°)
let currentRotation = -45;
let targetRotation = -45;

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
const tuneHelper = document.getElementById("tune-helper");
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
      console.log('Pantalla mantenida encendida (Wake Lock activo)');
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

// Autocorrelación YIN con Noise Gate RMS y Verificación de Subarmónicos (Octavas)
// Autocorrelación YIN limpia con Noise Gate RMS
function autoCorrelateYin(buf, sampleRate) {
  const size = buf.length;

  // Noise gate RMS: si el volumen es muy bajo, ignorar inmediatamente
  let rms = 0;
  for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.012) return -1;

  const threshold = 0.20;
  const maxLag = Math.floor(size / 2);
  const probability = new Float32Array(maxLag);
  let minTau = Math.floor(sampleRate / 450); // 450 Hz limite superior de guitarra
  let maxTau = Math.min(maxLag - 1, Math.floor(sampleRate / 60));  // 60 Hz limite inferior

  // Paso 1: Función de diferencia
  for (let tau = minTau; tau < maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < size - tau; i++) {
      const diff = buf[i] - buf[i + tau];
      sum += diff * diff;
    }
    probability[tau] = sum;
  }

  // Paso 2: Normalización por media acumulada
  let cumulative = 0;
  for (let tau = minTau; tau < maxTau; tau++) {
    cumulative += probability[tau];
    probability[tau] = probability[tau] * tau / (cumulative || 1);
  }

  // Paso 3: Umbral absoluto para encontrar el primer período fundamental
  let foundTau = -1;
  for (let tau = minTau; tau < maxTau; tau++) {
    if (probability[tau] < threshold) {
      foundTau = tau;
      break;
    }
  }

  if (foundTau === -1) return -1;

  // Paso 4: Interpolación parabólica para máxima precisión de frecuencia
  let betterTau = foundTau;
  if (foundTau > minTau && foundTau < maxTau - 1) {
    const x0 = probability[foundTau - 1];
    const x1 = probability[foundTau];
    const x2 = probability[foundTau + 1];
    const a = (x0 + x2 - 2 * x1) / 2;
    const b = (x2 - x0) / 2;
    if (a !== 0) betterTau = foundTau - b / (2 * a);
  }

  return sampleRate / betterTau;
}

// Adaptive RMS noise floor (percentile based)
const rmsHistory = [];
const RMS_HISTORY_MAX = 30; // ~1 second at 30 Hz
function getAdaptiveRmsThreshold(rms) {
  rmsHistory.push(rms);
  if (rmsHistory.length > RMS_HISTORY_MAX) rmsHistory.shift();
  const sorted = rmsHistory.slice().sort((a,b)=>a-b);
  const idx = Math.floor(sorted.length * 0.1); // 10th percentile
  return sorted[idx] * 1.5; // safety factor
}

// Confidence scoring based on recent pitch stability
const pitchStability = [];
const STABILITY_MAX = 5;
function getConfidence(pitch) {
  pitchStability.push(pitch);
  if (pitchStability.length > STABILITY_MAX) pitchStability.shift();
  if (pitchStability.length < STABILITY_MAX) return 0;
  const mean = pitchStability.reduce((a,b)=>a+b,0)/pitchStability.length;
  const variance = pitchStability.reduce((a,b)=>a+Math.pow(b-mean,2),0)/pitchStability.length;
  const stddev = Math.sqrt(variance);
  // Higher confidence when stddev is low (stable pitch)
  return Math.max(0, 1 - stddev / 20); // arbitrary scaling
}

// Bucle continuo de inercia física (velocidad máxima limitada a 2.5°/frame)
function animateNeedle() {
  // Spring‑damper (critically damped) model for smooth motion
  const dt = 1 / 60; // assuming 60fps
  const stiffness = 300; // higher => quicker response
  const damping = Math.sqrt(4 * stiffness); // critical damping
  const force = stiffness * (targetRotation - currentRotation);
  const acceleration = force - damping * 0; // velocity term omitted for critical damping simplification
  currentRotation += acceleration * dt * dt;
  // Clamp when close to target to avoid endless micro‑oscillations
  const diff = Math.abs(targetRotation - currentRotation);
  if (diff < 0.5) currentRotation = targetRotation;
  needle.style.transform = `translateX(-50%) rotate(${currentRotation.toFixed(2)}deg)`;
  requestAnimationFrame(animateNeedle);
}
requestAnimationFrame(animateNeedle);

function processPitch() {
  if (!isRunning) return;
  analyser.getFloatTimeDomainData(buffer);
  const rawPitch = autoCorrelateYin(buffer, audioCtx.sampleRate);

  if (rawPitch !== -1 && rawPitch >= 60 && rawPitch <= 450) {
    // Filtro de salto armónico
    if (lastValidPitch !== null) {
      const ratio = rawPitch / lastValidPitch;
      if ((ratio > 1.8 && ratio < 2.2) || (ratio > 0.45 && ratio < 0.55)) {
        harmonicJumpCount++;
        if (harmonicJumpCount < 4) {
          return requestAnimationFrame(processPitch);
        }
      }
    }
    harmonicJumpCount = 0;
    lastValidPitch = rawPitch;

    const pitch = getMedianPitch(rawPitch);
    freqDisplay.textContent = `${pitch.toFixed(1)} Hz`;
    const tuning = TUNINGS[currentTuningKey];

    let targetIdx = selectedStringIdx;

    if (targetIdx === null) {
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

    // Protección de Seguridad contra Saltos de Octava (Evita sobretensión de cuerdas)
    let effectivePitch = pitch;
    const ratio = pitch / targetFreq;
    if (ratio > 0.45 && ratio < 0.55) {
      effectivePitch = pitch * 2; // Subarmónico detectado (1 octava abajo)
    } else if (ratio > 1.8 && ratio < 2.2) {
      effectivePitch = pitch / 2; // Armónico detectado (1 octava arriba)
    }

    const cents = 1200 * Math.log2(effectivePitch / targetFreq);

    noteDisplay.textContent = target.n;
    centsDisplay.textContent = `${cents > 0 ? "+" : ""}${Math.round(cents)} cents`;

    // Guía visual (TENSAR vs DESTENSAR)
    const isTuned = Math.abs(cents) <= 4;
    if (tuneHelper) {
      if (isTuned) {
        tuneHelper.textContent = "PERFECTO ✓";
        tuneHelper.className = "tune-helper tuned";
      } else if (cents < -4) {
        tuneHelper.textContent = "⬆️ TENSAR CUERDA";
        tuneHelper.className = "tune-helper tighten";
      } else {
        tuneHelper.textContent = "⬇️ DESTENSAR CUERDA";
        tuneHelper.className = "tune-helper loosen";
      }
    }

    // Suavizado continuo de rotación de aguja (sin saltos bruscos)
    const clampedCents = Math.max(-50, Math.min(50, cents));
    const desiredRotation = (clampedCents / 50) * 45;
    targetRotation = targetRotation + 0.22 * (desiredRotation - targetRotation);

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
    // Silencio / Sin tono detectado: la aguja reposa suavemente a -45° (extremo izquierdo)
    lastValidPitch = null;
    pitchHistory = [];
    emaPitch = null;
    targetRotation = targetRotation + 0.15 * (-45 - targetRotation);
    switchCounter = 0;

    freqDisplay.textContent = "0.0 Hz";
    noteDisplay.textContent = "--";
    centsDisplay.textContent = "";
    if (tuneHelper) {
      tuneHelper.textContent = isRunning ? "Toca una cuerda..." : "Inicia el micrófono";
      tuneHelper.className = "tune-helper";
    }

    needle.classList.remove("tuned");
    noteDisplay.classList.remove("tuned");
    centsDisplay.classList.remove("tuned");
    if (gaugeBox) gaugeBox.classList.remove("tuned");
    if (gaugeArc) gaugeArc.classList.remove("tuned");
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
    analyser.fftSize = 4096; // Buffer de 4096 muestras (~90ms) para precisión en graves (E2, A2)
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

// One‑time microphone permission overlay handling
const overlay = document.getElementById('mic-overlay');
const overlayBtn = document.getElementById('overlay-start-btn');
if (localStorage.getItem('micPermissionAsked') === 'true') {
  overlay.style.display = 'none';
} else {
  overlay.style.display = 'flex';
}
overlayBtn.addEventListener('click', async () => {
  localStorage.setItem('micPermissionAsked', 'true');
  overlay.style.display = 'none';
  await startMicrophone();
});
// If user clicks the mic button directly and overlay is still visible, hide it
micBtn.addEventListener('click', () => {
  if (overlay.style.display !== 'none') {
    overlay.style.display = 'none';
    localStorage.setItem('micPermissionAsked', 'true');
  }
});