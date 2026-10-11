// Chats that are not customers: personal chats, suppliers, staff and spam. Nothing the engine does on its own
// (campaign enrolment, follow-up drafts, sending) should ever reach them. Matches the types the app and the
// analyser treat as "not a customer".
export const NON_CUSTOMER_TYPES = new Set(['personal', 'vendor', 'staff', 'junk'])
