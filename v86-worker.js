"use strict";
/*
 * v86-worker.js  -  runs the whole v86 emulator inside a Dedicated Web Worker.
 *
 * Disk I/O goes straight to the Origin Private File System through
 * FileSystemSyncAccessHandle: the disk image is NEVER loaded into a JS heap
 * ArrayBuffer. Every read()/write() the guest issues is turned into a
 * syncAccessHandle.read()/write() at the byte offset (sector * 512) using one
 * small, reused scratch Uint8Array.
 *
 * Message protocol (main -> worker):
 *   init        {base, canvas, config}   open OPFS files, create V86
 *   pause                                emulator.stop()
 *   resume                               emulator.run()
 *   save_state                           serialise state, stream chunks to main
 *   state_ack / state_abort              flow control for save_state
 *   load_state  {file}                   restore a .bin state
 *   key         {codes}                  PS/2 scancodes
 *   mouse_delta / mouse_click / mouse_wheel
 *   flush                                flush all disks now
 *   destroy                              stop CPU, flush, close handles
 *
 * Messages (worker -> main):
 *   ready, run_state, screen_size, stats, paused, resumed,
 *   state_begin, state_chunk, state_end, state_loaded,
 *   destroyed, error, log, disk_info
 */

const SECTOR = 512;
const SCRATCH_BYTES = 256 * 1024;     // fixed read scratch; covers the biggest normal IDE transfer
const STATE_CHUNK_BYTES = 4 * 1024 * 1024;

importScripts("build/libv86.js", "worker-screen.js");

let emulator = null;
let screen = null;
let disks = [];                 // OpfsDisk instances (closed on destroy)
let statsTimer = 0;
let lastInstr = 0, lastStatsTime = 0;
let running = false;
let destroying = false;
let ackResolver = null;

function post(msg, transfer) {
    self.postMessage(msg, transfer || []);
}

function fail(where, err) {
    const message = err && err.message ? err.message : String(err);
    post({ type: "error", where, name: err && err.name, message });
}

self.addEventListener("error", (e) => fail("worker", e.error || e.message));
self.addEventListener("unhandledrejection", (e) => fail("worker", e.reason));

/* ------------------------------------------------------------------------- *
 * OPFS-backed disk exposing the buffer interface v86 expects
 * (load / get / set / byteLength / get_state / set_state / get_buffer).
 * ------------------------------------------------------------------------- */
class OpfsDisk {
    constructor(name, accessHandle, { readOnly = false, flushMs = 250 } = {}) {
        this.name = name;
        this.handle = accessHandle;
        this.readOnly = readOnly;
        this.flushMs = flushMs;          // 0 = flush after every write
        this.byteLength = accessHandle.getSize();
        this.scratch = new Uint8Array(SCRATCH_BYTES);
        this.onload = undefined;
        this.onprogress = undefined;
        this.closed = false;
        this.dirty = false;
        this.flushTimer = 0;
        this.firstDirtyAt = 0;
        this.error = null;
    }

    load() {
        if (this.onload) this.onload(Object.create(null));
    }

    // v86 contract: call cb(Uint8Array) synchronously-or-later. The callers copy the
    // data out immediately, which lets us hand back a view of the single scratch buffer.
    get(offset, length, cb) {
        if (this.closed) { cb(new Uint8Array(length)); return; }
        const buf = length <= this.scratch.length
            ? this.scratch.subarray(0, length)
            : new Uint8Array(length);       // rare oversized request: one-off allocation
        let read = 0;
        try {
            read = this.handle.read(buf, { at: offset });
        } catch (e) {
            this._ioError("read", e);
        }
        if (read < length) buf.fill(0, read, length);   // past EOF / failed read reads as zeroes
        cb(buf);
    }

    set(offset, data, cb) {
        if (this.closed || this.readOnly) { cb(); return; }
        try {
            const written = this.handle.write(data, { at: offset });
            if (written !== data.byteLength) {
                throw new Error(`short write (${written}/${data.byteLength} bytes at ${offset})`);
            }
            this._markDirty();
        } catch (e) {
            this._ioError("write", e);
        }
        cb();
    }

    _ioError(op, e) {
        // Report once per distinct message so a failing disk does not flood the main thread.
        const msg = `${this.name}: ${op} failed: ${e && e.message ? e.message : e}`;
        if (this.error !== msg) {
            this.error = msg;
            post({ type: "error", where: "disk", name: e && e.name, message: msg });
        }
    }

    _markDirty() {
        if (this.flushMs <= 0) { this.flush(); return; }
        const now = performance.now();
        if (!this.dirty) { this.dirty = true; this.firstDirtyAt = now; }
        // Debounce: flush 'flushMs' after the last write, but never later than 4x that
        // after the first un-flushed write, so a busy guest cannot starve the flush.
        if (this.flushTimer) clearTimeout(this.flushTimer);
        const maxWait = this.flushMs * 4 - (now - this.firstDirtyAt);
        this.flushTimer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.flushMs, maxWait)));
    }

    flush() {
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = 0; }
        if (this.closed || this.readOnly) return;
        try {
            this.handle.flush();
            this.dirty = false;
        } catch (e) {
            this._ioError("flush", e);
        }
    }

    close() {
        if (this.closed) return;
        this.flush();
        this.closed = true;
        try { this.handle.close(); } catch (e) { /* already closed */ }
    }

    // The disk image lives in OPFS and is not part of save states (keeps states small).
    get_buffer(cb) { cb(); }
    get_state() { return []; }
    set_state() {}
}

async function openDisk(root, fileName, opts) {
    const fileHandle = await root.getFileHandle(fileName);
    let access;
    try {
        access = await fileHandle.createSyncAccessHandle();
    } catch (e) {
        if (e && (e.name === "NoModificationAllowedError" || /locked|in use/i.test(e.message || ""))) {
            throw new Error(`"${fileName}" is already open in another tab or window. Close the other emulator tab and try again.`);
        }
        throw e;
    }
    const disk = new OpfsDisk(fileName, access, opts);
    disks.push(disk);
    return disk;
}

/* ------------------------------------------------------------------------- *
 * init
 * ------------------------------------------------------------------------- */
const BOOT_ORDERS = {
    "hda-first": 0x213,
    "cdrom-first": 0x123,
    "hda-only": 0x200,
    "cdrom-only": 0x100,
};

async function init({ base, canvas, config }) {
    if (emulator) throw new Error("emulator already initialised");
    destroying = false;

    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error("OPFS is not available in this browser");
    const root = await navigator.storage.getDirectory();

    const flushMs = config.flushMs;
    const diskOpts = { flushMs };

    const opts = {
        wasm_path: base + "build/v86.wasm",
        bios: { url: base + "build/seabios.bin" },
        vga_bios: { url: base + "build/vgabios.bin" },
        memory_size: config.ramMB * 1024 * 1024,
        vga_memory_size: config.vramMB * 1024 * 1024,
        boot_order: BOOT_ORDERS[config.bootOrder] || BOOT_ORDERS["hda-first"],
        autostart: true,
        // Input and audio adapters need the DOM; input is forwarded from the main thread instead.
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
    };
    if (config.winnt) {
        opts.cpuid_level = 2;
        opts.acpi = false;
    }

    const info = {};
    if (config.hda) {
        opts.hda = await openDisk(root, config.hda, diskOpts);
        info.hda = opts.hda.byteLength;
    }
    if (config.hdb) {
        opts.hdb = await openDisk(root, config.hdb, diskOpts);
        info.hdb = opts.hdb.byteLength;
    }
    if (config.cdrom) {
        opts.cdrom = await openDisk(root, config.cdrom, { flushMs, readOnly: true });
        info.cdrom = opts.cdrom.byteLength;
    }
    post({ type: "disk_info", info });

    screen = new WorkerScreenAdapter(canvas, (w, h) => post({ type: "screen_size", width: w, height: h }));

    emulator = new V86(opts);
    // v86 created a headless dummy adapter; swap in the canvas one before wasm finishes loading.
    // v86 builds its headless dummy adapter later (inside continue_init), so pin ours with an accessor.
    Object.defineProperty(emulator, "screen_adapter", { get: () => screen, set: () => {}, configurable: true });
    screen.screen_fill_buffer = () => {
        const vga = emulator && emulator.v86 && emulator.v86.cpu && emulator.v86.cpu.devices && emulator.v86.cpu.devices.vga;
        if (vga) vga.screen_fill_buffer();
    };

    emulator.add_listener("emulator-ready", () => post({ type: "ready" }));
    emulator.add_listener("emulator-started", () => { running = true; post({ type: "run_state", running: true }); startStats(); });
    emulator.add_listener("emulator-stopped", () => { running = false; post({ type: "run_state", running: false }); stopStats(); });
    emulator.add_listener("download-progress", (e) => post({ type: "log", message: `Loading ${e.file_name || "file"}…` }));
}

/* ------------------------------------------------------------------------- *
 * stats (rough MIPS indicator)
 * ------------------------------------------------------------------------- */
function startStats() {
    stopStats();
    lastInstr = emulator ? emulator.get_instruction_counter() : 0;
    lastStatsTime = performance.now();
    statsTimer = setInterval(() => {
        if (!emulator) return;
        const now = performance.now();
        const instr = emulator.get_instruction_counter();
        const mips = ((instr - lastInstr) >>> 0) / ((now - lastStatsTime) * 1000);
        lastInstr = instr;
        lastStatsTime = now;
        post({ type: "stats", mips });
    }, 1000);
}
function stopStats() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = 0; }
}

/* ------------------------------------------------------------------------- *
 * control
 * ------------------------------------------------------------------------- */
function flushAll() {
    for (const d of disks) d.flush();
}

async function pause() {
    if (!emulator) return;
    await emulator.stop();          // resolves once the CPU loop really stopped
    flushAll();
    post({ type: "paused" });
}

async function resume() {
    if (!emulator) return;
    emulator.run();
    post({ type: "resumed" });
}

/**
 * Serialise the VM and stream it to the main thread in fixed-size chunks.
 * The main thread writes each chunk to the user's FileSystemFileHandle and
 * acknowledges it, so at most one chunk is in flight (plus v86's own state buffer,
 * which is dropped as soon as the last chunk is out).
 */
async function saveState() {
    if (!emulator) throw new Error("no emulator running");
    const wasRunning = running;
    if (wasRunning) await emulator.stop();
    flushAll();

    let buffer = null;
    try {
        buffer = await emulator.save_state();
        const total = buffer.byteLength;
        post({ type: "state_begin", size: total });

        for (let off = 0; off < total; off += STATE_CHUNK_BYTES) {
            const end = Math.min(off + STATE_CHUNK_BYTES, total);
            const chunk = buffer.slice(off, end);           // small copy, transferred (zero-copy) to main
            const ack = new Promise((resolve, reject) => { ackResolver = { resolve, reject }; });
            post({ type: "state_chunk", chunk, offset: off, size: total }, [chunk]);
            await ack;                                      // backpressure; rejects on state_abort
        }
        post({ type: "state_end", size: total });
    } catch (e) {
        post({ type: "state_failed", message: e && e.message ? e.message : String(e) });
    } finally {
        buffer = null;                  // drop the reference so the big buffer can be collected now
        ackResolver = null;
        if (wasRunning && emulator && !destroying) emulator.run();
    }
}

async function loadState(file) {
    if (!emulator) throw new Error("no emulator running");
    const wasRunning = running;
    if (wasRunning) await emulator.stop();
    flushAll();

    let buffer = null;
    try {
        buffer = await file.arrayBuffer();      // v86 needs the full state in memory; released right after
        await emulator.restore_state(buffer);
        post({ type: "state_loaded", name: file.name, size: file.size });
    } catch (e) {
        post({ type: "state_load_failed", message: e && e.message ? e.message : String(e) });
    } finally {
        buffer = null;
        if (wasRunning && emulator && !destroying) emulator.run();
    }
}

async function destroy() {
    destroying = true;
    stopStats();
    if (ackResolver) { ackResolver.reject(new Error("destroyed")); ackResolver = null; }
    try {
        if (emulator) {
            await emulator.destroy();      // stops the CPU loop, tears down adapters
        }
    } catch (e) {
        /* keep going: we must release the OPFS handles no matter what */
    }
    try { if (screen) screen.destroy(); } catch (e) {}
    for (const d of disks) d.close();       // flush() + syncAccessHandle.close()
    disks = [];
    emulator = null;
    screen = null;
    running = false;
    post({ type: "destroyed" });
}

/* ------------------------------------------------------------------------- *
 * input forwarded from the main thread
 * ------------------------------------------------------------------------- */
function sendInput(msg) {
    if (!emulator || !running) return;
    const bus = emulator.bus;
    switch (msg.type) {
        case "key":
            for (let i = 0; i < msg.codes.length; i++) bus.send("keyboard-code", msg.codes[i]);
            break;
        case "mouse_delta":
            bus.send("mouse-delta", [msg.dx, -msg.dy]);
            break;
        case "mouse_click":
            bus.send("mouse-click", [msg.left, msg.middle, msg.right]);
            break;
        case "mouse_wheel":
            bus.send("mouse-wheel", [msg.dir, 0]);
            break;
    }
}

/* ------------------------------------------------------------------------- *
 * message dispatch
 * ------------------------------------------------------------------------- */
self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
        switch (msg.type) {
            case "init":        await init(msg); break;
            case "pause":       await pause(); break;
            case "resume":      await resume(); break;
            case "save_state":  await saveState(); break;
            case "state_ack":   if (ackResolver) ackResolver.resolve(); break;
            case "state_abort": if (ackResolver) ackResolver.reject(new Error(msg.message || "aborted")); break;
            case "load_state":  await loadState(msg.file); break;
            case "flush":       flushAll(); break;
            case "debug_text":  post({ type: "log", message: "INSTR:" + emulator.get_instruction_counter() + " same=" + (emulator.v86.cpu.devices.vga.screen === screen) + " TEXT:" + screen.get_text_screen().slice(0, 3).join("|") }); break;
            case "destroy":     await destroy(); break;
            case "key":
            case "mouse_delta":
            case "mouse_click":
            case "mouse_wheel": sendInput(msg); break;
        }
    } catch (e) {
        fail(msg.type, e);
        if (msg.type === "init") {
            // Failed to boot: release anything we already opened so the UI can retry cleanly.
            await destroy();
        }
    }
};
