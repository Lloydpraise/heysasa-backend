// Turns an uploaded file into text, the way that suits its type. Every type ends the same way: pages of text that the
// service cuts into pieces and stores as vectors.
//
//   pdf       the text is read straight out of the file, page by page. A scanned PDF has no text, so the model reads it.
//   image     the model writes out every word on the picture, then says what it shows.
//   audio     transcribed.   video: its sound is transcribed (clips over 25 MB cannot be, and say so).
//   document  Word files (.docx) are read directly.
//   text      plain text, markdown, csv, and notes typed into the dashboard.

export const FILE_TYPES = ['pdf', 'image', 'audio', 'video', 'document', 'text'];

const EXT = {
    pdf: ['pdf'],
    image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'],
    audio: ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'aac', 'mpga'],
    video: ['mp4', 'mov', 'webm', 'mpeg', 'm4v', '3gp'],
    document: ['docx'],
    text: ['txt', 'md', 'csv', 'tsv', 'json'],
};

export function inferFileType({ mime = '', fileName = '' } = {}) {
    const m = String(mime).toLowerCase();
    const ext = String(fileName).toLowerCase().split('.').pop();
    if (m === 'application/pdf' || EXT.pdf.includes(ext)) return 'pdf';
    if (m.startsWith('image/') || EXT.image.includes(ext)) return 'image';
    if (m.startsWith('audio/') || EXT.audio.includes(ext)) return 'audio';
    if (m.startsWith('video/') || EXT.video.includes(ext)) return 'video';
    if (m.includes('wordprocessingml') || EXT.document.includes(ext)) return 'document';
    if (m.startsWith('text/') || EXT.text.includes(ext)) return 'text';
    return null;
}

export const SENDABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// The plain-words reason shown to the owner when a file cannot be analysed.
export const FAILURE_TEXT = {
    no_text: 'No readable text was found in this file.',
    too_large_to_transcribe: 'This clip is over 25 MB, which is too big to listen to. Upload a shorter clip or just its audio.',
    unsupported: 'This file type is not supported.',
    no_balance: 'Your balance is empty, so the file could not be analysed. Top up and press Retry.',
    unavailable: 'The AI is not reachable right now. Press Retry in a few minutes.',
    download_failed: 'The file could not be opened from storage. Try uploading it again.',
};

// Splits a model-written transcript that uses "--- page N ---" markers into pages.
export function splitPageMarkers(text) {
    const parts = String(text).split(/^\s*-{2,}\s*page\s+(\d+)\s*-{2,}\s*$/gim);
    if (parts.length < 3) return [{ page: null, text: String(text) }];
    const pages = [];
    if (parts[0].trim()) pages.push({ page: null, text: parts[0] });
    for (let i = 1; i < parts.length; i += 2) pages.push({ page: Number(parts[i]), text: parts[i + 1] ?? '' });
    return pages.filter((p) => p.text.trim());
}

const MIN_PDF_TEXT = 80;   // fewer characters than this across the whole file means it is a scan

export function createExtractor({ ai, loadPdfParse, loadMammoth, log = () => {} }) {
    async function readPdfText(buffer) {
        const pdfParse = await loadPdfParse();
        const pages = [];
        await pdfParse(buffer, {
            // Called once per page; collects each page's text on its own so a search result can say which page it came from.
            pagerender: (pageData) => pageData.getTextContent().then((content) => {
                let lastY;
                let text = '';
                for (const item of content.items) {
                    text += lastY === item.transform[5] || lastY === undefined ? item.str : `\n${item.str}`;
                    lastY = item.transform[5];
                }
                pages.push(text);
                return text;
            }),
        });
        return pages.map((text, i) => ({ page: i + 1, text })).filter((p) => p.text.trim());
    }

    return {
        // -> { pages: [{ page, text }], method }
        async extract({ fileType, buffer, fileName, mime, rawText }) {
            if (fileType === 'text') {
                const text = rawText != null ? String(rawText) : buffer.toString('utf8');
                return { pages: [{ page: null, text }], method: 'text' };
            }
            if (fileType === 'document') {
                const mammoth = await loadMammoth();
                const { value } = await mammoth.extractRawText({ buffer });
                return { pages: [{ page: null, text: value }], method: 'docx' };
            }
            if (fileType === 'pdf') {
                let pages = [];
                try { pages = await readPdfText(buffer); } catch (error) { log('warn', `pdf text extraction failed, the model will read it: ${error.message}`); }
                const chars = pages.reduce((n, p) => n + p.text.trim().length, 0);
                if (chars >= MIN_PDF_TEXT) return { pages, method: 'pdf_text' };
                const text = await ai.readPdf({ buffer, fileName });
                return { pages: splitPageMarkers(text), method: 'pdf_model' };
            }
            if (fileType === 'image') {
                return { pages: [{ page: null, text: await ai.describeImage({ buffer, mime }) }], method: 'image_vision' };
            }
            if (fileType === 'audio' || fileType === 'video') {
                return { pages: [{ page: null, text: await ai.transcribe({ buffer, fileName, mime }) }], method: `${fileType}_transcript` };
            }
            throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
        },
    };
}
