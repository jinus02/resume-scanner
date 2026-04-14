/* 이력서 스캐너 — 100% 클라이언트 OCR + 학습 루프
 * - 이미지 전처리 (업스케일·그레이스케일·대비)로 인식률 향상
 * - 사용자가 교정한 결과를 localStorage 에 누적 → 다음 OCR 자동 적용
 * - 모든 처리는 브라우저 안에서만, 학습 데이터도 로컬에만 저장
 */
(() => {
  "use strict";

  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const results = document.getElementById("results");
  const learnedBadge = document.getElementById("learnedBadge");

  // PDF.js worker 경로 설정 (pdf.min.js 와 동일 버전)
  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  const STORAGE_KEY = "resume_scanner_corrections_v1";
  const MAX_CORRECTIONS = 500;

  // ── 학습 저장소 ───────────────────────────────────────────────
  function loadCorrections() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveCorrections(map) {
    // 상위 MAX_CORRECTIONS 개만 유지 (count 내림차순)
    const entries = Object.entries(map)
      .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
      .slice(0, MAX_CORRECTIONS);
    const trimmed = Object.fromEntries(entries);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    return trimmed;
  }

  function updateLearnedBadge() {
    const map = loadCorrections();
    const count = Object.keys(map).length;
    if (learnedBadge) {
      learnedBadge.textContent = count > 0 ? `학습된 교정 ${count}개` : "학습된 교정 없음";
    }
  }

  function applyCorrections(text) {
    const map = loadCorrections();
    const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [from, data] of entries) {
      if (!from || !data || !data.to) continue;
      out = out.split(from).join(data.to);
    }
    return out;
  }

  // ── LCS 기반 단어 diff ────────────────────────────────────────
  function tokenize(text) {
    return text.split(/(\s+)/).filter((s) => s.length > 0);
  }

  function diffSubstitutions(oldText, newText) {
    const a = tokenize(oldText);
    const b = tokenize(newText);
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push(["=", a[i]]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push(["-", a[i++]]);
      } else {
        ops.push(["+", b[j++]]);
      }
    }
    while (i < n) ops.push(["-", a[i++]]);
    while (j < m) ops.push(["+", b[j++]]);

    const subs = [];
    for (let k = 0; k < ops.length; k++) {
      if (ops[k][0] === "-" && ops[k + 1] && ops[k + 1][0] === "+") {
        const from = ops[k][1].trim();
        const to = ops[k + 1][1].trim();
        if (from && to && from !== to && /\S/.test(from) && /\S/.test(to) && from.length >= 2) {
          subs.push({ from, to });
        }
        k++;
      }
    }
    return subs;
  }

  function learnFromDiff(rawText, editedText) {
    const subs = diffSubstitutions(rawText, editedText);
    if (!subs.length) return 0;
    const map = loadCorrections();
    let added = 0;
    for (const { from, to } of subs) {
      if (map[from]) {
        map[from].count = (map[from].count || 1) + 1;
        map[from].to = to;
      } else {
        map[from] = { to, count: 1 };
        added++;
      }
    }
    saveCorrections(map);
    updateLearnedBadge();
    return subs.length;
  }

  // ── 이미지 전처리 (정확도 향상) ────────────────────────────────
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  // Unsharp mask: 3x3 박스 블러로 저주파를 만든 뒤, 원본과의 차이를 증폭해 더함
  // → 살짝 흐린 한글 텍스트의 획 경계가 또렷해져서 Otsu 가 더 정확하게 동작함
  function applyUnsharpMask(canvas, amount = 0.8) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const w = canvas.width;
    const h = canvas.height;
    const src = ctx.getImageData(0, 0, w, h);
    const data = src.data;

    // RGB 각 채널을 그레이스케일로 먼저 변환 (R 채널만 써도 동일)
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }

    // 3x3 박스 블러
    const blur = new Uint8ClampedArray(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        let sum = 0;
        sum += gray[idx - w - 1] + gray[idx - w] + gray[idx - w + 1];
        sum += gray[idx - 1] + gray[idx] + gray[idx + 1];
        sum += gray[idx + w - 1] + gray[idx + w] + gray[idx + w + 1];
        blur[idx] = (sum / 9) | 0;
      }
    }

    // sharpened = gray + amount * (gray - blur)
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      const sharp = gray[p] + amount * (gray[p] - blur[p]);
      const v = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    ctx.putImageData(src, 0, 0);
    return canvas;
  }

  // Otsu 이진화: 히스토그램 기반으로 최적 임계값을 찾아 순수 흑백으로 변환
  // → 한글 자소 경계가 살아나 Tesseract 인식률이 크게 개선됨
  function otsuThreshold(grayHist, total) {
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * grayHist[t];
    let sumB = 0;
    let wB = 0;
    let maxVar = 0;
    let threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += grayHist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * grayHist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) {
        maxVar = v;
        threshold = t;
      }
    }
    return threshold;
  }

  function applyOcrFilters(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;

    // 1단계: 그레이스케일 + 히스토그램 수집
    const hist = new Uint32Array(256);
    const grayBuf = new Uint8ClampedArray(data.length / 4);
    for (let p = 0, g = 0; p < data.length; p += 4, g++) {
      const gray = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
      grayBuf[g] = gray;
      hist[gray]++;
    }

    // 2단계: Otsu 이진화 (순수 흑백으로 분리)
    const threshold = otsuThreshold(hist, grayBuf.length);
    // 배경이 텍스트보다 밝은 문서에서만 이진화 — 평균 밝기로 판별
    let meanBright = 0;
    for (let i = 0; i < grayBuf.length; i++) meanBright += grayBuf[i];
    meanBright /= grayBuf.length;
    const useBinarize = meanBright > 120; // 일반 문서는 밝은 배경

    for (let p = 0, g = 0; p < data.length; p += 4, g++) {
      let v;
      if (useBinarize) {
        v = grayBuf[g] > threshold ? 255 : 0;
      } else {
        // 어두운 배경일 땐 기존 대비 향상만
        const adjusted = (grayBuf[g] - 128) * 1.4 + 128;
        v = adjusted < 0 ? 0 : adjusted > 255 ? 255 : adjusted;
      }
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  async function preprocessImage(file) {
    const img = await loadImage(file);
    const maxEdge = Math.max(img.width, img.height);
    const minEdge = Math.min(img.width, img.height);
    // 한국어는 x-height ≥ 40px 일 때 인식률 최고 → 기준을 2400px 로 상향
    let scale = 1;
    if (minEdge < 1200) scale = Math.min(3.5, 2400 / minEdge);
    else if (maxEdge > 4000) scale = 4000 / maxEdge;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // 1) Unsharp mask (경계 또렷하게) → 2) Otsu 이진화
    applyUnsharpMask(canvas, 0.8);
    return applyOcrFilters(canvas);
  }

  // ── PDF 처리 ─────────────────────────────────────────────────
  async function renderPdfPage(page, scale = 2) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // 흰 배경으로 채워 투명 PDF 페이지 대비
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  function extractPageTextLayer(textContent) {
    // PDF.js textContent.items[] 를 공간 정보를 최대한 살려 문자열로 합침
    const lines = [];
    let currentLine = [];
    let currentY = null;
    for (const item of textContent.items) {
      if (!item || typeof item.str !== "string") continue;
      const y = item.transform ? item.transform[5] : 0;
      if (currentY === null || Math.abs(y - currentY) > 2) {
        if (currentLine.length) lines.push(currentLine.join(" "));
        currentLine = [];
        currentY = y;
      }
      if (item.str.trim()) currentLine.push(item.str);
    }
    if (currentLine.length) lines.push(currentLine.join(" "));
    return lines.join("\n").trim();
  }

  async function processPdf(file, card) {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("PDF.js 로드 실패");
    }
    card.setStatus("PDF 로딩 중…");
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pageCount = pdf.numPages;
    const parts = [];

    for (let p = 1; p <= pageCount; p++) {
      card.setProgress((p - 1) / pageCount);
      const page = await pdf.getPage(p);
      let pageText = "";

      try {
        card.setStatus(`PDF ${p}/${pageCount} — 텍스트 레이어 추출`);
        const textContent = await page.getTextContent();
        pageText = extractPageTextLayer(textContent);
      } catch {
        pageText = "";
      }

      if (pageText.replace(/\s/g, "").length < 20) {
        // 스캔본 or 이미지 PDF → OCR 폴백
        card.setStatus(`PDF ${p}/${pageCount} — OCR 처리 중…`);
        // 한국어 인식률을 위해 렌더 배율을 3배로 (= 약 216 DPI)
        const rawCanvas = await renderPdfPage(page, 3);
        applyUnsharpMask(rawCanvas, 0.8);
        applyOcrFilters(rawCanvas);
        pageText = await recognizeDualPass(rawCanvas, card);
      }

      parts.push(`━━━ 페이지 ${p} / ${pageCount} ━━━\n${pageText.trim()}`);
      page.cleanup && page.cleanup();
    }

    await pdf.destroy();
    return parts.join("\n\n");
  }

  async function makePdfPreview(file) {
    // 첫 페이지를 미리보기용 작은 이미지로 렌더링
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 0.6 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const url = canvas.toDataURL("image/png");
      await pdf.destroy();
      return url;
    } catch {
      return null;
    }
  }

  function normalizeOcrText(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ── OCR 노이즈 필터 (관련 없는 라인 제거) ────────────────────
  function stripNoiseTokens(line) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const isNoise = (t) => t.length === 1 || /^[^가-힣A-Za-z0-9]+$/.test(t);
    while (tokens.length && isNoise(tokens[0])) tokens.shift();
    while (tokens.length && isNoise(tokens[tokens.length - 1])) tokens.pop();
    return tokens.join(" ");
  }

  function denoiseOcrText(text) {
    const lines = text.split("\n");
    const out = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        out.push("");
        continue;
      }
      // 페이지 구분자 보존
      if (/^━/.test(line) || /^페이지\s*\d+\s*\/\s*\d+$/.test(line)) {
        out.push(line);
        continue;
      }
      const cleaned = stripNoiseTokens(line);
      if (!cleaned) continue;
      // "진짜 단어" 하나 이상 필수
      const hasRealWord = /[가-힣]{2,}|[A-Za-z0-9]{3,}/.test(cleaned);
      if (!hasRealWord) continue;
      // 의미 있는 문자 비율 체크
      const meaningful = (cleaned.match(/[가-힣A-Za-z0-9]/g) || []).length;
      const total = cleaned.replace(/\s/g, "").length;
      if (total === 0 || meaningful / total < 0.4) continue;
      out.push(cleaned);
    }
    // 연속 빈 줄 접기 + 양끝 빈 줄 제거
    const collapsed = [];
    for (const l of out) {
      if (l === "" && collapsed[collapsed.length - 1] === "") continue;
      collapsed.push(l);
    }
    while (collapsed.length && collapsed[0] === "") collapsed.shift();
    while (collapsed.length && collapsed[collapsed.length - 1] === "") collapsed.pop();
    return collapsed.join("\n");
  }

  // ── 필드 추출 정규식 ─────────────────────────────────────────
  const FIELD_PATTERNS = [
    { key: "발급일", re: /(?:발급|취득|수여|이수|수료|인증|등록)\s*(?:일자|일|날짜)?\s*[:：]?\s*(\d{4}[.\-\/년\s]\s*\d{1,2}[.\-\/월\s]\s*\d{1,2}[일]?)/ },
    { key: "발급기관", re: /(?:발급기관|발급처|주최|주관|발행)\s*[:：]?\s*([^\n]{2,40})/ },
    { key: "자격번호", re: /(?:자격|등록|증서|인증)\s*(?:번호|No\.?)\s*[:：]?\s*([A-Z0-9가-힣\-]{4,30})/i },
    { key: "성명", re: /(?:성\s*명|이\s*름)\s*[:：]?\s*([가-힣]{2,5})/ },
    { key: "생년월일", re: /(?:생년월일|생일)\s*[:：]?\s*(\d{4}[.\-\/년\s]\s*\d{1,2}[.\-\/월\s]\s*\d{1,2}[일]?)/ },
    { key: "점수", re: /(?:점수|성적|score)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?\s*(?:점|\/\s*\d+)?)/i },
  ];

  function extractFields(text) {
    const found = [];
    for (const { key, re } of FIELD_PATTERNS) {
      const m = text.match(re);
      if (m && m[1]) {
        found.push({ key, value: m[1].trim().replace(/\s+/g, " ") });
      }
    }
    return found;
  }

  // ── Tesseract worker (전역 재사용) ───────────────────────────
  let currentLogger = null;
  let workerPromise = null;
  const MIN_WORD_CONFIDENCE = 60; // 60 미만 단어는 OCR 쓰레기로 간주하고 drop

  async function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      if (typeof Tesseract === "undefined") {
        throw new Error("Tesseract.js 로드 실패");
      }
      // tessdata_best: fast 대비 파일 크기↑ 정확도↑ (한국어 수료증/명함 에서 차이 큼)
      const w = await Tesseract.createWorker("kor+eng", 1, {
        langPath: "https://tessdata.projectnaptha.com/4.0.0_best",
        logger: (m) => currentLogger && currentLogger(m),
      });
      await w.setParameters({
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
        tessedit_pageseg_mode: "6",
        // OEM 1 = LSTM only. 레거시 엔진이 섞이면 한글이 깨지므로 LSTM 전용.
        tessedit_ocr_engine_mode: "1",
      });
      return w;
    })();
    return workerPromise;
  }

  // data.words 배열을 confidence 필터링 후 라인 단위로 재조립
  function buildTextFromWords(result) {
    const words = (result && result.words) || [];
    if (!words.length) return (result && result.text) || "";
    // 블록/라인 id 기반으로 그룹화
    const linesMap = new Map();
    for (const word of words) {
      if (!word || typeof word.text !== "string") continue;
      if (typeof word.confidence === "number" && word.confidence < MIN_WORD_CONFIDENCE) continue;
      const t = word.text.trim();
      if (!t) continue;
      // line.baseline 또는 line_num 으로 그룹 키 구성 — 없으면 bbox.y0 을 버킷화
      const bbox = word.bbox || {};
      const key = word.line
        ? `${word.line.baseline ? word.line.baseline.y0 : ""}_${word.line.bbox ? word.line.bbox.y0 : ""}`
        : Math.round((bbox.y0 || 0) / 10);
      if (!linesMap.has(key)) linesMap.set(key, []);
      linesMap.get(key).push({ text: t, x: bbox.x0 || 0 });
    }
    const lines = [];
    for (const arr of linesMap.values()) {
      arr.sort((a, b) => a.x - b.x);
      lines.push(arr.map((w) => w.text).join(" "));
    }
    return lines.join("\n");
  }

  // "진짜 단어 밀도" 점수: 한글 2자+ / 영숫자 3자+ 토큰 수
  function realWordScore(text) {
    if (!text) return 0;
    const tokens = text.split(/\s+/).filter(Boolean);
    let score = 0;
    for (const t of tokens) {
      if (/[가-힣]{2,}/.test(t)) score += 2; // 한글에 가중치
      else if (/[A-Za-z0-9]{3,}/.test(t)) score += 1;
    }
    return score;
  }

  // Dual-pass OCR: PSM 6 + PSM 4 를 돌려 "진짜 단어 점수"가 높은 쪽 채택
  async function recognizeDualPass(canvas, card) {
    const worker = await getWorker();
    card.setStatus("텍스트 인식 중 (1/2)…");
    const r1 = await worker.recognize(canvas);
    const text1 = buildTextFromWords(r1.data);
    const score1 = realWordScore(text1);

    card.setStatus("텍스트 인식 중 (2/2)…");
    await worker.setParameters({ tessedit_pageseg_mode: "4" });
    const r2 = await worker.recognize(canvas);
    const text2 = buildTextFromWords(r2.data);
    const score2 = realWordScore(text2);
    // 다음 호출을 위해 기본 PSM 6 복원
    await worker.setParameters({ tessedit_pageseg_mode: "6" });

    return score2 > score1 ? text2 : text1;
  }

  // ── 드래그 / 파일 입력 ──────────────────────────────────────
  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("is-dragover");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    handleFiles(files);
  });
  dropZone.addEventListener("click", (e) => {
    if (e.target.tagName !== "INPUT" && e.target.tagName !== "LABEL") {
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", (e) => {
    handleFiles(Array.from(e.target.files));
    fileInput.value = "";
  });

  function isSupportedFile(f) {
    return f.type.startsWith("image/") || f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  }

  async function handleFiles(files) {
    const accepted = files.filter(isSupportedFile);
    if (!accepted.length) return;
    for (const file of accepted) {
      const card = await createCard(file);
      results.prepend(card.el);
      try {
        await processFile(file, card);
      } catch (err) {
        card.setError(err && err.message ? err.message : String(err));
      }
    }
  }

  async function processFile(file, card) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      const raw = denoiseOcrText(normalizeOcrText(await processPdf(file, card)));
      card.setProgress(1);
      card.setStatus("완료", "done");
      card.setText(raw);
    } else {
      await runOcr(file, card);
    }
  }

  async function createCard(file) {
    const el = document.createElement("article");
    el.className = "result-card";

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const previewUrl = isPdf ? await makePdfPreview(file) : URL.createObjectURL(file);

    el.innerHTML = `
      <div class="result-head">
        <div class="result-title"></div>
        <div class="status">대기 중…</div>
      </div>
      <div class="progress"><div class="progress-bar"></div></div>
      <div class="result-body">
        <div class="preview"><img alt="미리보기" /></div>
        <div class="text-pane">
          <div>
            <div class="section-label">추출 정보</div>
            <div class="fields"></div>
          </div>
          <div>
            <div class="section-label">전체 텍스트 <span class="hint">(수정 후 학습 저장하면 다음부터 자동 적용)</span></div>
            <div class="text-block">
              <div class="text-actions">
                <button class="copy-btn" type="button" data-role="copy">복사</button>
                <button class="learn-btn" type="button" data-role="learn">학습 저장</button>
              </div>
              <textarea spellcheck="false" placeholder="처리 중…"></textarea>
            </div>
          </div>
        </div>
      </div>
    `;

    el.querySelector(".result-title").textContent = file.name;
    const previewImg = el.querySelector(".preview img");
    if (previewUrl) {
      previewImg.src = previewUrl;
      if (!isPdf) {
        previewImg.addEventListener("load", () => URL.revokeObjectURL(previewUrl), { once: true });
      }
    } else {
      previewImg.alt = "PDF";
      previewImg.style.display = "none";
      el.querySelector(".preview").textContent = "📄 PDF";
    }

    const status = el.querySelector(".status");
    const bar = el.querySelector(".progress-bar");
    const textarea = el.querySelector("textarea");
    const fieldsEl = el.querySelector(".fields");
    const copyBtn = el.querySelector('[data-role="copy"]');
    const learnBtn = el.querySelector('[data-role="learn"]');

    let rawText = "";
    let lastLearnedValue = "";
    let autoLearnTimer = null;

    function autoLearn() {
      if (!rawText) return 0;
      const current = textarea.value;
      if (current === lastLearnedValue) return 0;
      const added = learnFromDiff(rawText, current);
      lastLearnedValue = current;
      return added;
    }

    copyBtn.addEventListener("click", () => {
      // 복사 = 암묵적 승인 → 자동 학습 저장
      autoLearn();
      copyText(textarea.value, copyBtn);
    });

    learnBtn.addEventListener("click", () => {
      if (!rawText) return;
      const added = autoLearn();
      const original = learnBtn.textContent;
      learnBtn.textContent = added > 0 ? `+${added}개 학습!` : "변경 없음";
      learnBtn.classList.add("is-copied");
      setTimeout(() => {
        learnBtn.textContent = original;
        learnBtn.classList.remove("is-copied");
      }, 1800);
    });

    textarea.addEventListener("input", () => {
      // 타이핑 멈춘 지 1.5초 후 자동 학습
      if (autoLearnTimer) clearTimeout(autoLearnTimer);
      autoLearnTimer = setTimeout(() => {
        autoLearn();
      }, 1500);
    });

    return {
      el,
      setProgress(p) {
        bar.style.width = `${Math.round(p * 100)}%`;
      },
      setStatus(text, kind) {
        status.textContent = text;
        status.classList.remove("is-done", "is-error");
        if (kind) status.classList.add(`is-${kind}`);
      },
      setText(raw) {
        rawText = raw;
        const corrected = applyCorrections(raw);
        textarea.value = corrected;
        lastLearnedValue = corrected;
        renderFields(fieldsEl, corrected);
      },
      setError(msg) {
        status.textContent = `오류: ${msg}`;
        status.classList.add("is-error");
        bar.style.width = "0";
      },
    };
  }

  function renderFields(container, text) {
    container.innerHTML = "";
    const fields = extractFields(text);
    if (!fields.length) {
      const empty = document.createElement("div");
      empty.className = "field-row";
      empty.innerHTML = `<span class="key">정보</span><span class="val"></span><span></span>`;
      empty.querySelector(".val").textContent = "자동 추출된 항목이 없습니다. 전체 텍스트를 확인해주세요.";
      container.appendChild(empty);
      return;
    }
    for (const { key, value } of fields) {
      const row = document.createElement("div");
      row.className = "field-row";
      row.innerHTML = `<span class="key"></span><span class="val"></span><button class="copy-btn" type="button">복사</button>`;
      row.querySelector(".key").textContent = key;
      row.querySelector(".val").textContent = value;
      const btn = row.querySelector(".copy-btn");
      btn.addEventListener("click", () => copyText(value, btn));
      container.appendChild(row);
    }
  }

  async function copyText(text, btn) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = "복사됨!";
    btn.classList.add("is-copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("is-copied");
    }, 1500);
  }

  async function runOcr(file, card) {
    card.setStatus("이미지 전처리 중…");
    const canvas = await preprocessImage(file);

    currentLogger = (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        card.setProgress(m.progress * 0.5); // 두 번 돌리므로 50% 분할
      } else if (m.status) {
        card.setStatus(translateStatus(m.status));
      }
    };

    card.setStatus("엔진 준비 중…");
    const bestText = await recognizeDualPass(canvas, card);
    currentLogger = null;

    card.setProgress(1);
    card.setStatus("완료", "done");
    const raw = denoiseOcrText(normalizeOcrText(bestText));
    card.setText(raw);
  }

  function translateStatus(status) {
    const map = {
      "loading tesseract core": "엔진 로딩 중…",
      "initializing tesseract": "초기화 중…",
      "loading language traineddata": "언어 데이터 다운로드 중…",
      "initializing api": "API 초기화 중…",
      "recognizing text": "텍스트 인식 중…",
    };
    return map[status] || status;
  }

  updateLearnedBadge();
})();
