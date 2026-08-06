const fs = require('fs');
const path = require('path');

const DEFAULT_INPUTS = [
  './playwright-load/results/consent-event-capture.json',
  './playwright-load/results/summary-airgap-1user.json',
  './playwright-load/results/summary-airgap-20user.json',
];

const OUTPUT_MARKDOWN = './playwright-load/results/test-execution-report.md';

function readJson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

function padRight(value, width) {
  const text = String(value);
  if (text.length >= width) return text;
  return text + ' '.repeat(width - text.length);
}

function printTable(title, rows) {
  if (!rows.length) return;
  const keyWidth = Math.max('Metric'.length, ...rows.map((r) => r.metric.length));
  const valWidth = Math.max('Value'.length, ...rows.map((r) => String(r.value).length));

  const border = `+-${'-'.repeat(keyWidth)}-+-${'-'.repeat(valWidth)}-+`;
  const header = `| ${padRight('Metric', keyWidth)} | ${padRight('Value', valWidth)} |`;

  console.log(`\n${title}`);
  console.log(border);
  console.log(header);
  console.log(border);
  for (const row of rows) {
    console.log(`| ${padRight(row.metric, keyWidth)} | ${padRight(row.value, valWidth)} |`);
  }
  console.log(border);
}

function toMarkdownTable(rows) {
  if (!rows.length) return '';
  const lines = ['| Metric | Value |', '|---|---|'];
  for (const row of rows) {
    lines.push(`| ${row.metric} | ${String(row.value).replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

function summarizeConsentCapture(json) {
  const validation = json && json.consentPayloadValidation ? json.consentPayloadValidation : {};
  const sample = Array.isArray(validation.sampleCandidates) ? validation.sampleCandidates : [];
  const firstFail = sample.find((x) => x && x.passed === false) || null;

  return [
    { metric: 'Type', value: 'Consent Payload Capture' },
    { metric: 'Scenario', value: json && json.scenario ? json.scenario : 'N/A' },
    { metric: 'Base URL', value: json && json.baseUrl ? json.baseUrl : 'N/A' },
    { metric: 'Validation Passed', value: validation.passed ? 'Yes' : 'No' },
    { metric: 'Candidates Checked', value: validation.checkedCandidates || 0 },
    { metric: 'Failure Reason', value: firstFail && firstFail.reason ? firstFail.reason : '-' },
    {
      metric: 'Mismatch',
      value: firstFail && firstFail.mismatch ? JSON.stringify(firstFail.mismatch) : '-',
    },
  ];
}

function summarizeAirgap(json) {
  const totals = json && json.totals ? json.totals : {};
  const cookie = json && json.cookieBanner ? json.cookieBanner : {};
  const pass = json && json.passCriteria ? json.passCriteria : {};
  const latency = json && json.latencyMs && json.latencyMs.endToEnd ? json.latencyMs.endToEnd : {};

  return [
    { metric: 'Type', value: 'Airgap Load Summary' },
    { metric: 'Scenario', value: json && json.scenario ? json.scenario : 'N/A' },
    { metric: 'Cookie Action', value: json && json.cookieAction ? json.cookieAction : 'N/A' },
    { metric: 'Users', value: json && json.concurrency ? json.concurrency : 'N/A' },
    { metric: 'Requests', value: totals.requests || 0 },
    { metric: 'Success', value: totals.successCount || 0 },
    { metric: 'Failures', value: totals.failureCount || 0 },
    { metric: 'Error Rate %', value: totals.errorRatePct != null ? totals.errorRatePct : 'N/A' },
    { metric: 'Cookie Success %', value: cookie.successRatePct != null ? cookie.successRatePct : 'N/A' },
    { metric: 'Avg End-to-End ms', value: latency.avgMs != null ? latency.avgMs : 'N/A' },
    { metric: 'Passed', value: pass.passed ? 'Yes' : 'No' },
  ];
}

function detectSummaryType(json) {
  if (!json || typeof json !== 'object') return 'unknown';
  if (Object.prototype.hasOwnProperty.call(json, 'consentPayloadValidation')) return 'consent-capture';
  if (Object.prototype.hasOwnProperty.call(json, 'cookieBanner') && Object.prototype.hasOwnProperty.call(json, 'totals')) {
    return 'airgap-summary';
  }
  return 'unknown';
}

function renderReport(inputFiles) {
  const sections = [];

  for (const input of inputFiles) {
    const resolved = path.resolve(input);
    const json = readJson(input);
    if (!json) {
      sections.push({
        title: `Result File: ${input}`,
        rows: [
          { metric: 'Status', value: 'Not found' },
          { metric: 'Path', value: resolved },
        ],
      });
      continue;
    }

    const type = detectSummaryType(json);
    let rows;
    if (type === 'consent-capture') {
      rows = summarizeConsentCapture(json);
    } else if (type === 'airgap-summary') {
      rows = summarizeAirgap(json);
    } else {
      rows = [
        { metric: 'Type', value: 'Unknown summary format' },
        { metric: 'Path', value: resolved },
      ];
    }

    sections.push({
      title: `Result File: ${input}`,
      rows,
    });
  }

  return sections;
}

function writeMarkdownReport(sections, outFile) {
  const lines = [];
  lines.push('# Test Execution Summary');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push('');
    lines.push(toMarkdownTable(section.rows));
    lines.push('');
    lines.push('Screenshot: paste execution screenshot below this line.');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const resolved = path.resolve(outFile);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, lines.join('\n'), 'utf8');
  return resolved;
}

function main() {
  const args = process.argv.slice(2);
  const inputs = args.length ? args : DEFAULT_INPUTS;
  const sections = renderReport(inputs);

  for (const section of sections) {
    printTable(section.title, section.rows);
  }

  const markdownPath = writeMarkdownReport(sections, OUTPUT_MARKDOWN);
  console.log(`\nMarkdown report written to ${markdownPath}`);
}

main();
