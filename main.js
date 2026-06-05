// Set up pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const DOM = {
    uploadScreen: document.getElementById('upload-screen'),
    viewerScreen: document.getElementById('viewer-screen'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    pdfContainer: document.getElementById('pdf-container'),
    fileName: document.getElementById('file-name'),
    pageNum: document.getElementById('page-num'),
    pageCount: document.getElementById('page-count'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    btnZoomIn: document.getElementById('btn-zoom-in'),
    btnZoomOut: document.getElementById('btn-zoom-out'),
    zoomVal: document.getElementById('zoom-val'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    btnClose: document.getElementById('btn-close')
};

let pdfDoc = null;
let pageNum = 1;
let scale = 1.0;
const scaleStep = 0.10;
const maxScale = 3.0;
const minScale = 0.5;

let pages = [];
let observer = null;

// Initial state setup
function init() {
    setupDragAndDrop();
    setupEventListeners();
}

function setupDragAndDrop() {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        DOM.dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        DOM.dropZone.addEventListener(eventName, () => {
            DOM.dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        DOM.dropZone.addEventListener(eventName, () => {
            DOM.dropZone.classList.remove('dragover');
        }, false);
    });

    DOM.dropZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        handleFile(file);
    }, false);
}

function setupEventListeners() {
    DOM.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    DOM.btnPrev.addEventListener('click', onPrevPage);
    DOM.btnNext.addEventListener('click', onNextPage);
    DOM.btnZoomIn.addEventListener('click', onZoomIn);
    DOM.btnZoomOut.addEventListener('click', onZoomOut);
    DOM.btnFullscreen.addEventListener('click', toggleFullScreen);
    DOM.btnClose.addEventListener('click', closeViewer);

    // Zoom on Ctrl + Scroll
    DOM.pdfContainer.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                onZoomIn();
            } else {
                onZoomOut();
            }
        }
    }, { passive: false });

    // Track scroll to update current page number
    DOM.pdfContainer.addEventListener('scroll', () => {
        if (!pages.length) return;
        
        let closestPageNum = pageNum;
        let minDistance = Infinity;
        const containerRect = DOM.pdfContainer.getBoundingClientRect();
        const viewportCenter = containerRect.top + containerRect.height / 2;

        pages.forEach(pageObj => {
            const rect = pageObj.wrapper.getBoundingClientRect();
            const pageCenter = rect.top + rect.height / 2;
            const distance = Math.abs(pageCenter - viewportCenter);

            if (distance < minDistance) {
                minDistance = distance;
                closestPageNum = pageObj.num;
            }
        });

        if (pageNum !== closestPageNum) {
            pageNum = closestPageNum;
            DOM.pageNum.textContent = pageNum;
        }
    }, { passive: true });
}

function handleFile(file) {
    if (file && file.type === 'application/pdf') {
        DOM.fileName.textContent = file.name;
        const fileReader = new FileReader();
        
        fileReader.onload = function(e) {
            const typedarray = new Uint8Array(e.target.result);
            loadPDF(typedarray);
        };
        
        fileReader.readAsArrayBuffer(file);
    } else {
        alert('Please select a valid PDF file.');
    }
}

function loadPDF(data) {
    pdfjsLib.getDocument({ data: data }).promise.then(pdf => {
        pdfDoc = pdf;
        DOM.pageCount.textContent = pdf.numPages;
        pageNum = 1;
        scale = 1.0;
        updateZoomVal();
        
        DOM.uploadScreen.classList.add('hidden');
        DOM.viewerScreen.classList.remove('hidden');
        
        initPages();
    }).catch(err => {
        console.error('Error rendering PDF:', err);
        alert('Could not render the PDF file.');
    });
}

function initPages() {
    DOM.pdfContainer.innerHTML = '';
    pages = [];
    
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const pageObj = pages[entry.target.dataset.pageIndex];
                if (!pageObj.rendered && !pageObj.rendering) {
                    renderPage(pageObj);
                }
            }
        });
    }, {
        root: DOM.pdfContainer,
        rootMargin: '300px 0px' // Pre-load slightly before scrolling into view
    });

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper';
        wrapper.dataset.pageIndex = i - 1;

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-render-canvas';
        canvas.style.display = 'block';

        const textLayer = document.createElement('div');
        textLayer.className = 'textLayer';

        wrapper.appendChild(canvas);
        wrapper.appendChild(textLayer);
        DOM.pdfContainer.appendChild(wrapper);

        const pageObj = {
            num: i,
            wrapper,
            canvas,
            textLayer,
            rendered: false,
            rendering: false,
            pageRef: null
        };

        pages.push(pageObj);
        observer.observe(wrapper);
    }

    // Set placeholder sizes so they don't all intersect at once
    pdfDoc.getPage(1).then(page => {
        const viewport = page.getViewport({ scale: scale });
        pages.forEach(p => {
            p.wrapper.style.width = viewport.width + 'px';
            p.wrapper.style.height = viewport.height + 'px';
        });
    });
}

function renderPage(pageObj) {
    if (pageObj.rendering) {
        pageObj.renderPending = true;
        return;
    }
    pageObj.rendering = true;
    
    const renderTaskPromise = pageObj.pageRef 
        ? Promise.resolve(pageObj.pageRef) 
        : pdfDoc.getPage(pageObj.num).then(p => { pageObj.pageRef = p; return p; });

    renderTaskPromise.then(page => {
        const viewport = page.getViewport({ scale: scale });
        pageObj.canvas.height = viewport.height;
        pageObj.canvas.width = viewport.width;
        pageObj.wrapper.style.height = viewport.height + 'px';
        pageObj.wrapper.style.width = viewport.width + 'px';
        pageObj.textLayer.style.height = viewport.height + 'px';
        pageObj.textLayer.style.width = viewport.width + 'px';
        pageObj.textLayer.innerHTML = '';

        const renderContext = {
            canvasContext: pageObj.canvas.getContext('2d'),
            viewport: viewport
        };
        
        const renderTask = page.render(renderContext);
        pageObj.renderTask = renderTask;
        
        renderTask.promise.then(() => {
            pageObj.rendered = true;
            pageObj.rendering = false;
            
            // Render text layer
            page.getTextContent().then(textContent => {
                pageObj.textLayer.style.setProperty('--scale-factor', scale);
                pdfjsLib.renderTextLayer({
                    textContentSource: textContent,
                    container: pageObj.textLayer,
                    viewport: viewport,
                    textDivs: []
                });
            });

            if (pageObj.renderPending) {
                pageObj.renderPending = false;
                renderPage(pageObj);
            }
        }).catch(err => {
             console.error('Render cancelled or failed:', err);
             pageObj.rendering = false;
             if (pageObj.renderPending) {
                 pageObj.renderPending = false;
                 renderPage(pageObj);
             }
        });
    });
}

function applyZoom() {
    updateZoomVal();
    // Update sizes of all pages and re-render them if they have been rendered
    pages.forEach(pageObj => {
        pageObj.rendered = false;
        pageObj.textLayer.innerHTML = ''; // Clear text layer
        
        if (pageObj.pageRef) {
            const viewport = pageObj.pageRef.getViewport({ scale: scale });
            pageObj.wrapper.style.height = viewport.height + 'px';
            pageObj.wrapper.style.width = viewport.width + 'px';
        }

        // The observer will naturally catch intersecting pages and re-render them
        // But for currently visible ones we should trigger render directly just to be fast
        const rect = pageObj.wrapper.getBoundingClientRect();
        const containerRect = DOM.pdfContainer.getBoundingClientRect();
        
        const isVisible = (
            rect.top < containerRect.bottom + 300 &&
            rect.bottom > containerRect.top - 300
        );
        
        if (isVisible) {
            renderPage(pageObj);
        }
    });
}

function onPrevPage() {
    if (pageNum <= 1) return;
    const targetPage = pages[pageNum - 2];
    if (targetPage) {
        targetPage.wrapper.scrollIntoView({ behavior: 'smooth' });
    }
}

function onNextPage() {
    if (pageNum >= pdfDoc.numPages) return;
    const targetPage = pages[pageNum];
    if (targetPage) {
        targetPage.wrapper.scrollIntoView({ behavior: 'smooth' });
    }
}

function onZoomIn() {
    if (scale >= maxScale) return;
    scale += scaleStep;
    applyZoom();
}

function onZoomOut() {
    if (scale <= minScale) return;
    scale -= scaleStep;
    applyZoom();
}

function updateZoomVal() {
    DOM.zoomVal.textContent = Math.round(scale * 100) + '%';
}

function toggleFullScreen() {
    if (!document.fullscreenElement) {
        DOM.viewerScreen.requestFullscreen().catch(err => {
            alert(`Error attempting to enable full-screen mode: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
}

function closeViewer() {
    pdfDoc = null;
    pages = [];
    if (observer) observer.disconnect();
    DOM.pdfContainer.innerHTML = '';
    
    DOM.viewerScreen.classList.add('hidden');
    DOM.uploadScreen.classList.remove('hidden');
    DOM.fileInput.value = ''; // Reset input
    
    if (document.fullscreenElement) {
        document.exitFullscreen();
    }
}

// Start application
init();
