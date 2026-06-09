// ============================================================
// IMPORTS
// ============================================================
import * as pdfjsLib from './libs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './libs/pdf.worker.min.mjs';
const { TextLayer } = pdfjsLib;

// ============================================================
// CONSTANTS
// ============================================================
const SESSION_KEY     = 'pdf-reader-session-v2';
const SCALE_STEP      = 0.10;
const MAX_SCALE       = 3.0;
const MIN_SCALE       = 0.5;
const SAVE_DEBOUNCE   = 400;   // ms — debounce for scroll/zoom saves
const RENDER_DEBOUNCE = 100;   // ms — debounce after zoom before re-render

// ============================================================
// DOM REFERENCES
// ============================================================
const DOM = {
    uploadScreen:      document.getElementById('upload-screen'),
    viewerScreen:      document.getElementById('viewer-screen'),
    dropZone:          document.getElementById('drop-zone'),
    fileInput:         document.getElementById('file-input'),
    tabsList:          document.getElementById('tabs-list'),
    btnOpenTab:        document.getElementById('btn-open-tab'),
    tabFileInput:      document.getElementById('tab-file-input'),
    pdfViewsContainer: document.getElementById('pdf-views-container'),
    btnPrev:           document.getElementById('btn-prev'),
    btnNext:           document.getElementById('btn-next'),
    btnZoomIn:         document.getElementById('btn-zoom-in'),
    btnZoomOut:        document.getElementById('btn-zoom-out'),
    zoomVal:           document.getElementById('zoom-val'),
    btnFullscreen:     document.getElementById('btn-fullscreen'),
    pageNum:           document.getElementById('page-num'),
    pageCount:         document.getElementById('page-count'),
};

// ============================================================
// APPLICATION STATE
//
// Tab object shape:
// {
//   id:          string           — unique tab ID
//   path:        string           — absolute file path (dedup + session key)
//   name:        string           — filename for display
//   pdfDoc:      PDFDocumentProxy — pdf.js document
//   pages:       PageObj[]        — one entry per PDF page
//   observer:    IntersectionObserver
//   pane:        HTMLElement      — .pdf-view-pane div (scrollable)
//   tabElement:  HTMLElement      — .tab div in the tab bar
//   scale:       number           — current zoom (1.0 = 100%)
//   pageNum:     number           — current page (1-based)
//   scrollTop:   number           — saved pane.scrollTop
//   scrollLeft:  number           — saved pane.scrollLeft
// }
// ============================================================
let tabs        = [];
let activeTabId = null;
let tabCounter  = 0;
let saveTimer   = null;
let renderTimer = null;

// ============================================================
// UTILITIES
// ============================================================
function getActiveTab() {
    return tabs.find(t => t.id === activeTabId) ?? null;
}

function basename(filePath) {
    return filePath.split(/[/\\]/).pop();
}

/**
 * Invoke a Tauri IPC command via the global injected by withGlobalTauri.
 * Works in Tauri v2 when withGlobalTauri = true in tauri.conf.json.
 */
function tauriInvoke(cmd, args) {
    if (window.__TAURI__?.core?.invoke) {
        return window.__TAURI__.core.invoke(cmd, args);
    }
    return Promise.reject(new Error('Tauri IPC not available'));
}

/**
 * Open the native OS file picker using tauri-plugin-dialog.
 * Falls back to a hidden <input> if running outside Tauri.
 * @returns {Promise<Array<{path:string, name:string, bytes:Uint8Array}>>}
 */
async function pickPdfFiles() {
    if (window.__TAURI__?.dialog?.open) {
        // Native Tauri dialog — gives real absolute paths
        const selected = await window.__TAURI__.dialog.open({
            multiple: true,
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
        });
        if (!selected) return [];
        const paths = Array.isArray(selected) ? selected : [selected];
        const results = [];
        for (const path of paths) {
            try {
                const raw = await tauriInvoke('read_file_bytes', { path });
                results.push({ path, name: basename(path), bytes: new Uint8Array(raw) });
            } catch (e) {
                console.error('Could not read file:', path, e);
                alert(`Could not open "${basename(path)}": ${e.message ?? e}`);
            }
        }
        return results;
    }
    // Fallback: web File API (no real path, no session restore)
    return new Promise(resolve => {
        const input = DOM.tabFileInput;
        input.onchange = async () => {
            const results = [];
            for (const f of input.files) {
                if (f.type === 'application/pdf') {
                    const path = f.path ?? null; // Tauri patches this on File objects
                    const bytes = new Uint8Array(await f.arrayBuffer());
                    results.push({ path, name: f.name, bytes });
                }
            }
            input.value = '';
            resolve(results);
        };
        input.click();
    });
}

// ============================================================
// SESSION PERSISTENCE
// ============================================================
function saveSession() {
    try {
        // Snapshot live scroll position for the active (visible) tab
        const active = getActiveTab();
        if (active) {
            active.scrollTop  = active.pane.scrollTop;
            active.scrollLeft = active.pane.scrollLeft;
        }

        const session = {
            tabs: tabs
                // Only persist tabs that have a real on-disk path
                .filter(t => t.path && !t.path.startsWith('__nopath__'))
                .map(t => ({
                    path:       t.path,
                    name:       t.name,
                    page:       t.pageNum,
                    scale:      t.scale,
                    scrollTop:  t.scrollTop,
                    scrollLeft: t.scrollLeft,
                })),
            activeTabPath: active?.path ?? null,
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
        console.warn('Failed to save session:', e);
    }
}

function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, SAVE_DEBOUNCE);
}

/**
 * Restore the previous session.
 * Reads each file via the Rust `read_file_bytes` command.
 * Missing/deleted files are silently skipped.
 * @returns {Promise<boolean>} true if at least one tab was restored.
 */
async function loadSession() {
    let session;
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return false;
        session = JSON.parse(raw);
    } catch {
        console.warn('Corrupted session — starting fresh.');
        localStorage.removeItem(SESSION_KEY);
        return false;
    }

    if (!Array.isArray(session?.tabs) || session.tabs.length === 0) return false;

    // Show viewer early so the user sees something while tabs load
    DOM.uploadScreen.classList.add('hidden');
    DOM.viewerScreen.classList.remove('hidden');

    let anyLoaded = false;

    for (const saved of session.tabs) {
        if (!saved.path) continue;
        try {
            const raw   = await tauriInvoke('read_file_bytes', { path: saved.path });
            const bytes = new Uint8Array(raw);
            const pdf   = await pdfjsLib.getDocument({ data: bytes }).promise;

            const pane  = createPane();
            const tabId = `tab-${++tabCounter}`;

            const tab = {
                id:          tabId,
                path:        saved.path,
                name:        saved.name ?? basename(saved.path),
                pdfDoc:      pdf,
                pages:       [],
                observer:    null,
                pane,
                page1Ref:    null,          // set by initPages
                tabElement:  null,
                scale:       saved.scale      ?? 1.0,
                pageNum:     saved.page       ?? 1,
                scrollTop:   saved.scrollTop  ?? 0,
                scrollLeft:  saved.scrollLeft ?? 0,
                pendingRestore: true,        // scroll-to-page on first switchTab
            };

            tabs.push(tab);
            renderTabElement(tab);
            // initPages awaited so placeholder heights are set before scroll restore
            await initPages(tab);
            anyLoaded = true;
        } catch (err) {
            console.warn(`Skipping "${saved.path}":`, err.message ?? err);
        }
    }

    if (!anyLoaded) {
        DOM.viewerScreen.classList.add('hidden');
        DOM.uploadScreen.classList.remove('hidden');
        return false;
    }

    // Activate previously-active tab (fall back to last)
    const toActivate =
        (session.activeTabPath ? tabs.find(t => t.path === session.activeTabPath) : null)
        ?? tabs.at(-1);

    if (toActivate) switchTab(toActivate.id);
    return true;
}

// ============================================================
// TAB MANAGEMENT
// ============================================================

/** Create and append a hidden .pdf-view-pane to the views container. */
function createPane() {
    const pane = document.createElement('div');
    pane.className = 'pdf-view-pane hidden';
    DOM.pdfViewsContainer.appendChild(pane);
    return pane;
}

/** Build a .tab element and append it to the tab strip. */
function renderTabElement(tab) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.dataset.tabId = tab.id;
    el.title = tab.path ?? tab.name;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = tab.name;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        closeTab(tab.id);
    });

    el.addEventListener('click', () => switchTab(tab.id));
    el.appendChild(nameSpan);
    el.appendChild(closeBtn);

    DOM.tabsList.appendChild(el);
    tab.tabElement = el;
    return el;
}

/**
 * Activate a tab: save current scroll, hide old pane, show new pane,
 * restore scroll (synchronous reflow trick), update controls.
 */
function switchTab(tabId) {
    // Save current tab scroll before hiding
    const current = getActiveTab();
    if (current) {
        current.scrollTop  = current.pane.scrollTop;
        current.scrollLeft = current.pane.scrollLeft;
        current.pane.classList.add('hidden');
        current.tabElement?.classList.remove('active');
    }

    activeTabId = tabId;
    const tab = getActiveTab();
    if (!tab) return;

    tab.pane.classList.remove('hidden');

    // Force a synchronous layout reflow before any scroll manipulation.
    void tab.pane.offsetHeight;

    if (tab.pendingRestore && tab.pages.length > 0) {
        // Session restore: use offsetTop of the saved page wrapper for pixel-perfect
        // accuracy regardless of zoom level.  scrollTop saved during a mixed-scale
        // session would land on the wrong page, but offsetTop is always correct
        // because initPages already built the layout at the restored scale.
        tab.pendingRestore = false;
        const targetWrapper = tab.pages[tab.pageNum - 1]?.wrapper;
        if (targetWrapper) {
            // offsetTop is relative to the pane (direct parent) — exactly what we need.
            tab.pane.scrollTop  = targetWrapper.offsetTop;
            tab.pane.scrollLeft = 0;
        }
    } else {
        tab.pane.scrollTop  = tab.scrollTop;
        tab.pane.scrollLeft = tab.scrollLeft;
    }

    tab.tabElement?.classList.add('active');
    tab.tabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

    updateControlsUI(tab);
    saveSession();
}

/** Sync the controls bar to the given tab's state. */
function updateControlsUI(tab) {
    DOM.pageNum.textContent   = tab.pageNum;
    DOM.pageCount.textContent = tab.pdfDoc?.numPages ?? '--';
    DOM.zoomVal.textContent   = Math.round(tab.scale * 100) + '%';
}

/**
 * Open a PDF in a new tab.
 * If the same path is already open, just focus that tab (deduplication).
 * @param {string|null} path  Absolute OS path (or null if not available).
 * @param {string}      name  Display filename.
 * @param {Uint8Array}  bytes Raw PDF data.
 */
async function openTab(path, name, bytes) {
    // Deduplication: focus existing tab if same file is already open
    if (path) {
        const existing = tabs.find(t => t.path === path);
        if (existing) {
            switchTab(existing.id);
            return;
        }
    }

    DOM.uploadScreen.classList.add('hidden');
    DOM.viewerScreen.classList.remove('hidden');

    const pane  = createPane();
    const tabId = `tab-${++tabCounter}`;

    const tab = {
        id:             tabId,
        path:           path ?? `__nopath__${name}__${Date.now()}`,
        name,
        pdfDoc:         null,
        pages:          [],
        observer:       null,
        pane,
        page1Ref:       null,     // set by initPages
        tabElement:     null,
        scale:          1.0,
        pageNum:        1,
        scrollTop:      0,
        scrollLeft:     0,
        pendingRestore: false,    // only true for session-restored tabs
    };

    tabs.push(tab);
    renderTabElement(tab);

    try {
        tab.pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
        await initPages(tab);
        switchTab(tabId);
        saveSession();
    } catch (err) {
        console.error('Failed to load PDF:', err);
        closeTab(tabId);
        alert(`Could not load "${name}".\n${err.message ?? err}`);
    }
}

/**
 * Close a tab: release resources, remove from DOM, switch to adjacent tab,
 * or return to upload screen if no tabs remain.
 */
function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tab = tabs[idx];

    // Release resources
    tab.observer?.disconnect();
    tab.pages.forEach(p => { p.renderTask?.cancel(); });
    try { tab.pdfDoc?.destroy(); } catch (_) { /* ignore */ }
    tab.pane.remove();
    tab.tabElement?.remove();
    tabs.splice(idx, 1);

    if (activeTabId === tabId) {
        activeTabId = null;
        if (tabs.length > 0) {
            switchTab(tabs[Math.min(idx, tabs.length - 1)].id);
        } else {
            if (document.fullscreenElement) document.exitFullscreen();
            DOM.viewerScreen.classList.add('hidden');
            DOM.uploadScreen.classList.remove('hidden');
        }
    }

    saveSession();
}

// ============================================================
// PAGE RENDERING
// ============================================================

/**
 * Build DOM structure for each page of a tab, attach IntersectionObserver
 * and scroll listener, then set placeholder dimensions.
 * Must be awaited so placeholder heights are set before scroll restore.
 */
async function initPages(tab) {
    tab.pane.innerHTML = '';
    tab.pages = [];

    tab.observer?.disconnect();
    tab.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const pageObj = tab.pages[entry.target.dataset.pageIndex];
            if (!pageObj) continue;

            if (entry.isIntersecting) {
                if (!pageObj.rendered && !pageObj.rendering) {
                    renderPage(tab, pageObj);
                }
            } else {
                pageObj.renderTask?.cancel();
                pageObj.renderTask = null;
                clearTextLayer(pageObj);
                if (pageObj.rendered || pageObj.rendering) {
                    clearCanvas(pageObj);
                    pageObj.rendered = pageObj.rendering = pageObj.renderPending = false;
                }
            }
        }
    }, { root: tab.pane, rootMargin: '300px 0px' });

    for (let i = 1; i <= tab.pdfDoc.numPages; i++) {
        const wrapper     = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.dataset.pageIndex = i - 1;

        const canvas         = document.createElement('canvas');
        canvas.className     = 'pdf-render-canvas';
        canvas.style.display = 'block';
        canvas.style.width   = '100%';
        canvas.style.height  = '100%';

        const textLayerDiv     = document.createElement('div');
        textLayerDiv.className = 'textLayer';

        wrapper.appendChild(canvas);
        wrapper.appendChild(textLayerDiv);
        tab.pane.appendChild(wrapper);

        const pageObj = {
            num: i, wrapper, canvas, textLayerDiv,
            rendered: false, rendering: false, renderPending: false,
            renderTask: null, textLayerInstance: null, textContent: null, pageRef: null,
        };
        tab.pages.push(pageObj);
        tab.observer.observe(wrapper);
    }

    // Set placeholder sizes from page 1 so total scroll height is correct.
    // We also store page1Ref so applyZoom can resize ALL wrappers consistently.
    const firstPage = await tab.pdfDoc.getPage(1);
    tab.page1Ref    = firstPage;            // ← stored for zoom consistency
    const viewport  = firstPage.getViewport({ scale: tab.scale });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    tab.pages.forEach(p => {
        p.wrapper.style.width  = w + 'px';
        p.wrapper.style.height = h + 'px';
    });

    attachScrollListener(tab);
}

/** Update page number and save state on scroll. */
function attachScrollListener(tab) {
    tab.pane.addEventListener('scroll', () => {
        if (!tab.pages.length) return;

        // Current page = the first (topmost) page that is at least partially
        // visible in the viewport.  This matches how Adobe Reader and every
        // other PDF viewer report the page number.
        const cRect  = tab.pane.getBoundingClientRect();
        let newPage  = tab.pageNum;

        for (const p of tab.pages) {
            const r = p.wrapper.getBoundingClientRect();
            // A page is "visible" when any part of it is inside the pane's
            // client rect.  We take the FIRST such page (topmost).
            if (r.bottom > cRect.top && r.top < cRect.bottom) {
                newPage = p.num;
                break;
            }
        }

        if (tab.pageNum !== newPage) {
            tab.pageNum = newPage;
            if (tab.id === activeTabId) DOM.pageNum.textContent = newPage;
        }

        tab.scrollTop  = tab.pane.scrollTop;
        tab.scrollLeft = tab.pane.scrollLeft;
        debouncedSave();
    }, { passive: true });
}

function clearCanvas(pageObj) {
    const ctx = pageObj.canvas.getContext('2d');
    ctx.clearRect(0, 0, pageObj.canvas.width, pageObj.canvas.height);
}

function clearTextLayer(pageObj) {
    pageObj.textLayerInstance?.cancel();
    pageObj.textLayerInstance     = null;
    pageObj.textLayerDiv.innerHTML = '';
}

/** Render a page canvas at the tab's current scale. */
function renderPage(tab, pageObj) {
    pageObj.renderTask?.cancel();
    pageObj.renderTask = null;

    if (pageObj.rendering) { pageObj.renderPending = true; return; }
    pageObj.rendering = true;

    const getPage = pageObj.pageRef
        ? Promise.resolve(pageObj.pageRef)
        : tab.pdfDoc.getPage(pageObj.num).then(p => { pageObj.pageRef = p; return p; });

    getPage.then(page => {
        const viewport    = page.getViewport({ scale: tab.scale });
        const outputScale = window.devicePixelRatio || 1;

        pageObj.canvas.width        = Math.floor(viewport.width  * outputScale);
        pageObj.canvas.height       = Math.floor(viewport.height * outputScale);
        pageObj.canvas.style.width  = '100%';
        pageObj.canvas.style.height = '100%';
        pageObj.wrapper.style.width  = Math.floor(viewport.width)  + 'px';
        pageObj.wrapper.style.height = Math.floor(viewport.height) + 'px';

        clearCanvas(pageObj);

        const transform  = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
        const renderTask = page.render({
            canvasContext: pageObj.canvas.getContext('2d'),
            transform,
            viewport,
        });
        pageObj.renderTask = renderTask;

        renderTask.promise
            .then(() => {
                pageObj.rendered   = true;
                pageObj.rendering  = false;
                pageObj.renderTask = null;
                renderTextLayer(tab, pageObj, page, viewport);
                if (pageObj.renderPending) { pageObj.renderPending = false; renderPage(tab, pageObj); }
            })
            .catch(err => {
                if (err?.name !== 'RenderingCancelledException') console.error('Render failed:', err);
                pageObj.rendering  = false;
                pageObj.renderTask = null;
                if (pageObj.renderPending) { pageObj.renderPending = false; renderPage(tab, pageObj); }
            });
    });
}

/** Overlay selectable text on a rendered page. */
async function renderTextLayer(tab, pageObj, page, viewport) {
    clearTextLayer(pageObj);
    try {
        if (!pageObj.textContent) {
            pageObj.textContent = await page.getTextContent();
        }
        pageObj.textLayerDiv.style.setProperty('--total-scale-factor', tab.scale);
        const tl = new TextLayer({
            textContentSource: pageObj.textContent,
            container:         pageObj.textLayerDiv,
            viewport,
        });
        pageObj.textLayerInstance = tl;
        await tl.render();
    } catch (err) {
        if (err?.name !== 'AbortException') console.error('TextLayer failed:', err);
    }
}

// ============================================================
// ZOOM
// ============================================================

/**
 * Zoom around a focal point (pane-local coords) so that point stays fixed.
 */
function applyZoomAtPoint(tab, newScale, focalX, focalY) {
    const old = tab.scale;
    const sL  = tab.pane.scrollLeft;
    const sT  = tab.pane.scrollTop;
    const wX  = (sL + focalX) / old;
    const wY  = (sT + focalY) / old;

    tab.scale = newScale;
    updateControlsUI(tab);

    // Resize EVERY page wrapper (not just rendered ones) so that scrollTop
    // values remain consistent with the layout at the new scale.
    // Unrendered pages fall back to page 1's aspect ratio.
    tab.pages.forEach(p => {
        p.rendered = false;
        clearTextLayer(p);
        const ref = p.pageRef ?? tab.page1Ref;
        if (ref) {
            const vp = ref.getViewport({ scale: newScale });
            p.wrapper.style.width  = Math.floor(vp.width)  + 'px';
            p.wrapper.style.height = Math.floor(vp.height) + 'px';
        }
    });

    tab.pane.scrollLeft = wX * newScale - focalX;
    tab.pane.scrollTop  = wY * newScale - focalY;

    debouncedRender(tab);
    debouncedSave();
}

/** Zoom without focal point (button-triggered). */
function applyZoom(tab) {
    updateControlsUI(tab);
    // Resize EVERY page wrapper so the layout stays consistent at the new scale.
    tab.pages.forEach(p => {
        p.rendered = false;
        clearTextLayer(p);
        const ref = p.pageRef ?? tab.page1Ref;
        if (ref) {
            const vp = ref.getViewport({ scale: tab.scale });
            p.wrapper.style.width  = Math.floor(vp.width)  + 'px';
            p.wrapper.style.height = Math.floor(vp.height) + 'px';
        }
    });
    debouncedRender(tab);
    debouncedSave();
}

/** Re-render visible pages after a zoom change. */
function debouncedRender(tab) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
        const cRect = tab.pane.getBoundingClientRect();
        tab.pages.forEach(p => {
            const r = p.wrapper.getBoundingClientRect();
            const visible = r.top < cRect.bottom + 300 && r.bottom > cRect.top - 300;
            if (visible) renderPage(tab, p);
        });
    }, RENDER_DEBOUNCE);
}

// ============================================================
// NAVIGATION
// ============================================================
function onPrevPage() {
    const tab = getActiveTab();
    if (!tab || tab.pageNum <= 1) return;
    tab.pages[tab.pageNum - 2]?.wrapper.scrollIntoView({ behavior: 'smooth' });
}

function onNextPage() {
    const tab = getActiveTab();
    if (!tab || tab.pageNum >= tab.pdfDoc.numPages) return;
    tab.pages[tab.pageNum]?.wrapper.scrollIntoView({ behavior: 'smooth' });
}

function onZoomIn() {
    const tab = getActiveTab();
    if (!tab || tab.scale >= MAX_SCALE) return;
    tab.scale = +Math.min(MAX_SCALE, tab.scale + SCALE_STEP).toFixed(2);
    applyZoom(tab);
}

function onZoomOut() {
    const tab = getActiveTab();
    if (!tab || tab.scale <= MIN_SCALE) return;
    tab.scale = +Math.max(MIN_SCALE, tab.scale - SCALE_STEP).toFixed(2);
    applyZoom(tab);
}

function toggleFullScreen() {
    if (!document.fullscreenElement) {
        DOM.viewerScreen.requestFullscreen().catch(console.error);
    } else {
        document.exitFullscreen();
    }
}

// ============================================================
// FILE HANDLING (fallback for web File API / upload screen drop)
// ============================================================
async function handleFiles(fileList) {
    for (const file of fileList) {
        if (file.type !== 'application/pdf') {
            alert(`"${file.name}" is not a valid PDF.`);
            continue;
        }
        // Tauri patches File objects to expose an absolute .path property
        const path  = file.path ?? null;
        const name  = file.name;
        const bytes = new Uint8Array(await file.arrayBuffer());
        await openTab(path, name, bytes);
    }
}

// ============================================================
// EVENT LISTENERS
// ============================================================
function setupDragAndDrop() {
    const dz = DOM.dropZone;
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev =>
        dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, false));
    ['dragenter', 'dragover'].forEach(ev =>
        dz.addEventListener(ev, () => dz.classList.add('dragover'), false));
    ['dragleave', 'drop'].forEach(ev =>
        dz.addEventListener(ev, () => dz.classList.remove('dragover'), false));
    dz.addEventListener('drop', e => {
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    }, false);
}

function setupEventListeners() {

    // ── Browse Files button (upload screen) ─────────────────────
    // Override label's default behaviour with native Tauri dialog
    const browseLabel = document.querySelector('label[for="file-input"]');
    browseLabel?.addEventListener('click', async e => {
        if (window.__TAURI__?.dialog?.open) {
            e.preventDefault();
            const picked = await pickPdfFiles();
            for (const { path, name, bytes } of picked) {
                await openTab(path, name, bytes);
            }
        }
        // else: default label→input behaviour takes over (web fallback)
    });

    // Fallback for browsers / non-Tauri mode
    DOM.fileInput.addEventListener('change', e => {
        if (e.target.files.length) handleFiles(e.target.files);
        e.target.value = '';
    });

    // ── "+" open button in tab bar ───────────────────────────────
    DOM.btnOpenTab.addEventListener('click', async () => {
        const picked = await pickPdfFiles();
        for (const { path, name, bytes } of picked) {
            await openTab(path, name, bytes);
        }
    });

    // Fallback file input (non-Tauri)
    DOM.tabFileInput.addEventListener('change', e => {
        if (e.target.files.length) handleFiles(e.target.files);
        e.target.value = '';
    });

    // ── Navigation & zoom buttons ────────────────────────────────
    DOM.btnPrev.addEventListener('click',       onPrevPage);
    DOM.btnNext.addEventListener('click',       onNextPage);
    DOM.btnZoomIn.addEventListener('click',     onZoomIn);
    DOM.btnZoomOut.addEventListener('click',    onZoomOut);
    DOM.btnFullscreen.addEventListener('click', toggleFullScreen);

    // ── Ctrl+Scroll zoom ─────────────────────────────────────────
    window.addEventListener('wheel', e => {
        const tab = getActiveTab();
        if (!tab || !(e.ctrlKey || e.metaKey)) return;
        if (!tab.pane.contains(e.target)) return;
        e.preventDefault();
        const factor   = Math.exp(-e.deltaY * 0.01);
        const newScale = +Math.min(MAX_SCALE, Math.max(MIN_SCALE, tab.scale * factor)).toFixed(3);
        if (Math.abs(newScale - tab.scale) > 0.001) {
            const rect = tab.pane.getBoundingClientRect();
            applyZoomAtPoint(tab, newScale, e.clientX - rect.left, e.clientY - rect.top);
        }
    }, { passive: false });

    // ── Keyboard shortcuts ───────────────────────────────────────
    document.addEventListener('keydown', async e => {
        if (e.ctrlKey && e.key === '2') {
            e.preventDefault(); onZoomIn();
        } else if (e.ctrlKey && e.key === '3') {
            e.preventDefault(); onZoomOut();
        } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
            e.preventDefault();
            const picked = await pickPdfFiles();
            for (const { path, name, bytes } of picked) {
                await openTab(path, name, bytes);
            }
        } else if (
            e.key.toLowerCase() === 'f' &&
            !e.ctrlKey && !e.altKey && !e.metaKey &&
            e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA'
        ) {
            e.preventDefault(); toggleFullScreen();
        }
    });

    // ── Save on app close ────────────────────────────────────────
    // beforeunload fires synchronously — perfect for a final save
    window.addEventListener('beforeunload', () => {
        const tab = getActiveTab();
        if (tab) {
            tab.scrollTop  = tab.pane.scrollTop;
            tab.scrollLeft = tab.pane.scrollLeft;
        }
        saveSession();
    });

    setupDragAndDrop();
}

// ============================================================
// ENTRY POINT
// ============================================================
async function init() {
    setupEventListeners();

    const restored = await loadSession();
    if (!restored) {
        console.log('PDF Viewer ready. No previous session to restore.');
    }
}

init();
