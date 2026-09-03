import { fail, pass } from './helpers.mjs';
import {
  matchPriorApplication,
  parseApplicationHistory,
  priorApplicationMessage,
} from '../scan.mjs';

console.log('\nscan.mjs — explicit prior-application history');

const tracker = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-12 | Crusoe | Director, Commercial Operations | N/A | Applied | - | - | Job ID: CR-100. Last activity: 2026-07-01. https://jobs.example.com/job/CR-100 |
| 2 | 2026-07-20 | Crusoe | Director, Financial Planning & Analysis | 4.0/5 | Evaluated | - | - | Evaluated only; no application submitted. |
`;

const history = parseApplicationHistory(tracker);

if (history.length === 1
  && history[0].company === 'Crusoe'
  && history[0].jobTitle === 'Director, Commercial Operations'
  && history[0].applicationDate === '2026-06-12'
  && history[0].status === 'Applied'
  && history[0].lastActivityDate === '2026-07-01'
  && history[0].jobId === 'CR-100'
  && history[0].jobUrl === 'https://jobs.example.com/job/CR-100') {
  pass('application tracker exposes all explicit history fields without inferring missing data');
} else {
  fail('application history field parsing is incomplete: ' + JSON.stringify(history));
}

const exact = matchPriorApplication({
  company: 'Crusoe',
  title: 'Director, Commercial Operations',
  url: 'https://jobs.example.com/job/CR-100',
}, history);
if (exact.kind === 'previously_applied'
  && priorApplicationMessage(exact).includes('Previously applied on 6/12/26')
  && priorApplicationMessage(exact).includes('No recommendation to reapply')) {
  pass('exact prior-application match is suppressed with the required recommendation language');
} else {
  fail('exact prior-application match was not classified correctly: ' + JSON.stringify(exact));
}

const normalized = matchPriorApplication({
  company: 'Crusoe, Inc.',
  title: 'Director - Commercial Operations (Remote)',
  url: 'https://jobs.example.com/opening',
}, history);
if (normalized.kind === 'previously_applied') {
  pass('company formatting, punctuation, and harmless title suffix variations still match');
} else {
  fail('normalized company/title match missed: ' + JSON.stringify(normalized));
}

const distinctRole = matchPriorApplication({
  company: 'Crusoe',
  title: 'Director, Financial Planning & Analysis',
  url: 'https://jobs.example.com/job/FP-200',
}, history);
if (distinctRole.kind === 'none') {
  pass('materially different role at the same company is not falsely matched');
} else {
  fail('different same-company role was falsely matched: ' + JSON.stringify(distinctRole));
}

const newRequisition = matchPriorApplication({
  company: 'Crusoe',
  title: 'Director, Commercial Operations',
  jobId: 'CR-200',
  url: 'https://jobs.example.com/job/CR-200',
}, history);
if (newRequisition.kind === 'possible_repost'
  && newRequisition.reason === 'different requisition ID'
  && priorApplicationMessage(newRequisition).includes('do not recommend reapplying until the change is confirmed')) {
  pass('different requisition is flagged for review rather than suppressed or recommended for reapplication');
} else {
  fail('new requisition behavior is wrong: ' + JSON.stringify(newRequisition));
}

const changedTitle = matchPriorApplication({
  company: 'Crusoe',
  title: 'Senior Director, Commercial Operations and Strategy',
  url: 'https://jobs.example.com/new-role',
}, history);
if (changedTitle.kind === 'possible_repost' && changedTitle.reason === 'materially changed title') {
  pass('materially changed but functionally related title is flagged for review');
} else {
  fail('materially changed title was not flagged for review: ' + JSON.stringify(changedTitle));
}

const unknown = matchPriorApplication({
  company: 'New Industrial Co.',
  title: 'Director, Commercial Operations',
  url: 'https://jobs.example.com/job/NEW-1',
}, history);
if (unknown.kind === 'none') {
  pass('jobs with no application history retain normal screening behavior');
} else {
  fail('job with no history was altered: ' + JSON.stringify(unknown));
}
