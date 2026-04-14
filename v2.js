/* 이력서 스캐너 v2 — PaddleOCR PP-OCRv3 (한국어) via ONNX Runtime Web
 *
 * 구성:
 *   - @gutenye/ocr-browser: PaddleOCR 브라우저 래퍼 (DB 후처리 + CTC 디코드 내장)
 *   - monkt/paddleocr-onnx: PP-OCR ONNX 모델 (detection/v3 + korean/rec + dict)
 *   - GitHub raw via jsdelivr: CORS 가능한 모델 호스팅
 *
 * 참고:
 *   - 첫 로딩에 ~15MB 다운로드 (det 2.4MB + rec 13MB + dict 47KB)
 *   - 브라우저가 캐시하므로 다음부터는 즉시 로딩
 *   - WASM 백엔드 사용 (WebGPU 시도는 미래 과제)
 */
import Ocr from "https://esm.sh/@gutenye/ocr-browser@1.4.8";

// jsdelivr 이 jinus02/resume-scanner 의 models/ 폴더를 CORS 로 프록시
// (main 브랜치 → jsdelivr 이 자동 캐시 퍼지)
const MODEL_BASE = "https://cdn.jsdelivr.net/gh/jinus02/resume-scanner@main/models";
const MODELS = {
  detectionPath: `${MODEL_BASE}/det.onnx`,
  recognitionPath: `${MODEL_BASE}/rec.onnx`,
  dictionaryPath: `${MODEL_BASE}/korean_dict.txt`,
};

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const results = document.getElementById("results");
const loadStatus = document.getElementById("loadStatus");

let ocrPromise = null;

async function getOcr() {
  if (ocrPromise) return ocrPromise;
  ocrPromise = (async () => {
    loadStatus.textContent = "모델 다운로드 중… (첫 로딩만 ~15MB)";
    const t0 = performance.now();
    try {
      const ocr = await Ocr.create({ models: MODELS });
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      loadStatus.textContent = `엔진 준비 완료 (${elapsed}초)`;
      loadStatus.style.background = "#e6f7ee";
      loadStatus.style.color = "#1aa251";
      return ocr;
    } catch (err) {
      loadStatus.textContent = `엔진 로딩 실패: ${err && err.message ? err.message : err}`;
      loadStatus.style.background = "#ffe9e6";
      loadStatus.style.color = "#d92d20";
      throw err;
    }
  })();
  return ocrPromise;
}

// 페이지 로드 직후 모델 프리페치 시작 (사용자가 파일 고를 때 이미 준비돼 있도록)
getOcr().catch(() => {
  /* 에러는 loadStatus 에 이미 표시됨 */
});

// ── 드래그 앤 드롭 ────────────────────────────────────────────
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

function isImage(f) {
  return f.type.startsWith("image/");
}

async function handleFiles(files) {
  const accepted = files.filter(isImage);
  if (!accepted.length) return;
  for (const file of accepted) {
    const card = createCard(file);
    results.prepend(card.el);
    try {
      await processFile(file, card);
    } catch (err) {
      card.setError(err && err.message ? err.message : String(err));
    }
  }
}

function createCard(file) {
  const el = document.createElement("article");
  el.className = "result-card";
  const url = URL.createObjectURL(file);
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
          <div class="section-label">전체 텍스트 <span class="hint">(PaddleOCR Korean)</span></div>
          <div class="text-block">
            <div class="text-actions">
              <button class="copy-btn" type="button" data-role="copy">복사</button>
            </div>
            <textarea spellcheck="false" placeholder="처리 중…"></textarea>
          </div>
        </div>
      </div>
    </div>
  `;
  el.querySelector(".result-title").textContent = file.name;
  const previewImg = el.querySelector(".preview img");
  previewImg.src = url;
  previewImg.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });

  const status = el.querySelector(".status");
  const bar = el.querySelector(".progress-bar");
  const textarea = el.querySelector("textarea");
  const copyBtn = el.querySelector('[data-role="copy"]');

  copyBtn.addEventListener("click", async () => {
    if (!textarea.value) return;
    try {
      await navigator.clipboard.writeText(textarea.value);
    } catch {
      textarea.select();
      try { document.execCommand("copy"); } catch {}
    }
    const original = copyBtn.textContent;
    copyBtn.textContent = "복사됨!";
    copyBtn.classList.add("is-copied");
    setTimeout(() => {
      copyBtn.textContent = original;
      copyBtn.classList.remove("is-copied");
    }, 1500);
  });

  return {
    el,
    setStatus(text, kind) {
      status.textContent = text;
      status.classList.remove("is-done", "is-error");
      if (kind) status.classList.add(`is-${kind}`);
    },
    setProgress(p) {
      bar.style.width = `${Math.round(p * 100)}%`;
    },
    setText(text) {
      textarea.value = text;
    },
    setError(msg) {
      status.textContent = `오류: ${msg}`;
      status.classList.add("is-error");
      bar.style.width = "0";
    },
  };
}

async function processFile(file, card) {
  card.setStatus("엔진 준비 중…");
  card.setProgress(0.1);
  const ocr = await getOcr();

  card.setStatus("텍스트 인식 중…");
  card.setProgress(0.4);
  const imageUrl = URL.createObjectURL(file);
  try {
    const lines = await ocr.detect(imageUrl);
    card.setProgress(0.9);
    // lines 는 [{ text, mean, box }, ...] 형태. 세로 위치(y) 기준 정렬 후 연결
    const sorted = [...lines].sort((a, b) => {
      const ay = a.box ? Math.min(...a.box.map((p) => p[1])) : 0;
      const by = b.box ? Math.min(...b.box.map((p) => p[1])) : 0;
      return ay - by;
    });
    const text = sorted
      .map((l) => (l && l.text ? l.text : ""))
      .filter(Boolean)
      .join("\n");
    card.setText(text || "(인식된 텍스트 없음)");
    card.setProgress(1);
    card.setStatus("완료", "done");
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}
