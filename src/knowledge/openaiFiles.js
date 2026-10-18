// The OpenAI calls used to analyse uploaded files: read a picture, read a scanned PDF, transcribe audio and video,
// write a one-line summary, and turn text into vectors. Plain fetch so tests can fake it. Every call reports its token
// use through `onUsage` so the caller can bill it (runner `knowledge_analysis`), and honours the shared OpenAI gate
// (credits gone or a bad key latches it; a rate limit only makes callers wait).

import {
    classifyOpenAIFailure, getOpenAICooldownMs, getOpenAIAvailabilityState, noteOpenAIRateLimited, setOpenAIUnavailable, shouldPauseOpenAIRequest,
} from '../services/openAiGate.js';

const BASE = 'https://api.openai.com/v1';
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const VISION_MODEL = 'gpt-4.1-mini';
export const SUMMARY_MODEL = 'gpt-4.1-nano';
export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;   // OpenAI's own limit for one transcription upload
export const EMBED_BATCH = 64;

export class OpenAiFilesError extends Error {
    constructor(message, kind = 'other') { super(message); this.kind = kind; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guard(sleepFn) {
    const cooldown = getOpenAICooldownMs();
    if (cooldown > 0) await sleepFn(Math.min(cooldown, 8000));
    if (shouldPauseOpenAIRequest()) throw new OpenAiFilesError(getOpenAIAvailabilityState().message || 'OpenAI is unavailable', 'unavailable');
}

async function failFrom(res) {
    const body = await res.text().catch(() => '');
    const failure = classifyOpenAIFailure({ status: res.status, bodyText: body, headers: res.headers });
    if (failure.kind === 'quota' || failure.kind === 'auth') {
        setOpenAIUnavailable({ status: res.status, reason: body.slice(0, 300), message: "cant call ai on debug 'openai 429 or 401 error'" });
    } else if (failure.kind === 'rate_limit') {
        noteOpenAIRateLimited(failure.retryAfterMs);
    }
    return new OpenAiFilesError(`OpenAI returned ${res.status}: ${body.slice(0, 300)}`, failure.kind);
}

const textOf = (res) => (res?.output ?? [])
    .flatMap((o) => (o.type === 'message' ? (o.content ?? []) : []))
    .map((c) => (c.type === 'output_text' ? c.text : ''))
    .join('').trim();

export function createFileAi({ apiKey, fetchFn = fetch, sleepFn = sleep, onUsage = () => {} }) {
    async function post(path, body, { timeoutMs = 120_000, form = false } = {}) {
        if (!apiKey) throw new OpenAiFilesError('OPENAI_API_KEY is not set', 'auth');
        await guard(sleepFn);
        const res = await fetchFn(`${BASE}${path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, ...(form ? {} : { 'Content-Type': 'application/json' }) },
            body: form ? body : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw await failFrom(res);
        return res.json();
    }

    const responses = async (model, content, maxOutput = 4000) => {
        const res = await post('/responses', { model, store: false, max_output_tokens: maxOutput, input: [{ role: 'user', content }] });
        const u = res?.usage ?? {};
        onUsage({ model, promptTokens: u.input_tokens ?? 0, cachedTokens: u.input_tokens_details?.cached_tokens ?? 0, completionTokens: u.output_tokens ?? 0 });
        return textOf(res);
    };

    return {
        // A picture -> everything written on it, then what it shows. Prices and names are copied exactly.
        async describeImage({ buffer, mime }) {
            const url = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
            return responses(VISION_MODEL, [
                { type: 'input_text', text: 'This image comes from a business that sells to customers on WhatsApp. First write out ALL text visible in the image exactly as written (names, prices, sizes, phone numbers, steps), keeping its order. Then, after a blank line starting with "Picture:", describe in two or three plain sentences what the image shows. If there is no text, only describe it. Do not add anything that is not visible.' },
                { type: 'input_image', image_url: url, detail: 'high' },
            ], 2500);
        },

        // A scanned PDF (no selectable text): the model reads the pages. Returns the text of the whole document.
        async readPdf({ buffer, fileName }) {
            return responses(VISION_MODEL, [
                { type: 'input_text', text: 'Write out all the text of this document exactly as written, in reading order, including tables as plain lines. Separate pages with a line that says "--- page N ---". Do not summarise and do not add anything.' },
                { type: 'input_file', filename: fileName || 'document.pdf', file_data: `data:application/pdf;base64,${buffer.toString('base64')}` },
            ], 12_000);
        },

        // Audio or a video's sound -> the spoken words.
        async transcribe({ buffer, fileName, mime }) {
            if (buffer.length > MAX_TRANSCRIBE_BYTES) throw new OpenAiFilesError('too_large_to_transcribe', 'too_large');
            const form = new FormData();
            form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), fileName || 'clip.mp4');
            form.append('model', TRANSCRIBE_MODEL);
            form.append('response_format', 'json');
            const data = await post('/audio/transcriptions', form, { form: true, timeoutMs: 300_000 });
            const u = data?.usage ?? {};
            onUsage({ model: TRANSCRIBE_MODEL, promptTokens: u.input_tokens ?? 0, cachedTokens: 0, completionTokens: u.output_tokens ?? 0 });
            return String(data?.text ?? '').trim();
        },

        // One or two plain sentences saying what the file is about. Cheap model, short input.
        async summarise(text) {
            const out = await responses(SUMMARY_MODEL, [
                { type: 'input_text', text: `In one or two plain sentences, say what this document is and what it helps with. No quotes, no lists.\n\n${String(text).slice(0, 6000)}` },
            ], 160);
            return out.replace(/\s+/g, ' ').slice(0, 300);
        },

        // Texts -> vectors, in batches. Order is kept. Billed per batch.
        async embedMany(texts) {
            const out = [];
            for (let i = 0; i < texts.length; i += EMBED_BATCH) {
                const batch = texts.slice(i, i + EMBED_BATCH).map((t) => String(t).slice(0, 6000));
                const data = await post('/embeddings', { model: EMBEDDING_MODEL, input: batch }, { timeoutMs: 60_000 });
                const rows = [...(data?.data ?? [])].sort((a, b) => a.index - b.index);
                if (rows.length !== batch.length || rows.some((r) => !Array.isArray(r.embedding))) throw new OpenAiFilesError('OpenAI returned a wrong number of embeddings', 'transient');
                onUsage({ model: EMBEDDING_MODEL, promptTokens: Number(data?.usage?.prompt_tokens ?? data?.usage?.total_tokens ?? 0), cachedTokens: 0, completionTokens: 0 });
                out.push(...rows.map((r) => r.embedding));
            }
            return out;
        },
    };
}
