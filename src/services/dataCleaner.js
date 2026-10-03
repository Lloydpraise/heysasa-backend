export function isGroupOrBroadcast(jid) {
    if (!jid) return true;
    return (
        jid.endsWith('@g.us')        ||
        jid.endsWith('@broadcast')   ||
        jid === 'status@broadcast'   ||
        jid.includes('newsletter')
    );
}

// WhatsApp addresses a chat either by phone number (<digits>@s.whatsapp.net) or by
// an anonymous "LID" (<digits>@lid) when it hides the number - always for people
// who adopt a username. A LID is a routable address, NOT a phone number.
export function isLidJid(jid) {
    return typeof jid === 'string' && /^\d+@lid$/.test(jid.trim());
}

export function isPhoneJid(jid) {
    return typeof jid === 'string' && /^\d+@s\.whatsapp\.net$/.test(jid.trim());
}

export function extractPhone(jid) {
    if (!jid) return null;
    // Never turn a LID into a phone number: its digits are an internal ID, and
    // saving them as `phone` made the sender try to message a number that does
    // not exist. A LID contact keeps the ID in social_id and has phone = null
    // until a real number is learned.
    if (isLidJid(jid)) return null;
    const raw = jid.split('@')[0].replace(/\D/g, '');
    if (!raw || raw.length < 7) return null;
    return `+${raw}`;
}

export function extractMessageJid(msg) {
    const jid = msg?.key?.remoteJid;
    if (jid?.endsWith('@lid') && msg?.key?.remoteJidAlt) return msg.key.remoteJidAlt;
    return jid;
}

// Both identities of a chat when WhatsApp gave us both. `jid` is what
// extractMessageJid has always returned; `altJid` is the other one (the LID when
// jid is the phone JID, or vice versa), so callers can link the two.
export function extractMessageJids(msg) {
    const remote = msg?.key?.remoteJid || null;
    const alt = msg?.key?.remoteJidAlt || null;
    const jid = extractMessageJid(msg);
    const altJid = [remote, alt].find(j => j && j !== jid) || null;
    return { jid, altJid };
}

// A display name worth storing. Rejects what is not really a name: empty,
// "Unknown", purely numeric strings, WhatsApp's own "You" label in Portuguese
// ("Você"), and the business owner's own name (which Evolution reports as the
// pushName on outgoing events).
const PLACEHOLDER_NAMES = new Set(['unknown', 'você', 'voce']);
export function isUsableContactName(name, ownerNames = []) {
    const n = String(name ?? '').trim();
    if (!n) return false;
    const lower = n.toLowerCase();
    if (PLACEHOLDER_NAMES.has(lower)) return false;
    if (/^\+?[\d\s\-().]+$/.test(n)) return false;
    for (const owner of ownerNames) {
        if (owner && lower === String(owner).trim().toLowerCase()) return false;
    }
    return true;
}

function unwrapMessage(msg) {
    let m = msg?.message;
    if (!m) return null;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    return m;
}

export function extractMessageContent(msg) {
    const m = unwrapMessage(msg);
    if (!m) return null;

    if (m.conversation)
        return { text: m.conversation, type: 'text' };
    if (m.extendedTextMessage?.text)
        return { text: m.extendedTextMessage.text, type: 'text', _contextInfo: m.extendedTextMessage.contextInfo || null };
    if (m.imageMessage)
        return { text: m.imageMessage.caption || '', type: 'image', caption: m.imageMessage.caption || '' };
    if (m.audioMessage)
        return { text: '', type: m.audioMessage.ptt ? 'voice_note' : 'audio', duration_seconds: m.audioMessage.seconds || null };
    if (m.videoMessage)
        return { text: m.videoMessage.caption || '', type: 'video', caption: m.videoMessage.caption || '' };
    if (m.documentMessage)
        return { text: m.documentMessage.fileName || '', type: 'document', file_name: m.documentMessage.fileName || '' };
    if (m.stickerMessage)
        return { text: '', type: 'sticker' };
    if (m.reactionMessage)
        // key.id here is the whatsapp_message_id of the message being
        // reacted to (not this reaction event's own id) — needed to
        // attribute the reaction back to a campaign_step_events row.
        return {
            text: m.reactionMessage.text || '',
            type: 'reaction',
            emoji: m.reactionMessage.text || '',
            reactedMessageId: m.reactionMessage.key?.id || null
        };
    if (m.locationMessage)
        return {
            text: `Location: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}`,
            type: 'location',
            latitude: m.locationMessage.degreesLatitude,
            longitude: m.locationMessage.degreesLongitude
        };
    if (m.contactMessage)
        return { text: m.contactMessage.displayName || 'Contact shared', type: 'contact' };
    if (m.buttonsResponseMessage)
        return { text: m.buttonsResponseMessage.selectedDisplayText || m.buttonsResponseMessage.selectedButtonId || '', type: 'button_response' };
    if (m.listResponseMessage)
        return { text: m.listResponseMessage.title || m.listResponseMessage.singleSelectReply?.selectedRowId || '', type: 'list_response' };
    if (m.templateButtonReplyMessage)
        return { text: m.templateButtonReplyMessage.selectedDisplayText || m.templateButtonReplyMessage.selectedId || '', type: 'button_response' };
    if (m.interactiveResponseMessage)
        return { text: m.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson || '', type: 'interactive_response' };

    return { text: '', type: 'unknown' };
}

export function extractAdAttribution(msg) {
    const m = unwrapMessage(msg);
    if (!m) return null;

    const contextInfo =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo         ||
        m.videoMessage?.contextInfo         ||
        m.buttonsResponseMessage?.contextInfo ||
        m.listResponseMessage?.contextInfo   ||
        m.contextInfo                       ||
        null;

    const adReply = contextInfo?.externalAdReply;
    if (!adReply) return null;

    let adPlatform = 'meta';
    const src = (adReply.sourceUrl || '').toLowerCase();
    if (src.includes('instagram')) adPlatform = 'instagram';
    else if (src.includes('facebook') || src.includes('fb.com')) adPlatform = 'facebook';

    return {
        ad_id:            adReply.sourceId     || null,
        ad_headline:      adReply.title        || null,
        ad_body:          adReply.body         || null,
        ad_thumbnail_url: adReply.thumbnailUrl || null,
        ad_source_url:    adReply.sourceUrl    || null,
        ad_platform:      adPlatform,
        captured_at:      new Date().toISOString()
    };
}

export function classifyLeadType(firstMessageText, hasAdAttribution) {
    if (hasAdAttribution) return 'business';
    if (!firstMessageText) return 'pending_analysis';
    const text = firstMessageText.toLowerCase().trim();

    const adPrefillPatterns = [
        /i saw this on/i,
        /saw this product/i,
        /mnauza hii/i,
        /nimeona hii/i,
        /tuma picha/i
    ];
    for (const p of adPrefillPatterns) {
        if (p.test(text)) return 'business';
    }

    return 'pending_analysis';
}

export function extractProductInterests(adData, firstMessageText) {
    const interests = [];
    if (adData?.ad_headline) {
        interests.push(adData.ad_headline.trim());
    } else if (adData?.ad_body) {
        interests.push(adData.ad_body.split(' ').slice(0, 5).join(' ') + '...');
    }
    return interests;
}

export function preScanPayload(payload) {
    const messages = payload.data?.messages || [];
    const contacts = payload.data?.contacts || [];

    const uniqueJids = new Set();
    const outboundImgThumbHashes = new Set();
    let outboundImageCount = 0;

    for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (!jid || isGroupOrBroadcast(jid)) continue;
        if (msg.messageStubType) continue;

        if (!msg.key.fromMe) uniqueJids.add(jid);

        const m = unwrapMessage(msg);
        if (msg.key.fromMe && m?.imageMessage) {
            const thumb = m.imageMessage.jpegThumbnail;
            if (thumb) {
                const key = typeof thumb === 'string'
                    ? thumb.substring(0, 50)
                    : JSON.stringify(thumb).substring(0, 50);
                if (!outboundImgThumbHashes.has(key)) {
                    outboundImgThumbHashes.add(key);
                    outboundImageCount++;
                }
            }
        }
    }

    const contactCount = contacts.filter(c => c.id && !isGroupOrBroadcast(c.id)).length;
    const leadsFound = Math.max(uniqueJids.size, contactCount);

    return { leadsFound, uniqueJids, outboundImageCount, outboundImgThumbHashes };
}