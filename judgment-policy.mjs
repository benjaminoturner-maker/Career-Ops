const REQUIREMENT_STRENGTHS = new Set(['hard gate', 'strong preference', 'soft preference', 'neutral context']);
const TOP_TIERS = new Set(['Tier 1', 'Tier 2']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedScore(value) {
  return Number.isFinite(value) ? Math.max(1, Math.min(5, value)) : null;
}

export function applyInterviewCredibilityGate(input = {}) {
  const stage = input.stage === 'evaluated' ? 'evaluated' : 'discovery';
  const sourceChannel = clean(input.sourceChannel) || 'unknown';
  if (stage === 'discovery') {
    return {
      stage, sourceChannel, disposition: 'requires evaluation',
      finalTier: null, fitScore: null, topTierPermitted: false,
      reason: 'Discovery may retain a promising role but cannot emit a final tier or numerical fit score.',
    };
  }
  const requirementStrength = clean(input.requirementStrength).toLowerCase();
  if (!REQUIREMENT_STRENGTHS.has(requirementStrength)) {
    throw new Error('requirementStrength must be hard gate, strong preference, soft preference, or neutral context');
  }
  const hiringIntent = clean(input.hiringIntent);
  const candidatePoolDisadvantage = clean(input.candidatePoolDisadvantage);
  const whyBen = clean(input.whyBen);
  const roleSpecificBridgeEvidence = clean(input.roleSpecificBridgeEvidence);
  const roleSpecificBridge = roleSpecificBridgeEvidence.length > 0;
  if (!hiringIntent || !candidatePoolDisadvantage) {
    throw new Error('hiringIntent and candidatePoolDisadvantage are required before final tiering');
  }
  const proposedTier = clean(input.proposedTier);
  const proposedScore = boundedScore(input.fitScore);
  const topTierPermitted = requirementStrength !== 'hard gate' && roleSpecificBridge && whyBen.length > 0;
  const hardGate = requirementStrength === 'hard gate';
  if (hardGate) {
    return {
      stage, sourceChannel, disposition: 'downgraded by interview-credibility gate',
      finalTier: 'Reject',
      fitScore: proposedScore === null ? null : Math.min(proposedScore, 3.4),
      topTierPermitted: false,
      reason: 'A hard gate is unmet; transferable responsibility overlap cannot overcome it.',
    };
  }
  if (topTierPermitted) {
    return {
      stage, sourceChannel, disposition: 'evaluated',
      finalTier: proposedTier || null, fitScore: proposedScore, topTierPermitted,
      reason: 'A concrete Why Ben rationale and role-supported bridge permit Tier 1 or Tier 2 consideration.',
    };
  }
  if (!TOP_TIERS.has(proposedTier)) {
    return {
      stage, sourceChannel, disposition: 'evaluated with top-tier gate not satisfied',
      finalTier: proposedTier || null,
      fitScore: proposedScore === null ? null : Math.min(proposedScore, 3.9),
      topTierPermitted: false,
      reason: 'Tier 1 and Tier 2 remain prohibited because no concrete Why Ben rationale and role-supported bridge were established.',
    };
  }
  return {
    stage, sourceChannel, disposition: 'downgraded by interview-credibility gate',
    finalTier: 'Tier 3',
    fitScore: proposedScore === null ? null : Math.min(proposedScore, 3.9),
    topTierPermitted: false,
    reason: 'No concrete Why Ben rationale and role-supported bridge were established.',
  };
}

export const interviewCredibilityRequirementStrengths = Object.freeze([
  'hard gate', 'strong preference', 'soft preference', 'neutral context',
]);
