// Set up pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const DOM = {
    uploadScreen: document.getElementById('upload-screen'),
    viewerScreen: document.getElementById('viewer-screen'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    pdfContainer: document.getElementById('pdf-container'),
    pageWrapper: document.getElementById('page-wrapper'),
    textLayer: document.getElementById('text-layer'),
    pdfRender: document.getElementById('pdf-render'),
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
let pageRendering = false;
let pageNumPending = null;
let scale = 1.0;
const scaleStep = 0.10;
const maxScale = 3.0;
const minScale = 0.5;

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

    let wheelTimeout = null;

    // Zoom on Ctrl + Scroll, turn page on regular scroll at boundaries
    DOM.pdfContainer.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                onZoomIn();
            } else {
                onZoomOut();
            }
        } else {
            const { scrollTop, scrollHeight, clientHeight } = DOM.pdfContainer;
            
            // Check if reached bottom and scrolling down
            if (e.deltaY > 0 && scrollTop + clientHeight >= scrollHeight - 2) {
                if (!wheelTimeout) {
                    onNextPage();
                    DOM.pdfContainer.scrollTop = 0;
                    wheelTimeout = setTimeout(() => wheelTimeout = null, 800);
                }
                e.preventDefault();
            }
            // Check if reached top and scrolling up
            else if (e.deltaY < 0 && scrollTop <= 2) {
                if (!wheelTimeout) {
                    onPrevPage();
                    // Scroll to bottom after a slight delay to allow render
                    setTimeout(() => DOM.pdfContainer.scrollTop = 99999, 100);
                    wheelTimeout = setTimeout(() => wheelTimeout = null, 800);
                }
                e.preventDefault();
            }
        }
    }, { passive: false });
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
        
        // Let container calculate height before rendering
        setTimeout(() => renderPage(pageNum), 50);
    }).catch(err => {
        console.error('Error rendering PDF:', err);
        alert('Could not render the PDF file.');
    });
}

function renderPage(num) {
    pageRendering = true;
    
    pdfDoc.getPage(num).then(page => {
        const viewport = page.getViewport({ scale: scale });
        DOM.pdfRender.height = viewport.height;
        DOM.pdfRender.width = viewport.width;
        DOM.pageWrapper.style.height = viewport.height + 'px';
        DOM.pageWrapper.style.width = viewport.width + 'px';
        DOM.textLayer.style.height = viewport.height + 'px';
        DOM.textLayer.style.width = viewport.width + 'px';
        DOM.textLayer.innerHTML = '';

        const renderContext = {
            canvasContext: DOM.pdfRender.getContext('2d'),
            viewport: viewport
        };
        
        const renderTask = page.render(renderContext);
        
        renderTask.promise.then(() => {
            pageRendering = false;
            
            // Render text layer
            page.getTextContent().then(textContent => {
                DOM.textLayer.style.setProperty('--scale-factor', scale);
                pdfjsLib.renderTextLayer({
                    textContentSource: textContent,
                    container: DOM.textLayer,
                    viewport: viewport,
                    textDivs: []
                });
            });

            if (pageNumPending !== null) {
                renderPage(pageNumPending);
                pageNumPending = null;
            }
        });
    });

    DOM.pageNum.textContent = num;
}

function queueRenderPage(num) {
    if (pageRendering) {
        pageNumPending = num;
    } else {
        renderPage(num);
    }
}

function onPrevPage() {
    if (pageNum <= 1) return;
    pageNum--;
    queueRenderPage(pageNum);
}

function onNextPage() {
    if (pageNum >= pdfDoc.numPages) return;
    pageNum++;
    queueRenderPage(pageNum);
}

function onZoomIn() {
    if (scale >= maxScale) return;
    scale += scaleStep;
    updateZoomVal();
    queueRenderPage(pageNum);
}

function onZoomOut() {
    if (scale <= minScale) return;
    scale -= scaleStep;
    updateZoomVal();
    queueRenderPage(pageNum);
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
    DOM.viewerScreen.classList.add('hidden');
    DOM.uploadScreen.classList.remove('hidden');
    DOM.fileInput.value = ''; // Reset input
    
    // Exit full screen if active
    if (document.fullscreenElement) {
        document.exitFullscreen();
    }
}

// Start application
init();
