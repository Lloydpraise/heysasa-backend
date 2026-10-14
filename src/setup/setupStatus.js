// Turns the raw setup row + the current run + a few counts into what Home shows. Plain words, grade 6.

const READY = new Set(['home_ready', 'finishing', 'done']);

export function isHomeReady(setup) {
    if (!setup) return false;
    if (READY.has(setup.status)) return true;
    return setup.status === 'failed' && Number(setup.bundles_done || 0) >= 1; // first leads exist, a later bundle failed
}

function fraction(run) {
    const total = Number(run?.progress_total || 0);
    const done = Number(run?.progress_done || 0);
    return total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
}

export function percentFor(setup, run) {
    if (!setup) return 0;
    const total = Math.max(1, Number(setup.bundles_total || 0));
    const done = Number(setup.bundles_done || 0);
    switch (setup.status) {
        case 'idle': return 0;
        case 'waiting_history': return 5;
        case 'running': return 10 + Math.round(40 * fraction(run));
        case 'home_ready': return Math.min(95, 50 + Math.round(45 * (done / total)));
        case 'finishing': return 97;
        case 'done': return 100;
        case 'failed': return done >= 1 ? Math.min(95, 50 + Math.round(45 * (done / total))) : 0;
        default: return 0;
    }
}

export function plainMessage(setup) {
    if (!setup || setup.status === 'idle') return 'Ready when you are.';
    if (setup.thin) return 'We found very few chats on this number. Your first leads will show up here as they come in.';
    switch (setup.status) {
        case 'waiting_history': return 'Reading your WhatsApp chats...';
        case 'running': return 'Finding your real customers and who is ready to buy...';
        case 'home_ready': return 'Your first leads are ready. We are still checking your older chats.';
        case 'finishing': return 'Finishing the last details...';
        case 'done': return 'All set up.';
        case 'failed': return isHomeReady(setup)
            ? 'Your first leads are ready. Some older chats could not be checked yet, we will try again.'
            : 'Something went wrong while setting up. Tap to try again.';
        default: return '';
    }
}

// counts: { chats, customers, filtered_out, analysed, ready_to_buy, products }
export function shapeSetupStatus({ setup, run = null, counts = {} }) {
    const homeReady = isHomeReady(setup);
    return {
        ok: true,
        status: setup?.status || 'idle',
        home_ready: homeReady,
        percent: percentFor(setup, run),
        message: plainMessage(setup),
        thin: Boolean(setup?.thin),
        bundles: { done: Number(setup?.bundles_done || 0), total: Number(setup?.bundles_total || 0) },
        counters: {
            chats: Number(counts.chats || 0),
            customers: Number(counts.customers || 0),
            filtered_out: Number(counts.filtered_out || 0),
            analysed: Number(counts.analysed || 0),
            ready_to_buy: Number(counts.ready_to_buy || 0),
            products: Number(counts.products || 0),
        },
        answers: setup?.answers || {},
        error: setup?.status === 'failed' ? (setup.error || 'setup_failed') : null,
        started_at: setup?.started_at || null,
        home_ready_at: setup?.home_ready_at || null,
    };
}
