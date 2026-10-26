"use strict";
/*
 * WorkerScreenAdapter
 *
 * A DOM-free screen adapter for running v86 inside a Dedicated Web Worker.
 * It is a port of the canvas ("graphical text") code path of v86's ScreenAdapter
 * (see build/screen.js) onto an OffscreenCanvas that was transferred from the
 * main thread with canvas.transferControlToOffscreen().
 *
 *  - Graphical modes: layers are drawn with putImageData() straight onto the canvas.
 *  - Text modes: the VGA font is rasterised into an OffscreenCanvas font atlas and
 *    text is composed on a second offscreen canvas, then blitted to the display canvas.
 *
 * Nothing in here touches `document` / `window`, so it is safe in a worker.
 * Size changes are reported through `onsize(width, height)` so the main thread
 * can scale the (transferred) canvas element with CSS.
 */
(function (global) {
    const TEXT_BUF_COMPONENT_SIZE = 4;
    const CHARACTER_INDEX = 0;
    const FLAGS_INDEX = 1;
    const BG_COLOR_INDEX = 2;
    const FG_COLOR_INDEX = 3;

    const FLAG_BLINKING = 0x01;
    const FLAG_FONT_PAGE_B = 0x02;

    const MODE_GRAPHICAL = 1;
    const MODE_GRAPHICAL_TEXT = 2;

    function number_as_color(n) {
        n = n.toString(16);
        return "#" + "0".repeat(6 - n.length) + n;
    }

    /**
     * @param {OffscreenCanvas} canvas  display canvas (transferred from main thread)
     * @param {function(number, number)} onsize  called when the visible size changes
     */
    function WorkerScreenAdapter(canvas, onsize) {
        const graphic_screen = canvas;
        const graphic_context = graphic_screen.getContext("2d", { alpha: false });

        this.FLAG_BLINKING = FLAG_BLINKING;
        this.FLAG_FONT_PAGE_B = FLAG_FONT_PAGE_B;

        // Set by the worker once the emulator exists; polled every frame in graphical mode.
        this.screen_fill_buffer = function () {};

        let mode = MODE_GRAPHICAL_TEXT;

        let text_mode_data, text_mode_width = 0, text_mode_height = 0;
        let changed_rows = new Int8Array(0);

        let offscreen_context = null, offscreen_extra_context = null;

        let font_context = null, font_image_data = null;
        const font_is_visible = new Int8Array(8 * 256);
        let font_height = 16, font_width = 9;
        let font_width_9px, font_width_dbl, font_copy_8th_col;
        let font_page_a = 0, font_page_b = 0;

        let blink_visible = false;
        let tm_last_update = 0;

        let cursor_start, cursor_end, cursor_enabled, cursor_row = 0, cursor_col = 0;

        let timer_id = 0;
        let timer_is_raf = false;
        let paused = false;
        let destroyed = false;

        function render_font_bitmap(vga_bitmap) {
            const bitmap_width = font_width * 256;
            const bitmap_height = font_height * 8;

            let font_canvas = font_context ? font_context.canvas : null;
            if (!font_canvas || font_canvas.width !== bitmap_width || font_canvas.height !== bitmap_height) {
                if (!font_canvas) {
                    font_canvas = new OffscreenCanvas(bitmap_width, bitmap_height);
                    font_context = font_canvas.getContext("2d");
                } else {
                    font_canvas.width = bitmap_width;
                    font_canvas.height = bitmap_height;
                }
                font_image_data = font_context.createImageData(bitmap_width, bitmap_height);
            }

            const font_bitmap = font_image_data.data;
            let i_dst = 0, is_visible;
            const put_bit = font_width_dbl
                ? function (value) {
                    is_visible = is_visible || value;
                    font_bitmap[i_dst + 3] = value;
                    font_bitmap[i_dst + 7] = value;
                    i_dst += 8;
                }
                : function (value) {
                    is_visible = is_visible || value;
                    font_bitmap[i_dst + 3] = value;
                    i_dst += 4;
                };

            const vga_inc_chr = 32 - font_height;
            const dst_inc_row = bitmap_width * (font_height - 1) * 4;
            const dst_inc_col = (font_width - bitmap_width * font_height) * 4;
            const dst_inc_line = font_width * 255 * 4;

            for (let i_chr_all = 0, i_vga = 0; i_chr_all < 2048; ++i_chr_all, i_vga += vga_inc_chr, i_dst += dst_inc_col) {
                const i_chr = i_chr_all % 256;
                if (i_chr_all && !i_chr) {
                    i_dst += dst_inc_row;
                }
                is_visible = false;
                for (let i_line = 0; i_line < font_height; ++i_line, ++i_vga, i_dst += dst_inc_line) {
                    const line_bits = vga_bitmap[i_vga];
                    for (let i_bit = 0x80; i_bit > 0; i_bit >>= 1) {
                        put_bit(line_bits & i_bit ? 255 : 0);
                    }
                    if (font_width_9px) {
                        put_bit(font_copy_8th_col && i_chr >= 0xC0 && i_chr <= 0xDF && line_bits & 1 ? 255 : 0);
                    }
                }
                font_is_visible[i_chr_all] = is_visible ? 1 : 0;
            }

            font_context.putImageData(font_image_data, 0, 0);
        }

        function render_changed_rows() {
            const font_canvas = font_context.canvas;
            const offscreen_extra_canvas = offscreen_extra_context.canvas;
            const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
            const gfx_width = text_mode_width * font_width;
            const row_extra_1_y = 0;
            const row_extra_2_y = font_height;

            let n_rows_rendered = 0;
            for (let row_i = 0, row_y = 0, txt_i = 0; row_i < text_mode_height; ++row_i, row_y += font_height) {
                if (!changed_rows[row_i]) {
                    txt_i += txt_row_size;
                    continue;
                }
                ++n_rows_rendered;

                offscreen_extra_context.clearRect(0, row_extra_2_y, gfx_width, font_height);

                let fg_rgba, fg_x, bg_rgba, bg_x;
                for (let col_x = 0; col_x < gfx_width; col_x += font_width, txt_i += TEXT_BUF_COMPONENT_SIZE) {
                    const chr = text_mode_data[txt_i + CHARACTER_INDEX];
                    const chr_flags = text_mode_data[txt_i + FLAGS_INDEX];
                    const chr_bg_rgba = text_mode_data[txt_i + BG_COLOR_INDEX];
                    const chr_fg_rgba = text_mode_data[txt_i + FG_COLOR_INDEX];
                    const chr_font_page = chr_flags & FLAG_FONT_PAGE_B ? font_page_b : font_page_a;
                    const chr_visible = (!(chr_flags & FLAG_BLINKING) || blink_visible) &&
                        font_is_visible[(chr_font_page << 8) + chr];

                    if (bg_rgba !== chr_bg_rgba) {
                        if (bg_rgba !== undefined) {
                            offscreen_context.fillStyle = number_as_color(bg_rgba);
                            offscreen_context.fillRect(bg_x, row_y, col_x - bg_x, font_height);
                        }
                        bg_rgba = chr_bg_rgba;
                        bg_x = col_x;
                    }

                    if (fg_rgba !== chr_fg_rgba) {
                        if (fg_rgba !== undefined) {
                            offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
                            offscreen_extra_context.fillRect(fg_x, row_extra_1_y, col_x - fg_x, font_height);
                        }
                        fg_rgba = chr_fg_rgba;
                        fg_x = col_x;
                    }

                    if (chr_visible) {
                        offscreen_extra_context.drawImage(font_canvas,
                            chr * font_width, chr_font_page * font_height, font_width, font_height,
                            col_x, row_extra_2_y, font_width, font_height);
                    }
                }

                offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
                offscreen_extra_context.fillRect(fg_x, row_extra_1_y, gfx_width - fg_x, font_height);

                offscreen_extra_context.globalCompositeOperation = "destination-in";
                offscreen_extra_context.drawImage(offscreen_extra_canvas,
                    0, row_extra_2_y, gfx_width, font_height,
                    0, row_extra_1_y, gfx_width, font_height);
                offscreen_extra_context.globalCompositeOperation = "source-over";

                offscreen_context.fillStyle = number_as_color(bg_rgba);
                offscreen_context.fillRect(bg_x, row_y, gfx_width - bg_x, font_height);

                offscreen_context.drawImage(offscreen_extra_canvas,
                    0, row_extra_1_y, gfx_width, font_height,
                    0, row_y, gfx_width, font_height);
            }

            if (n_rows_rendered) {
                if (blink_visible && cursor_enabled && changed_rows[cursor_row]) {
                    const cursor_txt_i = (cursor_row * text_mode_width + cursor_col) * TEXT_BUF_COMPONENT_SIZE;
                    const cursor_rgba = text_mode_data[cursor_txt_i + FG_COLOR_INDEX];
                    offscreen_context.fillStyle = number_as_color(cursor_rgba);
                    offscreen_context.fillRect(
                        cursor_col * font_width,
                        cursor_row * font_height + cursor_start,
                        font_width,
                        cursor_end - cursor_start + 1);
                }
                changed_rows.fill(0);
            }

            return n_rows_rendered;
        }

        function mark_blinking_rows_dirty() {
            const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
            for (let row_i = 0, txt_i = 0; row_i < text_mode_height; ++row_i) {
                if (changed_rows[row_i]) {
                    txt_i += txt_row_size;
                    continue;
                }
                for (let col_i = 0; col_i < text_mode_width; ++col_i, txt_i += TEXT_BUF_COMPONENT_SIZE) {
                    if (text_mode_data[txt_i + FLAGS_INDEX] & FLAG_BLINKING) {
                        changed_rows[row_i] = 1;
                        txt_i += txt_row_size - col_i * TEXT_BUF_COMPONENT_SIZE;
                        break;
                    }
                }
            }
        }

        // ---- render loop ---------------------------------------------------

        const schedule = () => {
            if (destroyed) return;
            if (false && typeof requestAnimationFrame === "function") {
                timer_is_raf = true;
                timer_id = requestAnimationFrame(tick);
            } else {
                timer_is_raf = false;
                timer_id = setTimeout(tick, 16);
            }
        };

        const tick = () => {
            if (!paused && !destroyed) {
                try {
                    if (mode === MODE_GRAPHICAL) {
                        this.screen_fill_buffer();
                    } else {
                        this.update_graphical_text();
                    }
                } catch (e) {
                    // A bad frame must never kill the render loop.
                    console.error("screen update failed", e);
                }
            }
            schedule();
        };

        this.update_graphical_text = function () {
            if (!offscreen_context) return;
            const tm_now = performance.now();
            if (tm_now - tm_last_update > 266) {
                blink_visible = !blink_visible;
                if (cursor_enabled) {
                    changed_rows[cursor_row] = 1;
                }
                mark_blinking_rows_dirty();
                tm_last_update = tm_now;
            }
            if (render_changed_rows()) {
                graphic_context.drawImage(offscreen_context.canvas, 0, 0);
            }
        };

        // ---- adapter interface used by v86's VGA ----------------------------

        this.init = function () {
            this.set_mode(false);
            this.set_size_text(80, 25);
            this.set_size_graphical(720, 400, 720, 400);
            schedule();
        };

        this.destroy = function () {
            destroyed = true;
            if (timer_id) {
                if (timer_is_raf) cancelAnimationFrame(timer_id);
                else clearTimeout(timer_id);
                timer_id = 0;
            }
        };

        this.pause = function () { paused = true; };
        this.continue = function () { paused = false; };

        this.put_char = function (row, col, chr, flags, bg_color, fg_color) {
            const p = TEXT_BUF_COMPONENT_SIZE * (row * text_mode_width + col);
            text_mode_data[p + CHARACTER_INDEX] = chr;
            text_mode_data[p + FLAGS_INDEX] = flags;
            text_mode_data[p + BG_COLOR_INDEX] = bg_color;
            text_mode_data[p + FG_COLOR_INDEX] = fg_color;
            changed_rows[row] = 1;
        };

        this.set_mode = function (graphical) {
            mode = graphical ? MODE_GRAPHICAL : MODE_GRAPHICAL_TEXT;
            if (mode === MODE_GRAPHICAL_TEXT && changed_rows) {
                changed_rows.fill(1);
            }
        };

        this.set_font_bitmap = function (height, width_9px, width_dbl, copy_8th_col, vga_bitmap, vga_bitmap_changed) {
            const width = width_dbl ? 16 : (width_9px ? 9 : 8);
            if (font_height !== height || font_width !== width || font_width_9px !== width_9px ||
                font_width_dbl !== width_dbl || font_copy_8th_col !== copy_8th_col || vga_bitmap_changed) {
                const size_changed = font_width !== width || font_height !== height;
                font_height = height;
                font_width = width;
                font_width_9px = width_9px;
                font_width_dbl = width_dbl;
                font_copy_8th_col = copy_8th_col;
                render_font_bitmap(vga_bitmap);
                changed_rows.fill(1);
                if (size_changed) {
                    this.set_size_graphical_text();
                }
            }
        };

        this.set_font_page = function (page_a, page_b) {
            if (font_page_a !== page_a || font_page_b !== page_b) {
                font_page_a = page_a;
                font_page_b = page_b;
                changed_rows.fill(1);
            }
        };

        this.clear_screen = function () {
            graphic_context.fillStyle = "#000";
            graphic_context.fillRect(0, 0, graphic_screen.width, graphic_screen.height);
        };

        this.set_size_graphical_text = function () {
            if (!font_context) return;

            const gfx_width = font_width * text_mode_width;
            const gfx_height = font_height * text_mode_height;
            const offscreen_extra_height = font_height * 2;

            if (!offscreen_context ||
                offscreen_context.canvas.width !== gfx_width ||
                offscreen_context.canvas.height !== gfx_height ||
                offscreen_extra_context.canvas.height !== offscreen_extra_height) {
                if (!offscreen_context) {
                    offscreen_context = new OffscreenCanvas(gfx_width, gfx_height).getContext("2d", { alpha: false });
                    offscreen_extra_context = new OffscreenCanvas(gfx_width, offscreen_extra_height).getContext("2d");
                } else {
                    offscreen_context.canvas.width = gfx_width;
                    offscreen_context.canvas.height = gfx_height;
                    offscreen_extra_context.canvas.width = gfx_width;
                    offscreen_extra_context.canvas.height = offscreen_extra_height;
                }
                this.set_size_graphical(gfx_width, gfx_height, gfx_width, gfx_height);
                changed_rows.fill(1);
            }
        };

        this.set_size_text = function (cols, rows) {
            if (cols === text_mode_width && rows === text_mode_height) return;

            changed_rows = new Int8Array(rows);
            text_mode_data = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);
            text_mode_width = cols;
            text_mode_height = rows;

            if (mode === MODE_GRAPHICAL_TEXT) {
                this.set_size_graphical_text();
            }
        };

        this.set_size_graphical = function (width, height /*, buffer_width, buffer_height */) {
            graphic_screen.width = width;
            graphic_screen.height = height;
            graphic_context.imageSmoothingEnabled = false;
            if (onsize) onsize(width, height);
        };

        this.set_scale = function () { /* scaling is done with CSS on the main thread */ };

        this.update_cursor_scanline = function (start, end, enabled) {
            if (start !== cursor_start || end !== cursor_end || enabled !== cursor_enabled) {
                if (mode === MODE_GRAPHICAL_TEXT && cursor_row < text_mode_height) {
                    changed_rows[cursor_row] = 1;
                }
                cursor_start = start;
                cursor_end = end;
                cursor_enabled = enabled;
            }
        };

        this.update_cursor = function (row, col) {
            if (row !== cursor_row || col !== cursor_col) {
                if (row < text_mode_height) changed_rows[row] = 1;
                if (cursor_row < text_mode_height) changed_rows[cursor_row] = 1;
                cursor_row = row;
                cursor_col = col;
            }
        };

        this.update_buffer = function (layers) {
            for (const layer of layers) {
                graphic_context.putImageData(
                    layer.image_data,
                    layer.screen_x - layer.buffer_x,
                    layer.screen_y - layer.buffer_y,
                    layer.buffer_x,
                    layer.buffer_y,
                    layer.buffer_width,
                    layer.buffer_height
                );
            }
        };

        this.get_text_screen = function () {
            const rows = [];
            for (let y = 0; y < text_mode_height; y++) rows.push(this.get_text_row(y));
            return rows;
        };

        this.get_text_row = function (y) {
            const begin = y * text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX;
            const end = begin + text_mode_width * TEXT_BUF_COMPONENT_SIZE;
            let row = "";
            for (let i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE) {
                row += String.fromCharCode(text_mode_data[i] & 0xff);
            }
            return row;
        };

        this.init();
    }

    global.WorkerScreenAdapter = WorkerScreenAdapter;
})(self);
