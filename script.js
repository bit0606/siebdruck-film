"use strict";

const $ = (selector) => document.querySelector(selector);

const CM_PER_INCH = 2.54;
const PREVIEW_SIZE_PX = 1000;
const LARGE_EXPORT_PX = 9000;

const FORMATS = {
  A6: [10.5, 14.8],
  A5: [14.8, 21],
  A4: [21, 29.7],
  A3: [29.7, 42],
  pocket: [10, 10],
  chest: [25, 25],
  back: [30, 40],
};

const MODE_HINTS = {
  threshold: "Klare, vollflächige Linien. Der Schwellwert wird automatisch ermittelt.",
  halftone: "Weiche Übergänge werden in ein Punktraster zerlegt. Empfohlen: 50 LPI, 22,5°.",
};

const state = {
  image: null,
  naturalWidth: 0,
  naturalHeight: 0,
  unit: "cm",
  width: 20,
  dpi: 600,
  format: "A4",
  sheet: null,
  mode: "threshold",
  threshold: 128,
  lpi: 50,
  angle: 22.5,
  contrast: 0,
  invert: false,
  fabric: "#ffffff",
  ink: "#000000",
  inkChangedByUser: false,
  mirror: false,
  marks: true,
  transparent: false,
  view: "film",
};

const round2 = (n) => Math.round(n * 100) / 100;
const formatNumber = (n) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

function toCm(value) {
  if (state.unit === "mm") return value / 10;
  if (state.unit === "in") return value * CM_PER_INCH;
  return value;
}

function fromCm(cm) {
  if (state.unit === "mm") return cm * 10;
  if (state.unit === "in") return cm / CM_PER_INCH;
  return cm;
}

const designWidthCm = () => toCm(state.width);
const designHeightCm = () =>
  state.naturalHeight ? (designWidthCm() * state.naturalHeight) / state.naturalWidth : 0;

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function contrastInk(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return luminance(r, g, b) > 140 ? "#000000" : "#ffffff";
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getLayout() {
  const designW = designWidthCm();
  const designH = designHeightCm();

  if (state.sheet) {
    const [sheetW, sheetH] = state.sheet;
    return {
      pageW: sheetW,
      pageH: sheetH,
      designW,
      designH,
      offsetX: (sheetW - designW) / 2,
      offsetY: (sheetH - designH) / 2,
    };
  }

  const margin = state.marks ? 1.2 : 0;
  return {
    pageW: designW + 2 * margin,
    pageH: designH + 2 * margin,
    designW,
    designH,
    offsetX: margin,
    offsetY: margin,
  };
}

function computeOtsuThreshold() {
  if (!state.image) return 128;

  const sampleSize = 220;
  const ratio = state.naturalWidth / state.naturalHeight;
  const w = ratio >= 1 ? sampleSize : Math.max(1, Math.round(sampleSize * ratio));
  const h = ratio >= 1 ? Math.max(1, Math.round(sampleSize / ratio)) : sampleSize;

  const ctx = createCanvas(w, h).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(state.image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const histogram = new Array(256).fill(0);
  let total = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.5) continue;
    const lum = luminance(data[i], data[i + 1], data[i + 2]) * alpha + 255 * (1 - alpha);
    histogram[Math.round(lum)]++;
    total++;
  }

  if (!total) return 128;

  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * histogram[t];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let best = 128;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (!weightBackground) continue;

    const weightForeground = total - weightBackground;
    if (weightForeground <= 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > maxVariance) {
      maxVariance = variance;
      best = t;
    }
  }

  return best;
}

function buildInkMask(targetW, targetH, effectiveDpi) {
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round(targetH));

  const sourceCtx = createCanvas(w, h).getContext("2d", { willReadFrequently: true });
  sourceCtx.imageSmoothingEnabled = true;
  sourceCtx.imageSmoothingQuality = "high";
  if (state.mirror) {
    sourceCtx.translate(w, 0);
    sourceCtx.scale(-1, 1);
  }
  sourceCtx.drawImage(state.image, 0, 0, w, h);
  const pixels = sourceCtx.getImageData(0, 0, w, h).data;

  const lumAt = (x, y) => {
    const cx = Math.min(w - 1, Math.max(0, x | 0));
    const cy = Math.min(h - 1, Math.max(0, y | 0));
    const i = (cy * w + cx) * 4;
    const alpha = pixels[i + 3] / 255;
    return luminance(pixels[i], pixels[i + 1], pixels[i + 2]) * alpha + 255 * (1 - alpha);
  };

  const mask = createCanvas(w, h);
  const ctx = mask.getContext("2d");

  if (state.mode === "threshold") {
    const output = ctx.createImageData(w, h);
    const out = output.data;

    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const isInk = (lumAt(x, y) < state.threshold) !== state.invert;
        out[i + 3] = isInk ? 255 : 0;
      }
    }

    ctx.putImageData(output, 0, 0);
    return mask;
  }

  const cell = Math.max(2, effectiveDpi / state.lpi);
  const angle = (state.angle * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = w / 2;
  const centerY = h / 2;
  const reach = Math.ceil(Math.hypot(w, h)) + cell;
  const contrastFactor = 1 + state.contrast / 100;

  ctx.fillStyle = "#000";

  for (let v = -reach; v < reach; v += cell) {
    for (let u = -reach; u < reach; u += cell) {
      const x = centerX + u * cos - v * sin;
      const y = centerY + u * sin + v * cos;
      if (x < -cell || x > w + cell || y < -cell || y > h + cell) continue;

      const lightness = lumAt(x, y) / 255;
      let darkness = state.invert ? lightness : 1 - lightness;
      darkness = Math.min(1, Math.max(0, (darkness - 0.5) * contrastFactor + 0.5));
      if (darkness <= 0.01) continue;

      const radius = (cell / 2) * Math.sqrt(darkness) * 1.18;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return mask;
}

function fillMask(mask, color) {
  const canvas = createCanvas(mask.width, mask.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  return canvas;
}

function drawRegistrationMarks(ctx, x, y, w, h, pxPerCm) {
  const size = 0.6 * pxPerCm;
  const gap = size * 0.15;

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = Math.max(1, 0.08 * pxPerCm);

  const corners = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ];

  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * gap);
    ctx.lineTo(cx, cy + dy * size);
    ctx.moveTo(cx + dx * gap, cy);
    ctx.lineTo(cx + dx * size, cy);
    ctx.stroke();
  }

  const radius = size * 0.5;
  const targetX = x + w / 2;
  const targetY = y - size * 0.7;

  if (targetY - radius > 0) {
    ctx.beginPath();
    ctx.arc(targetX, targetY, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(targetX - radius * 1.6, targetY);
    ctx.lineTo(targetX + radius * 1.6, targetY);
    ctx.moveTo(targetX, targetY - radius * 1.6);
    ctx.lineTo(targetX, targetY + radius * 1.6);
    ctx.stroke();
  }

  ctx.restore();
}

function renderTo(canvas, pxPerCm, { asFilm, forExport }) {
  const layout = getLayout();
  canvas.width = Math.max(1, Math.round(layout.pageW * pxPerCm));
  canvas.height = Math.max(1, Math.round(layout.pageH * pxPerCm));

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const keepTransparent = asFilm && forExport && state.transparent;
  if (!keepTransparent) {
    ctx.fillStyle = asFilm ? "#ffffff" : state.fabric;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const mask = buildInkMask(
    layout.designW * pxPerCm,
    layout.designH * pxPerCm,
    pxPerCm * CM_PER_INCH,
  );
  const layer = fillMask(mask, asFilm ? "#000000" : state.ink);
  const x = layout.offsetX * pxPerCm;
  const y = layout.offsetY * pxPerCm;

  ctx.drawImage(layer, Math.round(x), Math.round(y));

  if (asFilm && state.marks) {
    drawRegistrationMarks(ctx, x, y, layout.designW * pxPerCm, layout.designH * pxPerCm, pxPerCm);
  }

  return layout;
}

const preview = $("#view");
let frameRequest = null;

function scheduleRender() {
  if (frameRequest) cancelAnimationFrame(frameRequest);
  frameRequest = requestAnimationFrame(render);
}

function render() {
  frameRequest = null;
  if (!state.image) return;

  const layout = getLayout();
  const pxPerCm = PREVIEW_SIZE_PX / Math.max(layout.pageW, layout.pageH);
  renderTo(preview, pxPerCm, { asFilm: state.view === "film", forExport: false });
  updateMeta();
}

function exportSizePx() {
  const layout = getLayout();
  const pxPerCm = state.dpi / CM_PER_INCH;
  return {
    layout,
    width: Math.round(layout.pageW * pxPerCm),
    height: Math.round(layout.pageH * pxPerCm),
  };
}

function updateMeta() {
  const heightCm = designHeightCm();
  $("#heightOut").textContent = heightCm ? `${formatNumber(heightCm)} cm` : "–";

  if (!state.image) {
    $("#meta").textContent = "";
    return;
  }

  const { layout, width, height } = exportSizePx();
  const sheet = `${formatNumber(layout.pageW)} × ${formatNumber(layout.pageH)} cm`;
  const pixels = `${width} × ${height} px`;
  const isLarge = width > LARGE_EXPORT_PX || height > LARGE_EXPORT_PX;

  $("#pxOut").innerHTML =
    `Filmbogen: ${sheet} · ${pixels}` +
    (isLarge ? ' <span class="warn">– sehr groß, der Druck kann langsam sein</span>' : "");

  const formatName = state.format === "free" ? "wie Motiv" : $("#format").selectedOptions[0].text.split(" – ")[0];
  $("#meta").textContent =
    `Motiv ${formatNumber(designWidthCm())} × ${formatNumber(heightCm)} cm · ` +
    `Bogen ${formatName} · ${state.dpi} DPI · ${pixels}`;
}

function downloadPng() {
  const canvas = document.createElement("canvas");
  renderTo(canvas, state.dpi / CM_PER_INCH, { asFilm: true, forExport: true });

  const link = document.createElement("a");
  link.download = `film_${round2(designWidthCm())}x${round2(designHeightCm())}cm_${state.dpi}dpi.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function printFilm() {
  const canvas = document.createElement("canvas");
  const layout = renderTo(canvas, state.dpi / CM_PER_INCH, { asFilm: true, forExport: false });

  const image = new Image();
  image.style.display = "block";
  image.style.width = `${layout.pageW}cm`;
  image.style.height = `${layout.pageH}cm`;

  const area = $("#printArea");
  area.replaceChildren(image);

  let pageStyle = $("#printPageStyle");
  if (!pageStyle) {
    pageStyle = document.createElement("style");
    pageStyle.id = "printPageStyle";
    document.head.appendChild(pageStyle);
  }
  pageStyle.textContent =
    `@page { size: ${(layout.pageW + 0.4).toFixed(2)}cm ${(layout.pageH + 0.4).toFixed(2)}cm; margin: 2mm; }`;

  image.onload = () => window.print();
  image.src = canvas.toDataURL("image/png");
}

function applyFormat(key) {
  state.format = key;
  $("#format").value = key;

  if (key === "free") {
    state.sheet = null;
    scheduleRender();
    return;
  }

  const [a, b] = FORMATS[key];
  const ratio = state.naturalWidth / state.naturalHeight || 1;
  const landscape = ratio >= 1;
  const sheetW = landscape ? Math.max(a, b) : Math.min(a, b);
  const sheetH = landscape ? Math.min(a, b) : Math.max(a, b);
  state.sheet = [sheetW, sheetH];

  const fittedWidthCm = Math.min(sheetW, sheetH * ratio) * 0.92;
  state.width = round2(fromCm(fittedWidthCm));
  $("#width").value = state.width;

  scheduleRender();
}

function setThreshold(value) {
  state.threshold = value;
  $("#threshold").value = value;
  $("#thresholdVal").textContent = value;
}

function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) return;

  const url = URL.createObjectURL(file);
  const image = new Image();

  image.onload = () => {
    URL.revokeObjectURL(url);
    state.image = image;
    state.naturalWidth = image.naturalWidth;
    state.naturalHeight = image.naturalHeight;

    $("#drop").hidden = true;
    $("#png").disabled = false;
    $("#print").disabled = false;
    $("#imgInfo").textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight} px`;

    if (state.mode === "threshold") setThreshold(computeOtsuThreshold());
    applyFormat(state.format);
  };

  image.src = url;
}

function selectSegment(container, button) {
  for (const child of container.children) {
    child.classList.toggle("active", child === button);
  }
}

function setFabric(hex) {
  state.fabric = hex;

  document.querySelectorAll(".swatch").forEach((swatch) => {
    swatch.classList.toggle("active", swatch.dataset.fabric === hex);
  });

  if (!state.inkChangedByUser) {
    state.ink = contrastInk(hex);
    $("#inkColor").value = state.ink;
  }

  if (state.view === "fabric") scheduleRender();
}

const dropzone = $("#drop");
const canvasWrap = $("#wrap");

$("#pick").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", (e) => loadFile(e.target.files[0]));

["dragenter", "dragover"].forEach((type) => {
  canvasWrap.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.hidden = false;
    dropzone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((type) => {
  canvasWrap.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragging");
    if (state.image) dropzone.hidden = true;
  });
});

canvasWrap.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

$("#format").addEventListener("change", (e) => applyFormat(e.target.value));

$("#width").addEventListener("input", (e) => {
  state.width = parseFloat(e.target.value) || 0;
  state.format = "free";
  state.sheet = null;
  $("#format").value = "free";
  scheduleRender();
});

$("#unit").addEventListener("change", (e) => {
  const widthCm = designWidthCm();
  state.unit = e.target.value;
  state.width = round2(fromCm(widthCm));
  $("#width").value = state.width;
  scheduleRender();
});

$("#dpi").addEventListener("change", (e) => {
  state.dpi = parseInt(e.target.value, 10);
  updateMeta();
});

$("#modeSeg").addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;

  state.mode = button.dataset.mode;
  selectSegment(e.currentTarget, button);

  $("#thresholdGroup").hidden = state.mode !== "threshold";
  $("#halftoneGroup").hidden = state.mode !== "halftone";
  $("#modeHint").textContent = MODE_HINTS[state.mode];

  if (state.mode === "threshold" && state.image) setThreshold(computeOtsuThreshold());
  scheduleRender();
});

$("#autoThreshold").addEventListener("click", () => {
  if (!state.image) return;
  setThreshold(computeOtsuThreshold());
  scheduleRender();
});

$("#threshold").addEventListener("input", (e) => {
  setThreshold(Number(e.target.value));
  scheduleRender();
});

$("#lpi").addEventListener("input", (e) => {
  state.lpi = Number(e.target.value);
  $("#lpiVal").textContent = state.lpi;
  scheduleRender();
});

$("#angle").addEventListener("input", (e) => {
  state.angle = Number(e.target.value);
  $("#angleVal").textContent = `${formatNumber(state.angle)}°`;
  scheduleRender();
});

$("#contrast").addEventListener("input", (e) => {
  state.contrast = Number(e.target.value);
  $("#contrastVal").textContent = state.contrast > 0 ? `+${state.contrast}` : state.contrast;
  scheduleRender();
});

$("#invert").addEventListener("change", (e) => {
  state.invert = e.target.checked;
  scheduleRender();
});

document.querySelectorAll(".swatch").forEach((swatch) => {
  swatch.addEventListener("click", () => setFabric(swatch.dataset.fabric));
});

$("#fabricCustom").addEventListener("input", (e) => setFabric(e.target.value));

$("#inkColor").addEventListener("input", (e) => {
  state.ink = e.target.value;
  state.inkChangedByUser = true;
  if (state.view === "fabric") scheduleRender();
});

$("#mirror").addEventListener("change", (e) => {
  state.mirror = e.target.checked;
  scheduleRender();
});

$("#marks").addEventListener("change", (e) => {
  state.marks = e.target.checked;
  scheduleRender();
});

$("#transparent").addEventListener("change", (e) => {
  state.transparent = e.target.checked;
});

$("#viewSeg").addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;

  state.view = button.dataset.view;
  selectSegment(e.currentTarget, button);
  scheduleRender();
});

$("#png").addEventListener("click", downloadPng);
$("#print").addEventListener("click", printFilm);

updateMeta();
