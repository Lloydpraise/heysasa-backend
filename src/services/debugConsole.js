const MAX_EVENTS = 500;
const events = [];
const clients = new Set();
let nextId = 1;

function safeValue(value) {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (typeof value === 'string') return value.length > 5000 ? `${value.slice(0, 5000)}...` : value;
    if (value === undefined) return null;
    try {
        const json = JSON.stringify(value);
        return json.length > 15000 ? `${json.slice(0, 15000)}...` : JSON.parse(json);
    } catch {
        return String(value);
    }
}

export function debugLog(level, step, message, details = {}) {
    const event = {
        id: nextId++,
        time: new Date().toISOString(),
        level,
        step,
        message,
        details: safeValue(details),
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of clients) response.write(payload);
    return event;
}

export function getDebugEvents() {
    return events;
}

export function attachDebugClient(response) {
    response.write(`data: ${JSON.stringify({ type: 'snapshot', events })}\n\n`);
    clients.add(response);
    response.on('close', () => clients.delete(response));
}