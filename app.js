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

  function applyOcrFilters(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const contrast = 1.35;
    for (let p = 0; p < data.length; p += 4) {
      const gray = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
      const adjusted = (gray - 128) * contrast + 128;
      const v = adjusted < 0 ? 0 : adjusted > 255 ? 255 : adjusted;
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
    let scale = 1;
    if (minEdge < 800) scale = Math.min(3, 1600 / minEdge);
    else if (maxEdge > 3200) scale = 3200 / maxEdge;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
        const rawCanvas = await renderPdfPage(page, 2);
        applyOcrFilters(rawCanvas);
        const worker = await getWorker();
        const { data } = await worker.recognize(rawCanvas);
        pageText = (data && data.text) || "";
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

  async function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      if (typeof Tesseract === "undefined") {
        throw new Error("Tesseract.js 로드 실패");
      }
      const w = await Tesseract.createWorker("kor+eng", 1, {
        logger: (m) => currentLogger && currentLogger(m),
      });
      await w.setParameters({
        preserve_interword_spaces: "1",
      });
      return w;
    })();
    return workerPromise;
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

    copyBtn.addEventListener("click", () => copyText(textarea.value, copyBtn));
    learnBtn.addEventListener("click", () => {
      if (!rawText) return;
      const added = learnFromDiff(rawText, textarea.value);
      const original = learnBtn.textContent;
      learnBtn.textContent = added > 0 ? `+${added}개 학습!` : "변경 없음";
      learnBtn.classList.add("is-copied");
      setTimeout(() => {
        learnBtn.textContent = original;
        learnBtn.classList.remove("is-copied");
      }, 1800);
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
        card.setProgress(m.progress);
        card.setStatus("텍스트 인식 중…");
      } else if (m.status) {
        card.setStatus(translateStatus(m.status));
      }
    };

    card.setStatus("엔진 준비 중…");
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    currentLogger = null;

    card.setProgress(1);
    card.setStatus("완료", "done");
    const raw = denoiseOcrText(normalizeOcrText((data && data.text) || ""));
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
