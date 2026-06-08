// ============================================================
// IMPORTS
// ============================================================
import * as pdfjsLib from './libs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './libs/pdf.worker.min.mjs';
const { TextLayer } = pdfjsLib;

// ============================================================
// CONSTANTS
// ============================================================
const SESSION_KEY    = 'pdf-reader-session';
const SCALE_STEP     = 0.10;
const MAX_SCALE      = 3.0;
const MIN_SCALE      = 0.5;
const SAVE_DEBOUNCE  = 500;   // ms — debounce for scroll/zoom saves
const RENDER_DEBOUNCE = 100;  // ms — debounce after zoom before re-render

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
    return filePath.split(/[\\/]/).pop();
}

/** Invoke a Tauri backend command.  Gracefully fails outside Tauri. */
function invoke(cmd, args) {
    return window.__TAURI__?.core?.invoke(cmd, args)
        ?? Promise.reject(new Error('Tauri IPC not available'));
}

// ============================================================
// SESSION PERSISTENCE
// ============================================================
function saveSession() {
    try {
        const session = {
            // Only persist tabs that have a real filesystem path
            tabs: tabs
                .filter(t => t.path && !t.path.startsWith('__nopath__'))
                .map(t => ({
                    path:       t.path,
                    name:       t.name,
                    page:       t.pageNum,
                    scale:      t.scale,
                    scrollTop:  t.scrollTop,
                    scrollLeft: t.scrollLeft,
                })),
            activeTabPath: getActiveTab()?.path ?? null,
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
 * Restore the previous session from localStorage.
 * Reads each file via the Tauri `read_file_bytes` command.
 * Files that no longer exist are skipped gracefully.
 * @returns {Promise<boolean>} true if at least one tab was restored.
 */
async function loadSession() {
    let session;
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return false;
        session = JSON.parse(raw);
    } catch {
        console.warn('Corrupted session data — starting fresh.');
        localStorage.removeItem(SESSION_KEY);
        return false;
    }

    if (!Array.isArray(session?.tabs) || session.tabs.length === 0) return false;

    // Show viewer early so something is on screen during restore
    DOM.uploadScreen.classList.add('hidden');
    DOM.viewerScreen.classList.remove('hidden');

    let anyLoaded = false;

    for (const saved of session.tabs) {
        if (!saved.path) continue;
        try {
            const raw   = await invoke('read_file_bytes', { path: saved.path });
            const bytes = new Uint8Array(raw);
            const pdf   = await pdfjsLib.getDocument({ data: bytes }).promise;

            const pane  = createPane();
            const tabId = `tab-${++tabCounter}`;

            const tab = {
                id:         tabId,
                path:       saved.path,
                name:       saved.name ?? basename(saved.path),
                pdfDoc:     pdf,
                pages:      [],
                observer:   null,
                pane,
                tabElement: null,
                scale:      saved.scale      ?? 1.0,
                pageNum:    saved.page       ?? 1,
                scrollTop:  saved.scrollTop  ?? 0,
                scrollLeft: saved.scrollLeft ?? 0,
            };

            tabs.push(tab);
            renderTabElement(tab);
            await initPages(tab);   // awaited so placeholder heights are ready
            anyLoaded = true;
        } catch (err) {
            console.warn(`Skipping missing/inaccessible file: ${saved.path}`, err.message ?? err);
        }
    }

    if (!anyLoaded) {
        DOM.viewerScreen.classList.add('hidden');
        DOM.uploadScreen.classList.remove('hidden');
        return false;
    }

    // Activate the previously active tab (fall back to last tab)
    const toActivate =
        (session.activeTabPath ? tabs.find(t => t.path === session.activeTabPath) : null)
        ?? tabs.at(-1);

    if (toActivate) switchTab(toActivate.id);
    return true;
}

// ============================================================
// TAB MANAGEMENT
// ============================================================

/** Create and append a hidden .pdf-view-pane to the container. */
function createPane() {
    const pane = document.createElement('div');
    pane.className = 'pdf-view-pane hidden';
    DOM.pdfViewsContainer.appendChild(pane);
    return pane;
}

/** Build the .tab element and append it to the tab bar. */
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
 * Switch to the tab with the given id.
 * Saves current scroll position, restores the new tab's scroll
 * with a forced reflow so IntersectionObserver fires correctly.
 */
function switchTab(tabId) {
    // ── Save current tab state ──
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

    // ── Reveal new tab pane ──
    tab.pane.classList.remove('hidden');

    // Force a synchronous reflow so that:
    // 1. scrollTop can be set on a now-visible element
    // 2. IntersectionObserver callbacks (async) fire AFTER the scroll is set
    // eslint-disable-next-line no-unused-expressions
    tab.pane.offsetHeight;

    tab.pane.scrollTop  = tab.scrollTop;
    tab.pane.scrollLeft = tab.scrollLeft;

    tab.tabElement?.classList.add('active');
    // Keep active tab visible in the (horizontally scrollable) tab bar
    tab.tabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

    updateControlsUI(tab);
    saveSession();
}

/** Sync the controls bar display to reflect the given tab's state. */
function updateControlsUI(tab) {
    DOM.pageNum.textContent   = tab.pageNum;
    DOM.pageCount.textContent = tab.pdfDoc?.numPages ?? '--';
    DOM.zoomVal.textContent   = Math.round(tab.scale * 100) + '%';
}

/**
 * Open a PDF in a new tab, or focus the existing tab if the same
 * path is already open (deduplication).
 * @param {string|null} path  Absolute file path, or null if unavailable.
 * @param {string}      name  Display filename.
 * @param {Uint8Array}  bytes Raw PDF bytes.
 */
async function openTab(path, name, bytes) {
    // Deduplication — focus existing tab when path matches
    if (path) {
        const existing = tabs.find(t => t.path === path);
        if (existing) { switchTab(existing.id); return; }
    }

    // Show viewer
    DOM.uploadScreen.classList.add('hidden');
    DOM.viewerScreen.classList.remove('hidden');

    const pane  = createPane();
    const tabId = `tab-${++tabCounter}`;

    const tab = {
        id:         tabId,
        path:       path ?? `__nopath__${name}__${Date.now()}`,
        name,
        pdfDoc:     null,
        pages:      [],
        observer:   null,
        pane,
        tabElement: null,
        scale:      1.0,
        pageNum:    1,
        scrollTop:  0,
        scrollLeft: 0,
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
 * Close the tab with the given id.
 * Frees all resources (observer, render tasks, pdfDoc) and switches
 * to an adjacent tab or returns to the upload screen if no tabs remain.
 */
function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tab = tabs[idx];

    // ── Release resources ──
    tab.observer?.disconnect();
    tab.pages.forEach(p => { p.renderTask?.cancel(); });
    try { tab.pdfDoc?.destroy(); } catch (_) { /* ignore */ }
    tab.pane.remove();
    tab.tabElement?.remove();

    tabs.splice(idx, 1);

    if (activeTabId === tabId) {
        activeTabId = null;
        if (tabs.length > 0) {
            // Prefer the tab to the right; fall back to the one to the left
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
// PAGE RENDERING  — all operations scoped to a specific tab
// ============================================================

/**
 * Build the page list for a tab, set up its IntersectionObserver
 * and scroll listener.  Awaited so placeholder heights are set
 * before the caller restores scroll position.
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
                // Out of view — cancel in-flight render and clear stale pixels
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

    // Set uniform placeholder sizes so the scrollable area has the right
    // total height before any page is rendered.  We AWAIT this so that
    // switchTab() can immediately set scrollTop correctly.
    const firstPage = await tab.pdfDoc.getPage(1);
    const viewport  = firstPage.getViewport({ scale: tab.scale });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    tab.pages.forEach(p => {
        p.wrapper.style.width  = w + 'px';
        p.wrapper.style.height = h + 'px';
    });

    attachScrollListener(tab);
}

/** Track scroll position and current page for a tab's pane. */
function attachScrollListener(tab) {
    tab.pane.addEventListener('scroll', () => {
        if (!tab.pages.length) return;

        // Find the page whose centre is closest to the pane's centre
        const cRect  = tab.pane.getBoundingClientRect();
        const centre = cRect.top + cRect.height / 2;
        let closest  = tab.pageNum;
        let minDist  = Infinity;

        tab.pages.forEach(p => {
            const r    = p.wrapper.getBoundingClientRect();
            const dist = Math.abs(r.top + r.height / 2 - centre);
            if (dist < minDist) { minDist = dist; closest = p.num; }
        });

        if (tab.pageNum !== closest) {
            tab.pageNum = closest;
            if (tab.id === activeTabId) DOM.pageNum.textContent = closest;
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
    pageObj.textLayerInstance    = null;
    pageObj.textLayerDiv.innerHTML = '';
}

/** Render one page canvas (and its text layer) at the tab's current scale. */
function renderPage(tab, pageObj) {
    // Cancel any in-flight render first
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

        renderTask.promise.then(() => {
            pageObj.rendered   = true;
            pageObj.rendering  = false;
            pageObj.renderTask = null;
            renderTextLayer(tab, pageObj, page, viewport);
            if (pageObj.renderPending) { pageObj.renderPending = false; renderPage(tab, pageObj); }
        }).catch(err => {
            if (err?.name !== 'RenderingCancelledException') {
                console.error('Render failed:', err);
            }
            pageObj.rendering  = false;
            pageObj.renderTask = null;
            if (pageObj.renderPending) { pageObj.renderPending = false; renderPage(tab, pageObj); }
        });
    });
}

/** Render the selectable text overlay for one page. */
async function renderTextLayer(tab, pageObj, page, viewport) {
    clearTextLayer(pageObj);
    try {
        // Cache text content so re-zoom doesn't re-extract
        if (!pageObj.textContent) {
            pageObj.textContent = await page.getTextContent();
        }

        // --total-scale-factor drives CSS font sizing in the text layer
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
 * Zoom centred on a specific point (x, y) in pane-local coordinates.
 * Preserves the world-space point under the cursor.
 */
function applyZoomAtPoint(tab, newScale, focalX, focalY) {
    const old  = tab.scale;
    const sL   = tab.pane.scrollLeft;
    const sT   = tab.pane.scrollTop;

    // World-space coordinates of the focal point before scaling
    const wX = (sL + focalX) / old;
    const wY = (sT + focalY) / old;

    tab.scale = newScale;
    updateControlsUI(tab);

    // Resize page wrappers immediately (so scroll math is correct)
    tab.pages.forEach(p => {
        p.rendered = false;
        clearTextLayer(p);
        if (p.pageRef) {
            const vp = p.pageRef.getViewport({ scale: newScale });
            p.wrapper.style.width  = Math.floor(vp.width)  + 'px';
            p.wrapper.style.height = Math.floor(vp.height) + 'px';
        }
    });

    // Shift scroll so the focal world point stays under the cursor
    tab.pane.scrollLeft = wX * newScale - focalX;
    tab.pane.scrollTop  = wY * newScale - focalY;

    debouncedRender(tab);
    debouncedSave();
}

/** Zoom without a specific focal point (button-triggered). */
function applyZoom(tab) {
    updateControlsUI(tab);
    tab.pages.forEach(p => {
        p.rendered = false;
        clearTextLayer(p);
        if (p.pageRef) {
            const vp = p.pageRef.getViewport({ scale: tab.scale });
            p.wrapper.style.width  = Math.floor(vp.width)  + 'px';
            p.wrapper.style.height = Math.floor(vp.height) + 'px';
        }
    });
    debouncedRender(tab);
    debouncedSave();
}

/** After a zoom change, re-render only the currently visible pages. */
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
// FILE HANDLING
// ============================================================

/**
 * Process a FileList (from input or drag-and-drop).
 * Each PDF is opened in its own tab.  Non-PDFs are warned and skipped.
 */
async function handleFiles(fileList) {
    for (const file of fileList) {
        if (file.type !== 'application/pdf') {
            alert(`"${file.name}" is not a valid PDF.`);
            continue;
        }
        // Tauri patches File objects with a .path property holding the real OS path
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
    // ── File inputs ──────────────────────────────────────────────
    DOM.fileInput.addEventListener('change', e => {
        if (e.target.files.length) handleFiles(e.target.files);
        e.target.value = '';        // allow re-opening the same file
    });

    DOM.btnOpenTab.addEventListener('click', () => DOM.tabFileInput.click());
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

    // ── Ctrl+Scroll zoom (only when over the active pane) ────────
    window.addEventListener('wheel', e => {
        const tab = getActiveTab();
        if (!tab || !(e.ctrlKey || e.metaKey)) return;
        if (!tab.pane.contains(e.target)) return;  // only for the active pane
        e.preventDefault();

        const factor   = Math.exp(-e.deltaY * 0.01);
        const newScale = +Math.min(MAX_SCALE, Math.max(MIN_SCALE, tab.scale * factor)).toFixed(3);

        if (Math.abs(newScale - tab.scale) > 0.001) {
            const rect = tab.pane.getBoundingClientRect();
            applyZoomAtPoint(tab, newScale, e.clientX - rect.left, e.clientY - rect.top);
        }
    }, { passive: false });

    // ── Keyboard shortcuts ───────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === '2') {
            e.preventDefault(); onZoomIn();
        } else if (e.ctrlKey && e.key === '3') {
            e.preventDefault(); onZoomOut();
        } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
            e.preventDefault(); DOM.tabFileInput.click();
        } else if (
            e.key.toLowerCase() === 'f' &&
            !e.ctrlKey && !e.altKey && !e.metaKey &&
            e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA'
        ) {
            e.preventDefault(); toggleFullScreen();
        }
    });

    // ── Save on window close / navigate away ────────────────────
    window.addEventListener('beforeunload', () => {
        const tab = getActiveTab();
        if (tab) {
            tab.scrollTop  = tab.pane.scrollTop;
            tab.scrollLeft = tab.pane.scrollLeft;
        }
        saveSession();   // synchronous localStorage write
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
        // No valid session — upload screen is already visible (default HTML state)
        console.log('PDF Viewer ready.  No previous session to restore.');
    }
}

init();
