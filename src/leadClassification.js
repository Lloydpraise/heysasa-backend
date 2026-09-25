export function resolveLeadClassification(nlp = {}, existingLeadType = null) {
  const normalizedNlp = nlp || {};
  const normalizedExisting = typeof existingLeadType === 'string' ? existingLeadType.trim().toLowerCase() : '';
  const rawLeadType = typeof normalizedNlp.lead_type === 'string' ? normalizedNlp.lead_type.trim().toLowerCase() : '';
  const isBusinessChat = normalizedNlp.is_business_chat === true || rawLeadType === 'business';
  const isPersonalChat = normalizedNlp.is_business_chat === false || rawLeadType === 'personal';

  if (normalizedExisting === 'personal') {
    return {
      leadType: 'personal',
      isBusinessChat: false,
      qualityScore: Number.isFinite(normalizedNlp.quality_score) ? Number(normalizedNlp.quality_score) : 1,
      decision: 'manual_personal',
    };
  }

  if (isPersonalChat) {
    return {
      leadType: 'personal',
      isBusinessChat: false,
      qualityScore: Number.isFinite(normalizedNlp.quality_score) ? Number(normalizedNlp.quality_score) : 1,
      decision: 'nlp_personal',
    };
  }

  if (isBusinessChat || normalizedExisting === 'business' || normalizedExisting === 'pending_analysis' || normalizedExisting === 'pending' || normalizedExisting === 'junk') {
    const strongBusinessSignal = isBusinessChat || rawLeadType === 'business';
    const qualityScore = Number.isFinite(normalizedNlp.quality_score)
      ? Number(normalizedNlp.quality_score)
      : (strongBusinessSignal ? 5 : 1);
    const leadType = strongBusinessSignal || qualityScore >= 3 ? 'business' : 'junk';

    return {
      leadType,
      isBusinessChat: leadType === 'business',
      qualityScore,
      decision: leadType === 'business' ? 'nlp_business' : 'nlp_junk',
    };
  }

  return {
    leadType: normalizedExisting || 'business',
    isBusinessChat: normalizedExisting !== 'junk' && normalizedExisting !== 'personal',
    qualityScore: Number.isFinite(normalizedNlp.quality_score) ? Number(normalizedNlp.quality_score) : 1,
    decision: 'preserve_existing',
  };
}
