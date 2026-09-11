#!/usr/bin/env node

/** Deterministic primary-search gate for normalized jobs. No network or model calls. */

const INELIGIBLE_EMPLOYMENT = /\b(part[- ]time|temporary|seasonal|intern(?:ship)?|fractional|1099[- ]only|consulting[- ]only|contract(?:or)?[- ]only|contract(?:or)?\s+(?:role|position|engagement|basis))\b/i;
const JUNIOR_ROLE = /\b(entry[- ]level|early[- ]career|junior|intern(?:ship)?|trainee|graduate program|development program)\b/i;
const BAD_QUALITY = /\b(commission[- ]only|unpaid|volunteer|1099[- ]only|consulting[- ]only|self[- ]employed|network partner|short[- ]term project|fixed[- ]term project|project[- ]based (?:role|position|engagement))\b/i;
const FULL_TIME = /\b(full[- ]time|permanent|regular employee|employee position)\b/i;
const REMOTE = /\b(remote|work from home|distributed)\b/i;
const ALLOWED_LOCATION = /\b(Colorado|Denver|Longmont|Broomfield|Lakewood)\b/i;
const MONEY = /\$\s*([0-9]{2,3}(?:,[0-9]{3})*|[0-9]+(?:\.\d+)?)\s*(k)?/gi;

function text(value) { return String(value ?? '').trim(); }
function evidenceText(job) { return [job.title, job.location, job.work_arrangement, job.employment_type, job.salary, job.compensation, job.jd_text, job.description].map(text).join(' '); }
function assessment(result, evidence, reason) { return { result, evidence: text(evidence), reason: text(reason) }; }

function compensationAssessment(job, minimumBase) {
  const value = [job.salary, job.compensation, job.jd_text, job.description].map(text).join(' ');
  if (/\b(?:per hour|hourly|\/\s*hour)\b/i.test(value) && !/\b(?:per year|annual|yearly)\b/i.test(value)) return assessment('unknown', '', 'Compensation is hourly rather than an annual range; do not infer an annual equivalent.');
  const matches = [...value.matchAll(MONEY)].map(match => Number(match[1].replaceAll(',', '')) * (match[2] ? 1000 : 1)).filter(Number.isFinite);
  if (!matches.length) return assessment('unknown', '', 'Compensation is not disclosed; this alone is not disqualifying.');
  const highest = Math.max(...matches);
  if (highest < minimumBase) return assessment('inadequate', `$${highest.toLocaleString('en-US')}`, `The disclosed annual compensation is below the primary-search floor of $${minimumBase.toLocaleString('en-US')}.`);
  return assessment('plausible', matches.map(value => `$${value.toLocaleString('en-US')}`).join(', '), 'The disclosed compensation is plausible for the primary search.');
}

export function assessPrimarySearchEligibility(job = {}, { minimumBase = 165000 } = {}) {
  const all = evidenceText(job);
  const title = text(job.title);
  const location = text(job.location);
  const arrangement = [job.work_arrangement, job.remote, job.location].map(text).join(' ');
  const explicitPartTime = INELIGIBLE_EMPLOYMENT.test(`${title} ${text(job.employment_type)} ${text(job.jd_text)} ${text(job.description)}`);
  const hasFullTime = FULL_TIME.test(all);
  const employment = explicitPartTime && !hasFullTime
    ? assessment('ineligible', all.match(INELIGIBLE_EMPLOYMENT)?.[0], 'The posting explicitly describes a non-primary employment structure.')
    : assessment(hasFullTime ? 'full-time' : 'unknown', hasFullTime ? all.match(FULL_TIME)?.[0] : '', hasFullTime ? 'A full-time or permanent employee path is explicit.' : 'Employment type is not explicit; do not convert missing data into part-time.');

  const careerScope = JUNIOR_ROLE.test(`${title} ${text(job.jd_text)} ${text(job.description)}`)
    ? assessment('ineligible', title, 'The role is explicitly junior, intern, trainee, or early-career.')
    : assessment('appropriate', title, 'No clear junior-scope signal was found.');
  const compensation = compensationAssessment(job, minimumBase);
  const locationAssessment = REMOTE.test(arrangement) || ALLOWED_LOCATION.test(location)
    ? assessment('compatible', location, 'The stated location or work arrangement is compatible with the primary search.')
    : location ? assessment('ineligible', location, 'The required location is outside the primary search geography and is not stated as remote.')
      : assessment('unknown', '', 'Location is not sufficiently disclosed.');
  const quality = BAD_QUALITY.test(all)
    ? assessment('ineligible', all.match(BAD_QUALITY)?.[0], 'The opportunity has a fundamental quality problem for the primary search.')
    : assessment('acceptable', '', 'No commission-only, unpaid, volunteer, or clearly short-duration signal was found.');

  const failures = [];
  for (const item of [employment, careerScope, compensation, locationAssessment, quality]) if (item.result === 'ineligible' || item.result === 'inadequate') failures.push(item.reason);
  // Missing compensation is neutral. Only employment/location uncertainty is material to this gate.
  const uncertain = [employment, locationAssessment].some(item => item.result === 'unknown');
  const result = failures.length ? 'ineligible' : uncertain ? 'uncertain' : 'eligible';
  return {
    eligible: result === 'eligible', result, reasons: failures.length ? failures : uncertain ? ['A material eligibility fact remains uncertain and should be confirmed before Apply.'] : ['The role clears the primary-search eligibility gate.'],
    employment_type_assessment: employment,
    career_scope_assessment: careerScope,
    compensation_assessment: compensation,
    location_assessment: locationAssessment,
    opportunity_quality_assessment: quality,
  };
}

export function validatePrimarySearchEligibility(value, name = 'primary_search_eligibility') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const result = text(value.result).toLowerCase();
  if (!['eligible', 'ineligible', 'uncertain'].includes(result)) throw new Error(`${name}.result must be eligible, ineligible, or uncertain`);
  if (typeof value.eligible !== 'boolean') throw new Error(`${name}.eligible must be boolean`);
  if (value.eligible !== (result === 'eligible')) throw new Error(`${name}.eligible must agree with result`);
  if (!Array.isArray(value.reasons) || value.reasons.some(item => !text(item))) throw new Error(`${name}.reasons must be a non-empty-text array`);
  for (const key of ['employment_type_assessment', 'career_scope_assessment', 'compensation_assessment', 'location_assessment', 'opportunity_quality_assessment']) {
    if (!value[key] || typeof value[key] !== 'object' || !text(value[key].result) || !text(value[key].reason)) throw new Error(`${name}.${key} must include result and reason`);
  }
  return { ...value, result, reasons: value.reasons.map(text) };
}
