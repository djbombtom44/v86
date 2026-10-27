"use strict";
/*
 * opfs-main.js  -  main-thread UI / coordinator for opfs.html
 *
 *  - File System Access (FSA) pickers for disk images and state files
 *  - streams chosen images into OPFS (file.stream().pipeTo(writable)) - never into a JS ArrayBuffer
 *  - owns the Dedicated Worker (v86-worker.js) that runs v86 on top of OPFS sync access handles
 *  - Play / Pause / Save State / Load State / Switch Drive controls
 *  - forwards keyboard + mouse input to the worker (the worker has no DOM)
 */
(() => {
    const KEYCODE_TO_SCANCODE = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 14, 15, 0, 0, 0, 28, 0, 0, 42, 29, 56, 0, 58, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 57, 57417, 57425, 57423, 57415, 57419, 57416, 57421, 80, 0, 0, 0, 0, 82, 83, 0, 11, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 39, 0, 13, 0, 0, 0, 30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44, 57435, 57436, 57437, 0, 0, 82, 79, 80, 81, 75, 76, 77, 71, 72, 73, 0, 0, 0, 0, 0, 0, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 69, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 39, 13, 51, 12, 52, 53, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 43, 27, 40, 0, 57435, 57400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const CODE_TO_SCANCODE = {"Escape": 1, "Digit1": 2, "Digit2": 3, "Digit3": 4, "Digit4": 5, "Digit5": 6, "Digit6": 7, "Digit7": 8, "Digit8": 9, "Digit9": 10, "Digit0": 11, "Minus": 12, "Equal": 13, "Backspace": 14, "Tab": 15, "KeyQ": 16, "KeyW": 17, "KeyE": 18, "KeyR": 19, "KeyT": 20, "KeyY": 21, "KeyU": 22, "KeyI": 23, "KeyO": 24, "KeyP": 25, "BracketLeft": 26, "BracketRight": 27, "Enter": 28, "ControlLeft": 29, "KeyA": 30, "KeyS": 31, "KeyD": 32, "KeyF": 33, "KeyG": 34, "KeyH": 35, "KeyJ": 36, "KeyK": 37, "KeyL": 38, "Semicolon": 39, "Quote": 40, "Backquote": 41, "ShiftLeft": 42, "Backslash": 43, "KeyZ": 44, "KeyX": 45, "KeyC": 46, "KeyV": 47, "KeyB": 48, "KeyN": 49, "KeyM": 50, "Comma": 51, "Period": 52, "Slash": 53, "IntlRo": 53, "ShiftRight": 54, "NumpadMultiply": 55, "AltLeft": 56, "Space": 57, "CapsLock": 58, "F1": 59, "F2": 60, "F3": 61, "F4": 62, "F5": 63, "F6": 64, "F7": 65, "F8": 66, "F9": 67, "F10": 68, "NumLock": 69, "ScrollLock": 70, "Numpad7": 71, "Numpad8": 72, "Numpad9": 73, "NumpadSubtract": 74, "Numpad4": 75, "Numpad5": 76, "Numpad6": 77, "NumpadAdd": 78, "Numpad1": 79, "Numpad2": 80, "Numpad3": 81, "Numpad0": 82, "NumpadDecimal": 83, "IntlBackslash": 86, "F11": 87, "F12": 88, "NumpadEnter": 57372, "ControlRight": 57373, "NumpadDivide": 57397, "AltRight": 57400, "Home": 57415, "ArrowUp": 57416, "PageUp": 57417, "ArrowLeft": 57419, "ArrowRight": 57421, "End": 57423, "ArrowDown": 57424, "PageDown": 57425, "Insert": 57426, "Delete": 57427, "MetaLeft": 57435, "OSLeft": 57435, "MetaRight": 57436, "OSRight": 57436, "ContextMenu": 57437};


    const OPFS_FILES = { hda: "active_disk.img", hdb: "active_disk_b.img", cdrom: "active_cdrom.iso" };
    const SLOT_LABELS = { hda: "Hard disk (HDA)", hdb: "Second disk (HDB)", cdrom: "CD-ROM" };
    const META_KEY = "v86opfs.meta.v1";
    const SETTINGS_KEY = "v86opfs.settings.v1";
    const STATE_TMP_NAME = "state_download_tmp.bin";
    const RAM_MIN_MB = 16, RAM_MAX_MB = 4095;

    const $ = (id) => document.getElementById(id);
    const el = {
        banner: $("compat-banner"),
        drives: $("drive-rows"),
        slotSelect: $("slot-select"),
        ram: $("ram-size"), vram: $("video-memory"), winnt: $("winnt-compat"),
        boot: $("boot-order"), flush: $("flush-mode"),
        ramHint: $("ram-hint"),
        play: $("play-pause-btn"), save: $("save-state-btn"), load: $("load-state-btn"),
        sw: $("switch-drive-btn"), restart: $("restart-btn"),
        mouseBtn: $("mouse-capture-btn"), kbdBtn: $("keyboard-capture-btn"),
        keysBtn: $("special-keys-btn"), keysMenu: $("special-keys-menu"),
        mouseDot: $("mouse-status"), kbdDot: $("keyboard-status"),
        screenWrap: $("screen_container"), placeholder: $("screen-placeholder"),
        progressBox: $("progress-box"), progress: $("progress-bar"), progressText: $("progress-text"), cancel: $("cancel-btn"),
        status: $("status"), stats: $("stats"), stateFile: $("state-file-status"),
        upload: $("upload-btn"), drop: $("drop-zone"), ramPresets: $("ram-presets"), meter: $("storage-meter"),
        stage: $("vm-stage"), fsBtn: $("fullscreen-btn"), fsBar: $("fs-bar"),
        fsExit: $("fs-exit-btn"), fsPause: $("fs-pause-btn"), fsCad: $("fs-cad-btn"),
    };

    /* ----------------------------------------------------------------- *
     * state
     * ----------------------------------------------------------------- */
    // vm: idle | starting | running | paused | busy
    let vm = "idle";
    let worker = null;
    let destroyWaiter = null;
    let pendingState = null;            // File chosen before the VM was started (not read into memory)
    let saveSession = null;
    let loadWaiter = null;
    let mouseLocked = false;
    let keyboardCaptured = true;
    let canvasEl = null;
    let busyAbort = null;               // AbortController for the running copy
    let lastRunState = null;            // 'running' | 'paused' - what to restore after a busy operation

    /* ----------------------------------------------------------------- *
     * feature detection
     * ----------------------------------------------------------------- */
    const caps = {
        worker: typeof Worker !== "undefined",
        wasm: typeof WebAssembly !== "undefined",
        secure: window.isSecureContext,
        opfs: !!(navigator.storage && navigator.storage.getDirectory),
        syncHandle: null,   // exposed to workers only; probed asynchronously in init()
        offscreen: typeof OffscreenCanvas !== "undefined" && typeof HTMLCanvasElement !== "undefined" &&
            "transferControlToOffscreen" in HTMLCanvasElement.prototype,
        openPicker: typeof window.showOpenFilePicker === "function",
        savePicker: typeof window.showSaveFilePicker === "function",
    };

    function checkSupport() {
        const missing = [];
        if (!caps.secure) missing.push("a secure context (serve over https:// or http://localhost - OPFS is unavailable on file://)");
        if (!caps.worker) missing.push("Web Workers");
        if (!caps.wasm) missing.push("WebAssembly");
        if (!caps.opfs) missing.push("the Origin Private File System (navigator.storage.getDirectory)");
        else if (caps.syncHandle === false) missing.push("FileSystemSyncAccessHandle (createSyncAccessHandle in workers)");
        if (!caps.offscreen) missing.push("OffscreenCanvas / transferControlToOffscreen");
        return missing;
    }

    /* ----------------------------------------------------------------- *
     * small helpers
     * ----------------------------------------------------------------- */
    function fmtBytes(n) {
        if (n == null) return "-";
        const u = ["B", "KB", "MB", "GB", "TB"];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return n.toFixed(i > 1 ? 2 : 0) + " " + u[i];
    }
    function setStatus(msg, kind) {
        el.status.textContent = msg;
        el.status.className = "status" + (kind ? " " + kind : "");
    }
    const info = (m) => setStatus(m, "info");
    const err = (m) => setStatus(m, "error");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; } }
    function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage may be blocked */ } }
    const isAbort = (e) => e && (e.name === "AbortError");

    // A terminated worker releases its sync access handles asynchronously; retry briefly on lock errors.
    async function retryLocked(fn, tries = 20, delay = 150) {
        for (let i = 0; ; i++) {
            try { return await fn(); } catch (e) {
                if (i >= tries || !e || e.name !== "NoModificationAllowedError") throw e;
                await sleep(delay);
            }
        }
    }

    async function opfsRoot() { return navigator.storage.getDirectory(); }

    async function opfsSize(slot) {
        try {
            const root = await opfsRoot();
            const fh = await root.getFileHandle(OPFS_FILES[slot]);
            return (await fh.getFile()).size;
        } catch (e) { return null; }
    }

    /* ----------------------------------------------------------------- *
     * settings
     * ----------------------------------------------------------------- */
    function loadSettings() {
        const s = lsGet(SETTINGS_KEY);
        if (!s) return;
        if (s.ram) el.ram.value = s.ram;
        if (s.vram) el.vram.value = s.vram;
        if (typeof s.winnt === "boolean") el.winnt.checked = s.winnt;
        if (s.boot) el.boot.value = s.boot;
        if (s.flush != null) el.flush.value = String(s.flush);
    }
    function saveSettings() {
        lsSet(SETTINGS_KEY, {
            ram: el.ram.value, vram: el.vram.value, winnt: el.winnt.checked,
            boot: el.boot.value, flush: el.flush.value,
        });
    }
    function readRam() {
        const raw = String(el.ram.value).trim();
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isFinite(n) || n < RAM_MIN_MB || n > RAM_MAX_MB) {
            throw new Error(`RAM must be a whole number of MB between ${RAM_MIN_MB} and ${RAM_MAX_MB}.`);
        }
        return n;
    }
    function updateRamHint() {
        const dm = navigator.deviceMemory;      // coarse GB figure (Chromium only), capped at 8
        const n = Number(el.ram.value);
        let t = `Allowed ${RAM_MIN_MB}-${RAM_MAX_MB} MB. Takes effect on the next start/restart.`;
        if (dm && n > dm * 1024 * 0.5) t += ` Warning: this device reports ~${dm} GB of RAM - more than half of it may make the browser unstable.`;
        el.ramHint.textContent = t;
        el.ramHint.classList.toggle("warn", !!(dm && n > dm * 1024 * 0.5));
    }

    /* ----------------------------------------------------------------- *
     * drive table
     * ----------------------------------------------------------------- */
    function getMeta() { return lsGet(META_KEY) || {}; }
    function setMeta(slot, value) {
        const m = getMeta();
        if (value) m[slot] = value; else delete m[slot];
        lsSet(META_KEY, m);
    }

    const DRIVE_ICONS = {
        disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h.01M11 15h6"/></svg>',
        cd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
    };

    async function refreshDrives() {
        if (!caps.opfs) return;
        const meta = getMeta();
        el.drives.textContent = "";
        for (const slot of ["hda", "hdb", "cdrom"]) {
            const size = await opfsSize(slot);
            const card = document.createElement("div");
            card.className = "drive" + (size == null ? " empty" : "");
            card.innerHTML = '<div class="ico"></div><div class="meta"><div class="slot"></div><div class="name"></div></div><div class="acts"></div>';
            card.querySelector(".ico").innerHTML = slot === "cdrom" ? DRIVE_ICONS.cd : DRIVE_ICONS.disk;
            card.querySelector(".slot").textContent = SLOT_LABELS[slot];
            const name = card.querySelector(".name");
            if (size == null) name.textContent = "Empty";
            else {
                name.textContent = `${(meta[slot] && meta[slot].name) || OPFS_FILES[slot]} · ${fmtBytes(size)}`;
                name.title = `Stored as ${OPFS_FILES[slot]} in browser storage`;
            }
            const acts = card.querySelector(".acts");
            const up = document.createElement("button");
            up.textContent = size == null ? "Upload" : "Replace";
            up.title = `Upload a .img or .iso into the ${SLOT_LABELS[slot]} slot`;
            up.disabled = vm === "busy" || vm === "starting";
            up.addEventListener("click", () => uploadDisk(slot));
            acts.appendChild(up);
            if (size != null && slot !== "hda") {
                const b = document.createElement("button");
                b.className = "btn-danger";
                b.textContent = "Remove";
                b.disabled = vm !== "idle";
                b.title = vm === "idle" ? "Delete this image from browser storage" : "Stop the VM first (Switch Drive / Restart)";
                b.addEventListener("click", () => removeSlot(slot));
                acts.appendChild(b);
            }
            el.drives.appendChild(card);
        }
        await refreshStorageEstimate();
    }

    async function refreshStorageEstimate() {
        const box = $("storage-estimate");
        try {
            const e = await navigator.storage.estimate();
            box.textContent = `Browser storage: ${fmtBytes(e.usage)} used of ~${fmtBytes(e.quota)} available`;
            el.meter.style.width = (e.quota ? Math.min(100, (e.usage / e.quota) * 100) : 0).toFixed(1) + "%";
        } catch (e) { box.textContent = ""; }
    }

    async function removeSlot(slot) {
        if (vm !== "idle") return;
        if (!confirm(`Delete the ${SLOT_LABELS[slot]} image from browser storage?`)) return;
        try {
            const root = await opfsRoot();
            await root.removeEntry(OPFS_FILES[slot]);
        } catch (e) { /* already gone */ }
        setMeta(slot, null);
        await refreshDrives();
        updateButtons();
    }

    /* ----------------------------------------------------------------- *
     * UI state
     * ----------------------------------------------------------------- */
    function setVm(next) {
        vm = next;
        updateButtons();
    }

    async function updateButtons() {
        const active = vm === "running" || vm === "paused";
        const busy = vm === "busy" || vm === "starting";
        const sup = checkSupport().length === 0;

        el.play.disabled = !sup || busy;
        el.play.textContent = vm === "running" ? "⏸ Pause" : (vm === "paused" ? "▶ Resume" : "▶ Play");
        el.play.classList.toggle("is-running", vm === "running");
        el.save.disabled = !sup || !active;
        el.load.disabled = !sup || busy;
        el.sw.disabled = !sup || (vm === "starting");
        el.restart.disabled = !sup || !(active || vm === "idle");
        el.mouseBtn.disabled = vm !== "running";
        el.kbdBtn.disabled = vm !== "running";
        el.keysBtn.disabled = vm !== "running";
        el.upload.disabled = !sup || busy;
        el.fsPause.textContent = vm === "paused" ? "Resume" : "Pause";
        el.fsPause.disabled = !active;
        el.fsCad.disabled = vm !== "running";
        el.drives.querySelectorAll("button").forEach((b) => {
            b.disabled = b.classList.contains("btn-danger") ? vm !== "idle" : busy;
        });
        for (const c of [el.ram, el.vram, el.winnt, el.boot, el.flush, el.slotSelect]) c.disabled = false;
        document.body.dataset.vm = vm;
        if (vm !== "running") hideKeysMenu();
        updateCaptureUI();
    }

    function updateCaptureUI() {
        el.mouseBtn.textContent = mouseLocked ? "Release Mouse" : "Capture Mouse";
        el.mouseBtn.classList.toggle("active", mouseLocked);
        el.mouseDot.classList.toggle("active", mouseLocked);
        el.kbdBtn.textContent = keyboardCaptured ? "Release Keyboard" : "Capture Keyboard";
        el.kbdBtn.classList.toggle("active", keyboardCaptured && vm === "running");
        el.kbdDot.classList.toggle("active", keyboardCaptured && vm === "running");
    }

    function showProgress(text, fraction) {
        el.progressBox.hidden = false;
        el.progress.max = 1;
        el.progress.value = fraction == null ? 0 : fraction;
        if (fraction == null) el.progress.removeAttribute("value");
        el.progressText.textContent = text;
    }
    function hideProgress() {
        el.progressBox.hidden = true;
        el.cancel.hidden = true;
    }

    /* ----------------------------------------------------------------- *
     * file pickers (File System Access API with <input type=file> fallback)
     * ----------------------------------------------------------------- */
    function inputPick(accept) {
        return new Promise((resolve, reject) => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = accept;
            inp.style.display = "none";
            document.body.appendChild(inp);
            let settled = false;
            const done = (fn, v) => { if (settled) return; settled = true; inp.remove(); fn(v); };
            inp.addEventListener("change", () => {
                if (inp.files && inp.files[0]) done(resolve, { file: inp.files[0], handle: null });
                else done(reject, new DOMException("No file selected", "AbortError"));
            });
            inp.addEventListener("cancel", () => done(reject, new DOMException("Cancelled", "AbortError")));
            inp.click();
        });
    }

    // Request readwrite permission on a picked handle. Failure is not fatal: reading is enough.
    async function ensurePermission(handle) {
        if (!handle || !handle.queryPermission) return "unsupported";
        try {
            let p = await handle.queryPermission({ mode: "readwrite" });
            if (p !== "granted" && handle.requestPermission) p = await handle.requestPermission({ mode: "readwrite" });
            if (p !== "granted") {
                const r = await handle.queryPermission({ mode: "read" });
                return r === "granted" ? "read" : "denied";
            }
            return p;
        } catch (e) { return "unknown"; }
    }

    async function pickDiskFile() {
        if (caps.openPicker) {
            const [handle] = await window.showOpenFilePicker({
                multiple: false,
                types: [{ description: "Disk images (.img, .iso, .bin, .raw)", accept: { "application/octet-stream": [".img", ".iso", ".bin", ".raw"] } }],
                excludeAcceptAllOption: false,
            });
            const perm = await ensurePermission(handle);
            if (perm === "denied") throw new Error("Permission to read the selected file was denied.");
            return { file: await handle.getFile(), handle };
        }
        return inputPick(".img,.iso,.bin,.raw");
    }

    async function pickStateFile() {
        if (caps.openPicker) {
            const [handle] = await window.showOpenFilePicker({
                multiple: false,
                types: [{ description: "v86 state (.bin)", accept: { "application/octet-stream": [".bin"] } }],
            });
            await ensurePermission(handle);
            return { file: await handle.getFile(), handle };
        }
        return inputPick(".bin");
    }

    /* ----------------------------------------------------------------- *
     * mirror a picked file into OPFS (streamed, never held in a JS buffer)
     * ----------------------------------------------------------------- */
    function slotFor(file) {
        const choice = el.slotSelect.value;
        if (choice !== "auto") return choice;
        return /\.iso$/i.test(file.name) ? "cdrom" : "hda";
    }

    async function mirrorToOpfs(slot, file) {
        const root = await opfsRoot();
        const fileName = OPFS_FILES[slot];

        // Same image already mirrored? Offer to keep it (it holds the VM's own writes) instead of re-copying GBs.
        const meta = getMeta()[slot];
        const existing = await opfsSize(slot);
        if (meta && existing === file.size && meta.name === file.name && meta.size === file.size && meta.lastModified === file.lastModified) {
            const keep = confirm(
                `"${file.name}" is already mirrored in browser storage (including any changes the VM made to it).\n\n` +
                `OK = keep the existing copy and continue.\nCancel = overwrite it with a fresh copy of the original file.`);
            if (keep) return { copied: false };
        }

        // Quota check. A writable stream is committed on close, so the old copy normally coexists with the new one.
        let freeSpace = null;
        try { const e = await navigator.storage.estimate(); freeSpace = e.quota - e.usage; } catch (e) { /* unknown */ }
        let deleteOldFirst = false;
        if (freeSpace != null && freeSpace < file.size * 1.02) {
            if (existing != null && freeSpace + existing >= file.size * 1.02) {
                if (!confirm(`Not enough browser storage to keep the current ${SLOT_LABELS[slot]} while copying the new one.\n` +
                    `The current copy will be deleted first. Continue?`)) throw new DOMException("Cancelled", "AbortError");
                deleteOldFirst = true;
            } else {
                throw new Error(`Not enough browser storage: need ${fmtBytes(file.size)}, only ~${fmtBytes(freeSpace)} free. ` +
                    `Free some disk space or remove other site data and try again.`);
            }
        }
        if (deleteOldFirst) {
            try { await root.removeEntry(fileName); } catch (e) { /* absent */ }
            setMeta(slot, null);
        }

        // Ask the browser not to evict our (large) data under storage pressure. Best effort.
        try { if (navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }

        const handle = await root.getFileHandle(fileName, { create: true });
        const writable = await retryLocked(() => handle.createWritable({ keepExistingData: false }));

        busyAbort = new AbortController();
        el.cancel.hidden = false;
        let copied = 0;
        const t0 = performance.now();
        let lastPaint = 0;
        const counter = new TransformStream({
            transform(chunk, ctrl) {
                copied += chunk.byteLength;
                const now = performance.now();
                if (now - lastPaint > 150) {
                    lastPaint = now;
                    const rate = copied / Math.max(1, (now - t0) / 1000);
                    showProgress(`Copying ${file.name}: ${fmtBytes(copied)} / ${fmtBytes(file.size)}  (${fmtBytes(rate)}/s)`, file.size ? copied / file.size : 1);
                }
                ctrl.enqueue(chunk);
            },
        });
        try {
            showProgress(`Copying ${file.name}…`, 0);
            await file.stream().pipeThrough(counter).pipeTo(writable, { signal: busyAbort.signal });
        } finally {
            busyAbort = null;
            el.cancel.hidden = true;
        }
        setMeta(slot, { name: file.name, size: file.size, lastModified: file.lastModified, mirroredAt: Date.now() });
        return { copied: true };
    }

    /* ----------------------------------------------------------------- *
     * worker lifecycle
     * ----------------------------------------------------------------- */
    function baseUrl() { return new URL("./", location.href).href; }

    async function buildConfig() {
        const ramMB = readRam();
        const hda = (await opfsSize("hda")) != null;
        const hdb = (await opfsSize("hdb")) != null;
        const cdrom = (await opfsSize("cdrom")) != null;
        if (!hda && !cdrom) throw new Error("No disk image yet. Use \"Upload .img / .iso\" to add one first.");

        let bootOrder = el.boot.value;
        if (!hda && bootOrder.startsWith("hda")) bootOrder = "cdrom-only";
        if (!cdrom && bootOrder.startsWith("cdrom")) bootOrder = "hda-only";
        return {
            ramMB,
            vramMB: Number(el.vram.value),
            winnt: el.winnt.checked,
            bootOrder,
            flushMs: Number(el.flush.value),
            hda: hda ? OPFS_FILES.hda : null,
            hdb: hdb ? OPFS_FILES.hdb : null,
            cdrom: cdrom ? OPFS_FILES.cdrom : null,
        };
    }

    function newCanvas() {
        const c = document.createElement("canvas");
        c.id = "screen-canvas";
        c.width = 720; c.height = 400;
        el.screenWrap.querySelectorAll("canvas").forEach((o) => o.remove());
        el.screenWrap.appendChild(c);
        el.placeholder.hidden = true;
        canvasEl = c;
        return c;
    }

    async function startVM() {
        let config;
        try { config = await buildConfig(); } catch (e) { err(e.message); setVm("idle"); return; }
        saveSettings();
        setVm("starting");
        info(`Starting VM with ${config.ramMB} MB RAM…`);

        const canvas = newCanvas();
        const offscreen = canvas.transferControlToOffscreen();
        worker = new Worker("v86-worker.js");
        const w = worker;
        w.onmessage = (ev) => onWorkerMessage(w, ev.data);
        w.onerror = (ev) => {
            if (w !== worker) return;
            err("Worker failed: " + (ev.message || "unknown error. Check that libv86.js and worker-screen.js are reachable."));
            killWorker();
            setVm("idle");
        };
        w.postMessage({ type: "init", base: baseUrl(), canvas: offscreen, config }, [offscreen]);
    }

    // Politely ask the worker to stop, flush and close its OPFS handles, then terminate it.
    function destroyWorker() {
        if (!worker) return Promise.resolve();
        const w = worker;
        return new Promise((resolve) => {
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                destroyWaiter = null;
                try { w.terminate(); } catch (e) { /* gone */ }
                if (worker === w) worker = null;
                resolve();
            };
            destroyWaiter = finish;
            const timer = setTimeout(finish, 8000);      // never hang if the worker is wedged
            const orig = destroyWaiter;
            destroyWaiter = () => { clearTimeout(timer); orig(); };
            try { w.postMessage({ type: "destroy" }); } catch (e) { finish(); }
        }).then(() => {
            releasePointer();
            if (saveSession) { saveSession.reject(new Error("VM was stopped")); saveSession = null; }
            if (loadWaiter) { loadWaiter.reject(new Error("VM was stopped")); loadWaiter = null; }
        });
    }
    function killWorker() {
        if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
    }

    function onWorkerMessage(w, msg) {
        if (w !== worker && msg.type !== "destroyed") return;
        switch (msg.type) {
            case "disk_info": {
                const parts = [];
                if (msg.info.hda != null) parts.push("HDA " + fmtBytes(msg.info.hda));
                if (msg.info.hdb != null) parts.push("HDB " + fmtBytes(msg.info.hdb));
                if (msg.info.cdrom != null) parts.push("CD-ROM " + fmtBytes(msg.info.cdrom));
                info("Disks opened directly on OPFS (" + parts.join(", ") + "). Booting…");
                break;
            }
            case "log": console.log(msg.message); break;
            case "ready":
                info("VM running. Click the screen to capture the mouse.");
                if (pendingState) { const f = pendingState; pendingState = null; updateStateFileStatus(); doLoadState(f); }
                break;
            case "run_state":
                if (vm === "busy") { lastRunState = msg.running ? "running" : "paused"; break; }
                if (msg.running) setVm("running");
                else if (vm === "running" || vm === "starting") { setVm("paused"); }
                if (!msg.running) { releasePointer(); el.stats.textContent = ""; }
                break;
            case "paused": info("Paused. Disk flushed to storage."); break;
            case "resumed": info("Resumed."); break;
            case "stats": el.stats.textContent = `~${msg.mips.toFixed(1)} MIPS`; break;
            case "screen_size": applyScreenSize(msg.width, msg.height); break;
            case "state_begin": if (saveSession) saveSession.begin(msg.size); break;
            case "state_chunk": if (saveSession) saveSession.chunk(msg); break;
            case "state_end": if (saveSession) saveSession.resolve(); break;
            case "state_failed": if (saveSession) saveSession.reject(new Error(msg.message)); break;
            case "state_loaded": if (loadWaiter) loadWaiter.resolve(msg); break;
            case "state_load_failed": if (loadWaiter) loadWaiter.reject(new Error(msg.message)); break;
            case "error":
                if (msg.where === "init") {
                    err("Failed to start the VM: " + msg.message);
                    killWorker();
                    setVm("idle");
                    refreshDrives();
                } else if (msg.where === "disk") {
                    err("Disk problem: " + msg.message);
                } else if (msg.where !== "save_state" && msg.where !== "load_state") {
                    err(`Error (${msg.where}): ${msg.message}`);
                }
                break;
            case "destroyed":
                if (destroyWaiter) destroyWaiter();
                break;
        }
    }

    function applyScreenSize(width, height) {
        if (!canvasEl) return;
        const dpr = window.devicePixelRatio || 1;
        const scale = (width <= 640 && width * 2 < innerWidth * dpr && height * 2 < innerHeight * dpr) ? 2 : 1;
        canvasEl.style.width = (width * scale / (dpr > 1 && scale === 1 ? 1 : 1)) + "px";
        canvasEl.style.aspectRatio = `${width} / ${height}`;
        canvasEl.classList.toggle("upscaled", scale > 1);
    }

    /* ----------------------------------------------------------------- *
     * Play / Pause / Resume
     * ----------------------------------------------------------------- */
    function onPlayPause() {
        if (vm === "idle") {
            startVM();
        } else if (vm === "running") {
            worker.postMessage({ type: "pause" });
        } else if (vm === "paused") {
            worker.postMessage({ type: "resume" });
        }
    }

    /* ----------------------------------------------------------------- *
     * Switch drive / restart
     * ----------------------------------------------------------------- */
    async function switchDrive() {
        // 1. stop execution and cleanly destroy the current worker (closes the OPFS sync handles)
        setVm("busy");
        info("Stopping the VM…");
        await destroyWorker();
        el.stats.textContent = "";

        // 2 + 3. prompt for the new image (showOpenFilePicker) and request readwrite permission
        let picked;
        try {
            picked = await pickDiskFile();
        } catch (e) {
            await afterSwitchAbort(e, "Drive switch cancelled. The VM is stopped - press Play to boot the existing disk, or switch again.");
            return;
        }

        // 4. stream the file into OPFS (active_disk.img etc.) chunk by chunk
        const slot = slotFor(picked.file);
        try {
            const res = await mirrorToOpfs(slot, picked.file);
            hideProgress();
            await refreshDrives();
            info(res.copied ? `Copied ${picked.file.name} into browser storage. Starting…` : "Using the existing copy. Starting…");
        } catch (e) {
            hideProgress();
            await afterSwitchAbort(e, "Copy cancelled. The previous disk (if any) is untouched. Press Play to boot it.");
            return;
        }

        // 5. spawn a fresh worker and a fresh v86 instance on the new disk
        pendingState = null;
        updateStateFileStatus();
        await startVM();
    }

    async function afterSwitchAbort(e, cancelMsg) {
        if (isAbort(e)) info(cancelMsg);
        else if (e && (e.name === "SecurityError" || e.name === "NotAllowedError")) {
            err("The browser blocked the file picker (it needs a fresh click). Click \"Switch Drive / Restart\" again.");
        } else err((e && e.message) || String(e));
        await refreshDrives();
        setVm("idle");
    }

    // Upload into a slot without the picker-driven restart dance: idle VMs stay idle so several
    // drives can be loaded before pressing Play; a running VM is restarted on the new disk.
    async function uploadDisk(forcedSlot, droppedFile) {
        if (vm === "busy" || vm === "starting") return;
        if (checkSupport().length) { err("This browser cannot run the zero-heap disk mode (see the notice above)."); return; }
        let picked;
        if (droppedFile) picked = { file: droppedFile, handle: null };
        else {
            try { picked = await pickDiskFile(); } catch (e) {
                if (!isAbort(e)) err("Could not open the file: " + ((e && e.message) || e));
                return;
            }
        }
        const wasActive = vm === "running" || vm === "paused";
        if (wasActive && !confirm(`Uploading "${picked.file.name}" restarts the running VM. Continue?`)) return;

        setVm("busy");
        if (wasActive) {
            info("Stopping the VM…");
            await destroyWorker();
            el.stats.textContent = "";
        }
        const slot = forcedSlot || slotFor(picked.file);
        try {
            const res = await mirrorToOpfs(slot, picked.file);
            hideProgress();
            await refreshDrives();
            if (res.copied) info(`Copied ${picked.file.name} into ${SLOT_LABELS[slot]}.`);
        } catch (e) {
            hideProgress();
            await afterSwitchAbort(e, "Copy cancelled. The previous disk (if any) is untouched.");
            return;
        }
        if (wasActive) {
            pendingState = null;
            updateStateFileStatus();
            await startVM();
        } else {
            setVm("idle");
            info(`${picked.file.name} is ready in ${SLOT_LABELS[slot]}. Press Play to boot.`);
        }
    }

    function setupDrop(target) {
        let depth = 0;
        const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
        target.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; el.drop.classList.add("over"); });
        target.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
        target.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; el.drop.classList.remove("over"); } });
        target.addEventListener("drop", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            el.drop.classList.remove("over");
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            if (f) uploadDisk(null, f);         // a dropped File is lazy, so it still streams from disk
        });
    }

    async function restartSame() {
        setVm("busy");
        info("Restarting VM…");
        await destroyWorker();
        el.stats.textContent = "";
        await startVM();
    }

    /* ----------------------------------------------------------------- *
     * Save State  (stream chunks straight into a FileSystemFileHandle writable)
     * ----------------------------------------------------------------- */
    async function openStateSink() {
        if (caps.savePicker) {
            const handle = await window.showSaveFilePicker({
                suggestedName: "vm_state.bin",
                types: [{ description: "v86 state (.bin)", accept: { "application/octet-stream": [".bin"] } }],
            });
            const writable = await handle.createWritable();
            return {
                write: (c) => writable.write(c),
                close: async () => { await writable.close(); return handle.name; },
                abort: async () => { try { await writable.abort(); } catch (e) { /* ignore */ } },
            };
        }
        // Fallback (no showSaveFilePicker): spool to a temporary OPFS file, then hand it to a normal download.
        const root = await opfsRoot();
        try { await root.removeEntry(STATE_TMP_NAME); } catch (e) { /* none */ }
        const fh = await root.getFileHandle(STATE_TMP_NAME, { create: true });
        const writable = await fh.createWritable();
        return {
            write: (c) => writable.write(c),
            close: async () => {
                await writable.close();
                const file = await fh.getFile();             // disk-backed File, not a heap copy
                const url = URL.createObjectURL(file);
                const a = document.createElement("a");
                a.href = url; a.download = "vm_state.bin";
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(async () => { URL.revokeObjectURL(url); try { await root.removeEntry(STATE_TMP_NAME); } catch (e) { /* ignore */ } }, 120000);
                return "vm_state.bin";
            },
            abort: async () => { try { await writable.abort(); } catch (e) { /* ignore */ } try { await root.removeEntry(STATE_TMP_NAME); } catch (e) { /* ignore */ } },
        };
    }

    async function saveState() {
        if (vm !== "running" && vm !== "paused") return;

        // The picker must be the first thing awaited so it still has the user's click activation.
        let sink;
        try { sink = await openStateSink(); } catch (e) {
            if (isAbort(e)) { info("Save cancelled."); return; }
            err("Could not open the save file: " + e.message);
            return;
        }

        const w = worker;
        const prev = vm;
        lastRunState = prev;
        setVm("busy");
        showProgress("Saving state…", null);

        let chain = Promise.resolve();
        const session = {};
        const done = new Promise((resolve, reject) => { session.resolve = resolve; session.reject = reject; });
        let written = 0;
        session.begin = () => {};
        session.chunk = (msg) => {
            const chunk = msg.chunk;
            chain = chain.then(async () => {
                await sink.write(chunk);                  // streams into the user's file
                written += chunk.byteLength;
                showProgress(`Saving state: ${fmtBytes(written)} / ${fmtBytes(msg.size)}`, msg.size ? written / msg.size : 1);
                w.postMessage({ type: "state_ack" });
            }).catch((e) => {
                w.postMessage({ type: "state_abort", message: e.message });
                session.reject(e);
            });
        };
        saveSession = session;
        w.postMessage({ type: "save_state" });

        try {
            await done;
            await chain;
            const name = await sink.close();
            info(`State saved to ${name} (${fmtBytes(written)}). Note: it does not contain the disk - load it only on the same disk contents.`);
        } catch (e) {
            await sink.abort();
            err("Saving the state failed: " + e.message);
        } finally {
            sink = null;                               // drop references so memory can be reclaimed right away
            saveSession = null;
            hideProgress();
            if (worker === w) setVm(lastRunState === "running" ? "running" : "paused");
        }
    }

    /* ----------------------------------------------------------------- *
     * Load State
     * ----------------------------------------------------------------- */
    async function loadState() {
        let picked;
        try { picked = await pickStateFile(); } catch (e) {
            if (isAbort(e)) return;
            err("Could not open the state file: " + e.message);
            return;
        }
        if (vm === "idle") {
            // Not started yet: remember the (lazy) File and restore it as soon as the VM is ready.
            pendingState = picked.file;
            updateStateFileStatus();
            info(`State "${picked.file.name}" will be restored when the VM starts. Press Play.`);
            return;
        }
        await doLoadState(picked.file);
    }

    async function doLoadState(file) {
        if (vm !== "running" && vm !== "paused" && vm !== "starting") return;
        const w = worker;
        const prev = vm === "starting" ? "running" : vm;
        lastRunState = prev;
        const wasStarting = vm === "starting";
        if (!wasStarting) setVm("busy");
        showProgress(`Restoring state ${file.name} (${fmtBytes(file.size)})…`, null);
        const p = new Promise((resolve, reject) => { loadWaiter = { resolve, reject }; });
        w.postMessage({ type: "load_state", file });
        try {
            await p;
            info(`State restored from ${file.name}.`);
        } catch (e) {
            err("Restoring the state failed: " + e.message + " (state files must match the RAM size and disk they were saved with).");
        } finally {
            loadWaiter = null;
            hideProgress();
            if (!wasStarting && worker === w) setVm(lastRunState === "paused" ? "paused" : "running");
        }
    }

    function updateStateFileStatus() {
        el.stateFile.textContent = pendingState ? `State ready to load on start: ${pendingState.name}` : "";
    }

    /* ----------------------------------------------------------------- *
     * input forwarding (keyboard / mouse)
     * ----------------------------------------------------------------- */
    const pressed = Object.create(null);

    function emitScancode(codes, sc, down) {
        const v = down ? sc : (sc | 0x80);
        if (v > 0xff) { codes.push(v >> 8, v & 0xff); } else codes.push(v);
    }

    function keyPress(codes, sc, down, repeat) {
        if (down) { if (pressed[sc] && !repeat) keyPress(codes, sc, false); }
        else if (!pressed[sc]) return;
        pressed[sc] = down;
        emitScancode(codes, sc, down);
    }

    function releaseAllKeys() {
        if (!worker) { for (const k in pressed) delete pressed[k]; return; }
        const codes = [];
        for (const k of Object.keys(pressed)) if (pressed[k]) emitScancode(codes, +k, false);
        for (const k in pressed) delete pressed[k];
        if (codes.length) worker.postMessage({ type: "key", codes });
    }

    function onKey(e, down) {
        if (vm !== "running" || !keyboardCaptured || !worker) return;
        const t = e.target;
        if (t && (t.nodeName === "INPUT" || t.nodeName === "TEXTAREA" || t.nodeName === "SELECT")) return;
        if (e.code === "" || e.key === "Process" || e.key === "Unidentified" || e.keyCode === 229) return;
        // Browser/devtools shortcuts the user surely wants to keep
        if (e.shiftKey && e.ctrlKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 75)) return;

        e.preventDefault();
        const codes = [];
        if (!e.altKey && pressed[56]) keyPress(codes, 56, false);   // Alt released while the tab lost focus
        let sc = CODE_TO_SCANCODE[e.code];
        if (sc === undefined) sc = KEYCODE_TO_SCANCODE[e.keyCode];
        if (sc) keyPress(codes, sc, down, e.repeat);
        if (codes.length) worker.postMessage({ type: "key", codes });
    }

    document.addEventListener("keydown", (e) => {
        // Ctrl+Alt releases the mouse; Ctrl+Alt+Shift releases the keyboard
        if (e.ctrlKey && e.altKey && e.shiftKey && keyboardCaptured && vm === "running") {
            e.preventDefault();
            toggleKeyboard();
            return;
        }
        if (e.ctrlKey && e.altKey && !e.shiftKey && mouseLocked) {
            e.preventDefault();
            document.exitPointerLock();
            return;
        }
        onKey(e, true);
    }, true);
    document.addEventListener("keyup", (e) => onKey(e, false), true);
    window.addEventListener("blur", releaseAllKeys);

    // Mouse: pointer lock on the screen container; deltas are coalesced to one message per frame.
    let mdx = 0, mdy = 0, mouseRaf = 0;
    const buttons = [false, false, false];

    function flushMouse() {
        mouseRaf = 0;
        if (!worker || (!mdx && !mdy)) return;
        worker.postMessage({ type: "mouse_delta", dx: mdx, dy: mdy });
        mdx = mdy = 0;
    }
    document.addEventListener("mousemove", (e) => {
        if (!mouseLocked || vm !== "running") return;
        mdx += e.movementX || 0;
        mdy += e.movementY || 0;
        if (!mouseRaf) mouseRaf = requestAnimationFrame(flushMouse);
    });
    function mouseButton(e, down) {
        if (!mouseLocked || vm !== "running" || !worker) return;
        const i = e.button === 0 ? 0 : e.button === 1 ? 1 : e.button === 2 ? 2 : -1;
        if (i < 0) return;
        buttons[i] = down;
        worker.postMessage({ type: "mouse_click", left: buttons[0], middle: buttons[1], right: buttons[2] });
        e.preventDefault();
    }
    document.addEventListener("mousedown", (e) => mouseButton(e, true), true);
    document.addEventListener("mouseup", (e) => mouseButton(e, false), true);
    el.screenWrap.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("wheel", (e) => {
        if (!mouseLocked || vm !== "running" || !worker) return;
        e.preventDefault();
        worker.postMessage({ type: "mouse_wheel", dir: e.deltaY < 0 ? 1 : -1 });
    }, { passive: false });

    document.addEventListener("pointerlockchange", () => {
        mouseLocked = document.pointerLockElement === el.screenWrap;
        if (!mouseLocked && (buttons[0] || buttons[1] || buttons[2]) && worker) {
            buttons[0] = buttons[1] = buttons[2] = false;
            worker.postMessage({ type: "mouse_click", left: false, middle: false, right: false });
        }
        if (mouseLocked) info("Mouse captured - press Ctrl+Alt to release.");
        updateCaptureUI();
    });
    function releasePointer() { if (document.pointerLockElement) document.exitPointerLock(); }
    async function lockPointer() {
        if (vm !== "running") return;
        try { await el.screenWrap.requestPointerLock({ unadjustedMovement: true }); }
        catch (e) { try { await el.screenWrap.requestPointerLock(); } catch (e2) { err("Could not capture the mouse: " + e2.message); } }
    }
    el.screenWrap.addEventListener("click", () => { if (!mouseLocked) lockPointer(); });

    function toggleKeyboard() {
        keyboardCaptured = !keyboardCaptured;
        if (!keyboardCaptured) releaseAllKeys();
        info(keyboardCaptured ? "Keyboard captured - press Ctrl+Alt+Shift to release." : "Keyboard released.");
        updateCaptureUI();
    }

    /* ----------------------------------------------------------------- *
     * special keys menu
     * ----------------------------------------------------------------- */
    const R = 0x80;
    const SPECIAL_KEYS = [
        ["System Keys", [
            ["Ctrl+Alt+Delete", "System interrupt", [0x1d, 0x38, 0x53, 0x53 | R, 0x38 | R, 0x1d | R]],
            ["Ctrl+Alt+End", "Secure attention", [0x1d, 0x38, 0xe0, 0x4f, 0xe0, 0x4f | R, 0x38 | R, 0x1d | R]],
            ["Ctrl+Shift+Esc", "Task manager", [0x1d, 0x2a, 0x01, 0x01 | R, 0x2a | R, 0x1d | R]],
        ]],
        ["Function Keys", [
            ["F1", "Help", [0x3b, 0x3b | R]], ["F2", "Rename", [0x3c, 0x3c | R]], ["F3", "Search", [0x3d, 0x3d | R]],
            ["F4", "Address bar", [0x3e, 0x3e | R]], ["F5", "Refresh", [0x3f, 0x3f | R]], ["F6", "Navigate", [0x40, 0x40 | R]],
            ["F7", "Spell check", [0x41, 0x41 | R]], ["F8", "Boot options", [0x42, 0x42 | R]], ["F9", "Send/Receive", [0x43, 0x43 | R]],
            ["F10", "Menu bar", [0x44, 0x44 | R]], ["F11", "Fullscreen", [0x57, 0x57 | R]], ["F12", "Save as", [0x58, 0x58 | R]],
        ]],
        ["Navigation Keys", [
            ["Alt+Tab", "Switch windows", [0x38, 0x0f, 0x0f | R, 0x38 | R]],
            ["Alt+F4", "Close window", [0x38, 0x3e, 0x3e | R, 0x38 | R]],
            ["Windows Key", "Start menu", [0xe0, 0x5b, 0xe0, 0x5b | R]],
            ["Menu Key", "Context menu", [0xe0, 0x5d, 0xe0, 0x5d | R]],
        ]],
        ["Special Characters", [
            ["Print Screen", "Screenshot", [0xe0, 0x2a, 0xe0, 0x37, 0xe0, 0x37 | R, 0xe0, 0x2a | R]],
            ["Scroll Lock", "Scroll mode", [0x46, 0x46 | R]],
            ["Pause/Break", "System pause", [0xe1, 0x1d, 0x45, 0xe1, 0x9d, 0xc5]],
            ["Insert", "Insert mode", [0xe0, 0x52, 0xe0, 0x52 | R]],
        ]],
    ];

    function buildKeysMenu() {
        for (const [cat, items] of SPECIAL_KEYS) {
            const h = document.createElement("div");
            h.className = "key-category";
            h.textContent = cat;
            el.keysMenu.appendChild(h);
            for (const [name, desc, codes] of items) {
                const d = document.createElement("div");
                d.className = "key-item";
                d.innerHTML = '<span class="key-name"></span><span class="key-description"></span>';
                d.firstChild.textContent = name;
                d.lastChild.textContent = desc;
                d.addEventListener("click", () => { hideKeysMenu(); sendKeySequence(codes); });
                el.keysMenu.appendChild(d);
            }
        }
    }
    async function sendKeySequence(codes) {
        if (!worker || vm !== "running") return;
        // 10 ms between scancodes, like the original page, so guests do not drop them
        for (const c of codes) { worker.postMessage({ type: "key", codes: [c] }); await sleep(10); }
    }
    function hideKeysMenu() { el.keysMenu.classList.remove("show"); }

    /* ----------------------------------------------------------------- *
     * fullscreen + Keyboard Lock API
     * ----------------------------------------------------------------- */
    const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
    let keyboardLocked = false;

    async function enterFullscreen() {
        const req = el.stage.requestFullscreen || el.stage.webkitRequestFullscreen;
        if (!req) { err("Fullscreen is not supported in this browser."); return; }
        try { await req.call(el.stage, { navigationUI: "hide" }); } catch (e) {
            err("Could not enter fullscreen: " + ((e && e.message) || e));
            return;
        }
        // Keyboard Lock routes Esc, Alt+Tab, the Windows key etc. to the page (Chromium only, fullscreen only).
        keyboardLocked = false;
        if (navigator.keyboard && typeof navigator.keyboard.lock === "function") {
            try { await navigator.keyboard.lock(); keyboardLocked = true; } catch (e) { /* not allowed here */ }
        }
        if (!keyboardCaptured) toggleKeyboard();
        info(keyboardLocked
            ? "Fullscreen with keyboard lock: system keys go to the VM. Hold Esc to exit."
            : "Fullscreen (keyboard lock is not available in this browser, so Esc exits fullscreen).");
        if (vm === "running" && !mouseLocked) {
            try { await el.screenWrap.requestPointerLock(); } catch (e) { /* the user can click the screen */ }
        }
    }
    function exitFullscreen() {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (fsElement() && exit) exit.call(document).catch(() => {});
    }
    function onFullscreenChange() {
        const on = fsElement() === el.stage;
        if (!on && keyboardLocked) {
            try { navigator.keyboard.unlock(); } catch (e) { /* ignore */ }
            keyboardLocked = false;
        }
        el.fsBtn.classList.toggle("active", on);
        el.fsBtn.lastChild.textContent = on ? " Exit Fullscreen" : " Fullscreen";
        if (on) flashFsBar();
    }
    let fsBarTimer = 0;
    function flashFsBar() {
        el.fsBar.classList.add("show");
        clearTimeout(fsBarTimer);
        fsBarTimer = setTimeout(() => el.fsBar.classList.remove("show"), 2500);
    }

    /* ----------------------------------------------------------------- *
     * wiring
     * ----------------------------------------------------------------- */
    function probeSyncHandle() {
        return new Promise((resolve) => {
            try {
                const url = URL.createObjectURL(new Blob(['postMessage(typeof FileSystemFileHandle!=="undefined"&&"createSyncAccessHandle" in FileSystemFileHandle.prototype)'], { type: "text/javascript" }));
                const w = new Worker(url);
                const done = (v) => { w.terminate(); URL.revokeObjectURL(url); resolve(v); };
                w.onmessage = (e) => done(!!e.data);
                w.onerror = () => done(null);
            } catch (e) { resolve(null); }
        });
    }

    async function init() {
        if (caps.opfs && caps.worker) caps.syncHandle = await probeSyncHandle();
        const missing = checkSupport();
        if (missing.length) {
            el.banner.hidden = false;
            el.banner.className = "banner error";
            el.banner.textContent = "This browser cannot run the zero-heap disk mode. Missing: " + missing.join("; ") +
                ". Use a recent Chrome / Edge / Firefox / Safari 17+ over https or localhost.";
        } else if (!caps.openPicker || !caps.savePicker) {
            el.banner.hidden = false;
            el.banner.className = "banner warn";
            el.banner.textContent = "File System Access pickers are not available here" +
                (!caps.openPicker ? " - a standard file chooser is used for opening files" : "") +
                (!caps.savePicker ? " - saved states are spooled through browser storage and downloaded" : "") +
                ". Disk images still stream into OPFS without being loaded into memory.";
        }

        loadSettings();
        updateRamHint();
        buildKeysMenu();
        el.ram.addEventListener("input", () => { updateRamHint(); });
        el.ramPresets.addEventListener("click", (e) => {
            const mb = e.target && e.target.dataset && e.target.dataset.mb;
            if (!mb) return;
            el.ram.value = mb;
            updateRamHint();
            saveSettings();
        });
        for (const c of [el.ram, el.vram, el.winnt, el.boot, el.flush]) c.addEventListener("change", saveSettings);

        el.play.addEventListener("click", onPlayPause);
        el.save.addEventListener("click", saveState);
        el.load.addEventListener("click", loadState);
        el.sw.addEventListener("click", switchDrive);
        el.restart.addEventListener("click", restartSame);
        el.upload.addEventListener("click", () => uploadDisk(el.slotSelect.value === "auto" ? null : el.slotSelect.value));
        setupDrop(el.drop);
        setupDrop(el.stage);
        el.fsBtn.addEventListener("click", () => { fsElement() ? exitFullscreen() : enterFullscreen(); });
        el.fsExit.addEventListener("click", exitFullscreen);
        el.fsPause.addEventListener("click", onPlayPause);
        el.fsCad.addEventListener("click", () => sendKeySequence(SPECIAL_KEYS[0][1][0][2]));
        document.addEventListener("fullscreenchange", onFullscreenChange);
        document.addEventListener("webkitfullscreenchange", onFullscreenChange);
        el.stage.addEventListener("mousemove", (e) => { if (fsElement() && !mouseLocked && e.clientY < 70) flashFsBar(); });
        el.cancel.addEventListener("click", () => { if (busyAbort) busyAbort.abort(); });
        el.mouseBtn.addEventListener("click", () => { mouseLocked ? releasePointer() : lockPointer(); });
        el.kbdBtn.addEventListener("click", toggleKeyboard);
        el.keysBtn.addEventListener("click", (e) => { e.stopPropagation(); el.keysMenu.classList.toggle("show"); });
        document.addEventListener("click", (e) => { if (!el.keysMenu.contains(e.target)) hideKeysMenu(); });

        // Make sure buffered disk writes hit storage when the tab is hidden or closed.
        const flush = () => { if (worker) worker.postMessage({ type: "flush" }); };
        document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
        window.addEventListener("pagehide", flush);

        await refreshDrives();
        updateButtons();
        const has = (await opfsSize("hda")) != null || (await opfsSize("cdrom")) != null;
        info(has ? "A disk is already stored in this browser. Press Play to boot it, or Switch Drive to use another image."
                 : "Upload a .img or .iso to begin.");
    }

    init().catch((e) => err("Initialisation failed: " + e.message));

    // exposed for automated tests
    window.__v86opfs = { dbg: () => worker.postMessage({ type: "debug_text" }), get vm() { return vm; }, startVM, mirrorToOpfs, refreshDrives, doLoadState };
})();
