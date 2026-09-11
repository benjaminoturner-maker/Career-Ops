import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPrimarySearchEligibility, validatePrimarySearchEligibility } from '../primary-search-eligibility.mjs';

const base = { title: 'Vice President, Commercial Operations', company: 'Example Energy', location: 'Denver, Colorado', work_arrangement: 'Remote', employment_type: 'Full-time', salary: '$180,000-$220,000', jd_text: 'Lead a technical industrial business and its customer-facing operations.' };
const result = (job = {}) => assessPrimarySearchEligibility({ ...base, ...job });

test('full-time Colorado role clears the primary gate', () => { const value = result(); assert.equal(value.result, 'eligible'); assert.equal(value.eligible, true); });
test('part-time, temporary, internship, seasonal, and fractional roles are ineligible', () => { for (const phrase of ['Part-time', 'Temporary', 'Internship', 'Seasonal', 'Fractional']) assert.equal(result({ title: `${phrase} Commercial Lead`, employment_type: phrase }).result, 'ineligible'); });
test('contract or 1099-only consulting roles are ineligible', () => { for (const phrase of ['1099-only', 'Consulting-only', 'contract position']) assert.equal(result({ employment_type: phrase, title: `Commercial Lead — ${phrase}` }).result, 'ineligible'); });
test('explicit full-time path is not rejected because consultants are mentioned', () => { const value = result({ jd_text: 'This full-time employee role works with external consultants.' }); assert.equal(value.result, 'eligible'); });
test('clearly junior roles are ineligible', () => { assert.equal(result({ title: 'Entry-Level Business Analyst' }).result, 'ineligible'); assert.equal(result({ title: 'Corporate Development Intern', employment_type: 'Internship' }).result, 'ineligible'); });
test('incompatible required location is ineligible', () => { assert.equal(result({ location: 'New York, New York', work_arrangement: 'On-site' }).result, 'ineligible'); });
test('undisclosed compensation is neutral and preserved as unknown', () => { const value = result({ salary: '', jd_text: 'Full-time leadership role in Denver. Compensation discussed during the process.' }); assert.equal(value.result, 'eligible'); assert.equal(value.eligible, true); assert.equal(value.compensation_assessment.result, 'unknown'); });
test('plausible disclosed compensation proceeds and clearly inadequate compensation does not', () => { assert.equal(result({ salary: '$170,000-$190,000' }).result, 'eligible'); assert.equal(result({ salary: '$90,000-$110,000' }).result, 'ineligible'); });
test('ambiguous employment type remains uncertain rather than becoming part-time', () => { const value = result({ employment_type: '', title: 'Commercial Operations Leader' }); assert.equal(value.result, 'uncertain'); assert.equal(value.eligible, false); });
test('commission-only, unpaid, volunteer, and short-duration project roles fail quality', () => { for (const phrase of ['commission-only', 'unpaid', 'volunteer', 'short-term project role']) assert.equal(result({ jd_text: `Full-time opportunity; ${phrase}.` }).result, 'ineligible'); });
test('ordinary project work in a full-time role is not a quality failure', () => { assert.equal(result({ jd_text: 'Full-time role leading project-based initiatives.' }).result, 'eligible'); });
test('Harris historical role is ineligible because it is explicitly part-time', () => { const value = assessPrimarySearchEligibility({ title: 'Senior Executive, Corporate Development, Remote Part Time', location: 'Colorado, United States (Remote)', jd_text: 'This is a part-time executive role.' }); assert.equal(value.result, 'ineligible'); assert.match(value.reasons.join(' '), /non-primary employment|part-time/i); });
test('structured eligibility validation preserves uncertain for Consider', () => { const value = result({ employment_type: '' }); const validated = validatePrimarySearchEligibility(value); assert.equal(validated.result, 'uncertain'); });
