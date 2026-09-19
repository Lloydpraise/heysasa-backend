export function normalizeWhatsappConnectionRequest(body = {}) {
  const rawMode = typeof body?.mode === 'string' ? body.mode.trim().toLowerCase() : '';

  const phoneCandidates = [
    body?.phoneNumber,
    body?.phone_number,
    body?.phone,
    body?.number,
    body?.mobileNumber,
    body?.mobile_number,
  ];

  const rawPhoneNumber = phoneCandidates.find((value) => value !== undefined && value !== null && value !== '');
  const inferredPhoneNumber = rawPhoneNumber === undefined || rawPhoneNumber === null
    ? null
    : String(rawPhoneNumber).replace(/\D/g, '');

  if (!rawMode) {
    const mode = inferredPhoneNumber ? 'phone' : 'qr';
    return {
      mode,
      phoneNumber: inferredPhoneNumber,
      error: null,
    };
  }

  const mode = rawMode === 'qr'
    ? 'qr'
    : rawMode === 'phone' || rawMode === 'pair' || rawMode === 'pairing'
      ? 'phone'
      : null;

  if (!mode) {
    return {
      mode: null,
      phoneNumber: null,
      error: 'mode_must_be_qr_or_phone',
    };
  }

  const phoneNumber = inferredPhoneNumber;

  if (mode === 'phone' && !phoneNumber) {
    return {
      mode: 'phone',
      phoneNumber: null,
      error: 'phone_number_required',
    };
  }

  return {
    mode,
    phoneNumber,
    error: null,
  };
}
