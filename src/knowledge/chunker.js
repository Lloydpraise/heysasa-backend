// Cuts extracted text into pieces small enough to be found by meaning (one idea or a few lines each), and big enough
// to carry a whole step or a whole price row. Pure: no database, no network.

export const CHUNK_SIZE = 900;      // characters
export const CHUNK_OVERLAP = 120;   // characters repeated at the start of the next piece, so a sentence is never cut off from its context
export const MAX_CHUNKS = 400;      // roughly 360,000 characters per file; anything past it is not indexed

const clean = (text) => String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// Splits one long paragraph on sentence ends, then on spaces, so no piece is bigger than `size`.
function splitLong(text, size) {
    const out = [];
    let rest = text;
    while (rest.length > size) {
        let cut = Math.max(rest.lastIndexOf('. ', size), rest.lastIndexOf('\n', size), rest.lastIndexOf('? ', size), rest.lastIndexOf('! ', size));
        if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
        if (cut < size * 0.3) cut = size;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
}

// One block of text (a page, a transcript) -> pieces of about `size` characters.
export function chunkText(text, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
    const body = clean(text);
    if (!body) return [];
    const parts = body.split(/\n{2,}/).flatMap((p) => (p.length > size ? splitLong(p, size) : [p.trim()])).filter(Boolean);

    const pieces = [];
    let current = '';
    for (const part of parts) {
        if (current && current.length + part.length + 2 > size) {
            pieces.push(current);
            const tail = current.length > overlap ? current.slice(-overlap) : '';
            // Start the next piece with the end of the last one, cut at a word boundary.
            const at = tail.indexOf(' ');
            current = (at >= 0 ? tail.slice(at + 1) : tail).trim();
            current = current ? `${current}\n\n${part}` : part;
        } else {
            current = current ? `${current}\n\n${part}` : part;
        }
    }
    if (current.trim()) pieces.push(current.trim());
    return pieces;
}

// pages: [{ page: 1, text: '...' }]. Returns [{ index, page, content }], capped at MAX_CHUNKS.
export function chunkPages(pages, options = {}) {
    const chunks = [];
    for (const { page = null, text } of pages) {
        for (const content of chunkText(text, options)) {
            chunks.push({ index: chunks.length, page, content });
        }
    }
    return { chunks: chunks.slice(0, MAX_CHUNKS), truncated: chunks.length > MAX_CHUNKS, total: chunks.length };
}
