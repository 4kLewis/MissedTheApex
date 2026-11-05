/**
 * Opt-in PDF page previews for MissedTheApex FIA alerts.
 * Requires: npm install pdfjs-dist @napi-rs/canvas
 *
 * RIGHTS: Publishing images of FIA PDF pages can require the FIA's permission.
 * Keep FIA_PDF_PREVIEWS_ENABLED unset/false until permission is confirmed.
 */
import axios from 'axios';

const PDF_LIMIT_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const FIA_HOSTS = new Set(['fia.com', 'www.fia.com', 'api.fia.com']);

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`PDF previews require Node.js >=22.13.0 (running ${process.version}). ` +
      'The original Dockerfile used Node 20; deploy the included Node 22 Dockerfile.');
  }
}


function assertFiaPdfUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !FIA_HOSTS.has(url.hostname) ||
      !url.pathname.toLowerCase().endsWith('.pdf')) {
    throw new Error('Preview requires an HTTPS PDF hosted on fia.com or api.fia.com');
  }
  return url.toString();
}

/** Return a generated PNG/JPEG Buffer; no intermediate file or PDF upload. */
export async function renderFiaPdfPreview(pdfBytes, requestedPages = 4) {
  assertSupportedNode();
  const bytes = Buffer.from(pdfBytes);
  if (bytes.byteLength > PDF_LIMIT_BYTES) throw new Error('PDF exceeds the 12 MB preview limit');
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('Downloaded content is not a PDF');
  }

  // Lazy imports: existing FIA links still work if previews are disabled.
  const [{ getDocument }, { createCanvas }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('@napi-rs/canvas'),
  ]);
  const loading = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  let pdf;
  try {
    pdf = await loading.promise;
    const count = Math.min(pdf.numPages, Math.max(1, Math.min(4, Math.floor(requestedPages) || 4)));
    if (!count) throw new Error('No PDF pages found');

    const cols = count === 1 ? 1 : 2;
    const rows = Math.ceil(count / cols);
    const tileWidth = count === 1 ? 780 : 630;
    const tileHeight = count === 1 ? 1000 : 860;
    const padding = 12;
    const margin = 16;
    const board = createCanvas(margin * 2 + cols * tileWidth + (cols - 1) * padding,
      margin * 2 + rows * tileHeight + (rows - 1) * padding);
    const context = board.getContext('2d');
    context.fillStyle = '#242830';
    context.fillRect(0, 0, board.width, board.height);

    for (let i = 0; i < count; i++) {
      const page = await pdf.getPage(i + 1);
      try {
        const unscaled = page.getViewport({ scale: 1 });
        const maxWidth = tileWidth - 20;
        const maxHeight = tileHeight - 20;
        const scale = Math.min(maxWidth / unscaled.width, maxHeight / unscaled.height);
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        const singlePage = createCanvas(width, height);
        const pageContext = singlePage.getContext('2d');
        pageContext.fillStyle = '#ffffff';
        pageContext.fillRect(0, 0, width, height);
        await page.render({ canvas: singlePage, canvasContext: pageContext, viewport }).promise;
        const col = i % cols;
        const row = Math.floor(i / cols);
        const left = margin + col * (tileWidth + padding) + Math.floor((tileWidth - width) / 2);
        const top = margin + row * (tileHeight + padding) + Math.floor((tileHeight - height) / 2);
        context.drawImage(singlePage, left, top);
      } finally {
        page.cleanup();
      }
    }

    let data = board.toBuffer('image/png');
    let extension = 'png';
    if (data.length > MAX_IMAGE_BYTES) {
      data = board.toBuffer('image/jpeg', { quality: 80 });
      extension = 'jpg';
    }
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Generated preview is too large for the configured limit');
    return { data, extension, pages: count };
  } finally {
    if (pdf) await pdf.cleanup();
    await loading.destroy();
  }
}

/** Downloads only URLs discovered on the FIA HTTPS PDF archive. */
export async function fetchAndRenderFiaPdfPreview(pdfUrl, requestedPages = 4) {
  const safeUrl = assertFiaPdfUrl(pdfUrl);
  // Run the version check BEFORE attempting a network download.
  assertSupportedNode();
  let response;
  try {
    response = await axios.get(safeUrl, {
    responseType: 'arraybuffer',
    timeout: 20_000,
    maxRedirects: 2,
    maxContentLength: PDF_LIMIT_BYTES,
    headers: {
      Accept: 'application/pdf',
      'User-Agent': 'MissedTheApex-FIA-Documents/1.1 (optional PDF page preview)',
    },
    });
  } catch (error) {
    const status = error.response?.status;
    const reason = status ? `HTTP ${status}` : (error.code || error.message);
    throw new Error(`FIA PDF download failed (${reason}). Check whether the FIA is blocking Railway or the URL is accessible.`, { cause: error });
  }
  // Limit final redirect origin too; never fetch arbitrary hosts via this feature.
  const finalUrl = response.request?.res?.responseUrl;
  if (finalUrl) {
    try { assertFiaPdfUrl(finalUrl); }
    catch { throw new Error(`FIA PDF redirects to an unapproved host (${new URL(finalUrl).hostname}); preview blocked for safety.`); }
  }
  const bytes = Buffer.from(response.data);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    const type = response.headers?.['content-type'] || 'unknown content type';
    throw new Error(`FIA PDF download returned ${type}, not PDF bytes (possible access-denied/HTML response).`);
  }
  return renderFiaPdfPreview(bytes, requestedPages);
}
