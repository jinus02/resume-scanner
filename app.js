/* 이력서 스캐너 — 100% 클라이언트 OCR
 * 모든 이미지 처리는 브라우저에서만 일어나며, 외부 서버로 전송되지 않습니다.
 * (Tesseract.js worker / lang data 만 jsdelivr CDN 에서 다운로드)
 */
(() => {
  "use strict";

  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const results = document.getElementById("results");

  // ── 필드 추출 정규식 ───────────────────────────────────────────
  const FIELD_PATTERNS = [
    {
      key: "발급일",
      re: /(?:발급|취득|수여|이수|수료|인증|등록)\s*(?:일자|일|날짜)?\s*[:：]?\s*(\d{4}[.\-\/년\s]\s*\d{1,2}[.\-\/월\s]\s*\d{1,2}[일]?)/,
    },
    {
      key: "발급기관",
      re: /(?:발급기관|발급처|주최|주관|발행)\s*[:：]?\s*([^\n]{2,40})/,
    },
    {
      key: "자격번호",
      re: /(?:자격|등록|증서|인증)\s*(?:번호|No\.?)\s*[:：]?\s*([A-Z0-9가-힣\-]{4,30})/i,
    },
    {
      key: "성명",
      re: /(?:성\s*명|이\s*름)\s*[:：]?\s*([가-힣]{2,5})/,
    },
    {
      key: "생년월일",
      re: /(?:생년월일|생일)\s*[:：]?\s*(\d{4}[.\-\/년\s]\s*\d{1,2}[.\-\/월\s]\s*\d{1,2}[일]?)/,
    },
    {
      key: "점수",
      re: /(?:점수|성적|score)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?\s*(?:점|\/\s*\d+)?)/i,
    },
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

  // ── 드래그 / 파일 입력 ─────────────────────────────────────────
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

  // ── 파일 → OCR ────────────────────────────────────────────────
  async function handleFiles(files) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;

    for (const file of images) {
      const card = createCard(file);
      results.prepend(card.el);
      try {
        await runOcr(file, card);
      } catch (err) {
        card.setError(err && err.message ? err.message : String(err));
      }
    }
  }

  function createCard(file) {
    const el = document.createElement("article");
    el.className = "result-card";

    const previewUrl = URL.createObjectURL(file);

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
            <div class="section-label">전체 텍스트</div>
            <div class="text-block">
              <button class="copy-btn" type="button">복사</button>
              <textarea spellcheck="false" placeholder="처리 중…"></textarea>
            </div>
          </div>
        </div>
      </div>
    `;

    el.querySelector(".result-title").textContent = file.name;
    el.querySelector(".preview img").src = previewUrl;

    const status = el.querySelector(".status");
    const bar = el.querySelector(".progress-bar");
    const textarea = el.querySelector("textarea");
    const fieldsEl = el.querySelector(".fields");
    const copyBtn = el.querySelector(".text-block .copy-btn");

    copyBtn.addEventListener("click", () => copyText(textarea.value, copyBtn));

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
      setText(text) {
        textarea.value = text;
        renderFields(fieldsEl, text);
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
      empty.innerHTML = `<span class="key">정보</span><span class="val">자동 추출된 항목이 없습니다. 전체 텍스트를 확인해주세요.</span><span></span>`;
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
    if (typeof Tesseract === "undefined") {
      throw new Error("Tesseract.js 로드 실패");
    }
    card.setStatus("OCR 처리 중…");
    const { data } = await Tesseract.recognize(file, "kor+eng", {
      logger: (m) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          card.setProgress(m.progress);
        } else if (m.status) {
          card.setStatus(translateStatus(m.status));
        }
      },
    });
    card.setProgress(1);
    card.setStatus("완료", "done");
    card.setText((data && data.text ? data.text : "").trim());
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
})();
