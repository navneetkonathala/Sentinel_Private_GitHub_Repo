const canvas = document.querySelector('#signal-chart');
const context = canvas.getContext('2d');
const chartWindow = 72;
const NAB_CSV = 'https://raw.githubusercontent.com/numenta/NAB/master/data/realKnownCause/ambient_temperature_system_failure.csv';
const nabWindows = [
  ['2013-12-15 07:00:00', '2013-12-30 09:00:00'],
  ['2014-03-29 15:00:00', '2014-04-20 22:00:00']
];
let rows = [];
let windows = [];
let scored = { result: [] };
let modelResult = null;
let observations = [];
let cursor = 0;
let playing = true;
let timer = null;
let customDataset = false;
let activeDatasetName = '';
let currentUnit = '°F';
let alertLimit = 40;

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}
function parseTime(value) {
  const date = value instanceof Date ? value : new Date(String(value).trim().replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatTime(value) {
  const date = parseTime(value);
  return date ? date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Invalid time';
}
function localInputTime(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 101) throw new Error('CSV needs at least 100 readings to train a model.');
  const headers = lines[0].split(',').map(value => value.trim().replace(/^"|"$/g, '').toLowerCase());
  const timeIndex = headers.findIndex(value => ['timestamp', 'time', 'datetime', 'date'].includes(value));
  const valueIndex = headers.findIndex(value => ['value', 'reading', 'temperature', 'metric'].includes(value));
  const labelIndex = headers.findIndex(value => ['is_anomaly', 'anomaly', 'label', 'is_anomalous'].includes(value));
  if (timeIndex < 0 || valueIndex < 0) throw new Error('CSV must contain timestamp and value columns.');
  const data = [];
  for (const line of lines.slice(1)) {
    const columns = line.split(',').map(value => value.trim().replace(/^"|"$/g, ''));
    const timestamp = parseTime(columns[timeIndex] || '');
    const value = Number(columns[valueIndex]);
    if (timestamp && Number.isFinite(value)) data.push({ timestamp, value, label: labelIndex < 0 ? null : /^(1|true|yes|anomaly|anomalous)$/i.test(columns[labelIndex] || '') });
  }
  if (data.length < 100) throw new Error('Could not read 100 valid timestamp/value rows.');
  data.sort((a, b) => a.timestamp - b.timestamp);
  return data;
}
function labelsFromRows(data) {
  const marked = data.map((row, index) => row.label === true ? index : -1).filter(index => index >= 0);
  const result = [];
  for (const index of marked) {
    const last = result[result.length - 1];
    if (last && index <= last.lastIndex + 1) { last.end = data[index].timestamp; last.lastIndex = index; }
    else result.push({ start: data[index].timestamp, end: data[index].timestamp, lastIndex: index });
  }
  return result.map(({ start, end }) => ({ start, end }));
}

function renderBenchmark() {
  const target = document.querySelector('#benchmark-metrics');
  if (!modelResult) {
    target.innerHTML = '<article><span>EVENT PRECISION</span><b>—</b><small>Waiting for training</small></article><article><span>EVENT RECALL</span><b>—</b><small>Waiting for training</small></article><article><span>EVENT F1</span><b>—</b><small>Waiting for training</small></article><article><span>MEAN DETECTION DELAY</span><b>—</b><small>Waiting for training</small></article><article><span>INFERENCE TIME</span><b>—</b><small>per NAB point</small></article>';
    return;
  }
  const m = modelResult.metrics;
  if (!windows.length) {
    target.innerHTML = `<article><span>EVENT PRECISION</span><b>Not scored</b><small>This file has no ground-truth labels</small></article><article><span>EVENT RECALL</span><b>Not scored</b><small>Load its labels JSON</small></article><article><span>EVENT F1</span><b>Not scored</b><small>Ground truth is required</small></article><article><span>MEAN DETECTION DELAY</span><b>Not scored</b><small>Ground truth is required</small></article><article><span>INFERENCE TIME</span><b>${m.inference_ms_per_sample.toFixed(3)} ms</b><small>per sample · local server</small></article>`;
    return;
  }
  const delay = m.mean_delay_minutes == null ? '—' : m.mean_delay_minutes < 60 ? `${m.mean_delay_minutes.toFixed(0)} min` : `${(m.mean_delay_minutes / 60).toFixed(1)} hr`;
  target.innerHTML = `<article><span>EVENT PRECISION</span><b>${(m.precision * 100).toFixed(1)}%</b><small>${m.tp} matched · ${m.fp} false alert clusters</small></article><article><span>EVENT RECALL</span><b>${(m.recall * 100).toFixed(1)}%</b><small>${m.tp} of ${windows.length} labeled windows detected</small></article><article><span>EVENT F1</span><b>${(m.event_f1 * 100).toFixed(1)}%</b><small>Event-level precision/recall balance</small></article><article><span>MEAN DETECTION DELAY</span><b>${delay}</b><small>from labeled-window start</small></article><article><span>INFERENCE TIME</span><b>${m.inference_ms_per_sample.toFixed(3)} ms</b><small>per sample · local server</small></article>`;
}

function truthState(point) {
  if (!point.truth_known) return ['ALERT · GROUND TRUTH UNKNOWN', 'pending'];
  if (point.truth && point.anomaly) return ['TRUE POSITIVE', 'detected'];
  if (point.truth) return ['FALSE NEGATIVE · MISSED', 'missed'];
  if (point.anomaly) return ['FALSE POSITIVE', 'false-positive'];
  return ['NORMAL', 'normal'];
}

function renderEvents() {
  const body = document.querySelector('#event-rows');
  const benchmarkPoints = scored.result.filter(point => point.anomaly || (point.truth_known && point.truth));
  const benchmarkRows = benchmarkPoints.map(point => {
    const [label, style] = truthState(point);
    return [formatTime(point.timestamp), `${point.value.toFixed(2)} ${currentUnit}`, point.score.toFixed(4), `<span class="status-chip ${style}">${label}</span>`, 'NAB ground truth'];
  });
  const inputRows = observations.slice().sort((a, b) => parseTime(b.timestamp) - parseTime(a.timestamp)).map(item => {
    const predicted = Boolean(item.predicted_anomaly);
    let result = predicted ? 'MODEL FLAG · REVIEW' : 'MODEL NORMAL · REVIEW';
    let style = predicted ? 'false-positive' : 'pending';
    let action = '';
    if (item.review_label === 'normal') { result = predicted ? 'FALSE POSITIVE · CONFIRMED' : 'CONFIRMED NORMAL'; style = predicted ? 'false-positive' : 'normal'; action = 'Training sample'; }
    else if (item.review_label === 'anomaly') { result = predicted ? 'CONFIRMED ANOMALY' : 'FALSE NEGATIVE · CONFIRMED'; style = predicted ? 'detected' : 'missed'; action = 'Excluded from training'; }
    else action = `<button class="review-button" data-id="${item.id}" data-label="normal">Mark normal</button> <button class="review-button" data-id="${item.id}" data-label="anomaly">Mark anomaly</button>`;
    return [formatTime(item.timestamp), `${Number(item.value).toFixed(2)} ${currentUnit}`, Number(item.score).toFixed(4), `<span class="status-chip ${style}">${result}</span>`, action];
  });
  const entries = [...benchmarkRows, ...inputRows];
  body.innerHTML = entries.length ? entries.slice(0, alertLimit).map((cells, index) => `<tr><td>${index + 1}</td>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : '<tr class="empty-row"><td colspan="6"><span class="empty-icon">⌁</span>No anomaly points or saved readings yet.</td></tr>';
  document.querySelector('#event-total').textContent = `${benchmarkRows.length} NAB points · ${observations.length} saved inputs`;
  const moreButton = document.querySelector('#load-more-alerts');
  moreButton.hidden = entries.length <= alertLimit;
  document.querySelector('#alert-range').textContent = entries.length ? `Showing 1–${Math.min(entries.length, alertLimit)} of ${entries.length}` : '';
  body.querySelectorAll('.review-button').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await fetch('/api/observations/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id: Number(button.dataset.id), label: button.dataset.label }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not save review.');
      document.querySelector('#prediction-message').textContent = `${data.message} Retraining with confirmed-normal readings now.`;
      await trainModel();
      await loadObservations();
    } catch (error) { document.querySelector('#prediction-message').textContent = error.message; button.disabled = false; }
  }));
}

function renderMetrics(point) {
  if (!point) return;
  document.querySelector('#current-value').textContent = point.value.toFixed(2);
  document.querySelector('#baseline-value').textContent = Number(point.baseline).toFixed(2);
  document.querySelector('#threshold-value').textContent = modelResult ? modelResult.threshold.toFixed(4) : '—';
  const state = document.querySelector('#signal-state');
  state.textContent = point.anomaly ? `Anomaly · score ${point.score.toFixed(3)}` : 'Within learned pattern';
  state.style.color = point.anomaly ? '#b85d3d' : '';
  document.querySelector('#sample-count').textContent = `SAMPLE ${String(point.index + 1).padStart(4, '0')} / ${rows.length}`;
  document.querySelector('#timeline-slider').max = String(Math.max(0, rows.length - 1));
  document.querySelector('#timeline-slider').value = String(point.index);
  document.querySelector('#chart-start').textContent = formatTime(scored.result[Math.max(0, point.index - chartWindow + 1)].timestamp);
  document.querySelector('#chart-end').textContent = formatTime(point.timestamp);
  const seen = scored.result.slice(0, point.index + 1);
  const flagged = seen.filter(sample => sample.anomaly);
  document.querySelector('#rolling-total').textContent = String(flagged.length);
  const labelsAvailable = flagged.every(sample => sample.truth_known);
  document.querySelector('#rolling-true').textContent = labelsAvailable ? String(flagged.filter(sample => sample.truth).length) : '—';
  document.querySelector('#rolling-false').textContent = labelsAvailable ? String(flagged.filter(sample => !sample.truth).length) : '—';
  document.querySelector('#rolling-count-note').textContent = labelsAvailable
    ? `Replay points seen so far · ${flagged.length} flags · classified using loaded ground-truth labels.`
    : `Replay points seen so far · ${flagged.filter(sample => !sample.truth_known).length} flagged points lack labels, so true/false counts are unavailable.`;
}

function renderChart() {
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !scored.result.length) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(bounds.width * scale); canvas.height = Math.floor(bounds.height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const width = bounds.width, height = bounds.height;
  const visible = scored.result.slice(Math.max(0, cursor - chartWindow + 1), cursor + 1);
  if (!visible.length) return;
  const pad = { top: 18, right: 10, bottom: 26, left: 42 };
  const plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
  const min = Math.min(...visible.map(point => point.value)) - 1;
  const max = Math.max(...visible.map(point => point.value)) + 1;
  const y = value => pad.top + (max - value) / (max - min || 1) * plotHeight;
  const x = index => pad.left + (visible.length < 2 ? 0 : index / (visible.length - 1)) * plotWidth;
  context.clearRect(0, 0, width, height);
  context.font = '9px "DM Mono", monospace'; context.textAlign = 'right';
  for (let line = 0; line <= 4; line += 1) {
    const value = min + (max - min) * line / 4, lineY = y(value);
    context.beginPath(); context.moveTo(pad.left, lineY); context.lineTo(width - pad.right, lineY);
    context.strokeStyle = '#edf0eb'; context.lineWidth = 1; context.stroke();
    context.fillStyle = '#9aa49e'; context.fillText(value.toFixed(1), pad.left - 7, lineY + 3);
  }
  context.beginPath(); visible.forEach((point, index) => index ? context.lineTo(x(index), y(point.baseline)) : context.moveTo(x(index), y(point.baseline)));
  context.strokeStyle = '#304c47'; context.lineWidth = 1.2; context.setLineDash([5, 4]); context.stroke(); context.setLineDash([]);
  context.beginPath(); visible.forEach((point, index) => index ? context.lineTo(x(index), y(point.value)) : context.moveTo(x(index), y(point.value)));
  context.strokeStyle = '#15947d'; context.lineWidth = 2; context.lineJoin = 'round'; context.lineCap = 'round'; context.stroke();
  visible.forEach((point, index) => {
    if (!point.anomaly) return;
    context.beginPath(); context.arc(x(index), y(point.value), 4, 0, Math.PI * 2); context.fillStyle = point.truth ? '#c55e3b' : '#dd774a'; context.fill();
  });
}

function renderAt(index) {
  if (!scored.result.length) return;
  cursor = Math.max(0, Math.min(scored.result.length - 1, index));
  renderMetrics(scored.result[cursor]); renderChart();
  const complete = cursor >= scored.result.length - 1;
  document.querySelector('#stream-label').textContent = complete ? 'COMPLETE' : playing ? 'REPLAYING' : 'PAUSED';
  document.querySelector('.stream-indicator').classList.toggle('paused', !playing || complete);
  document.querySelector('#pause-button').textContent = playing && !complete ? 'Ⅱ Pause' : '▶ Play';
}
function playNext() {
  if (!playing || !scored.result.length) return;
  if (cursor >= scored.result.length - 1) { playing = false; renderAt(cursor); return; }
  renderAt(cursor + 1); timer = window.setTimeout(playNext, 80);
}

function setTrainingUi(training, status) {
  document.querySelector('#model-status').textContent = status;
  document.querySelector('#training-button').disabled = training || !rows.length;
  document.querySelector('#submit-reading').disabled = training || !modelResult;
  document.querySelector('#stream-label').textContent = training ? 'TRAINING' : modelResult ? 'MODEL READY' : 'NO MODEL';
}

async function trainModel() {
  if (!rows.length) return;
  clearTimeout(timer); playing = false;
  setTrainingUi(true, `Training Isolation Forest on NAB normal windows and previously confirmed-normal inputs…`);
  try {
    const response = await fetch('/api/model/train', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ rows: rows.map(row => ({ timestamp: row.timestamp.toISOString(), value: row.value })), windows: windows.map(period => ({ start: period.start.toISOString(), end: period.end.toISOString() })) })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Model training failed.');
    modelResult = payload;
    scored.result = payload.predictions.map((prediction, index) => ({ ...prediction, timestamp: rows[index].timestamp, value: rows[index].value, index, flagged: prediction.anomaly }));
    document.querySelector('#event-count').textContent = windows.length ? payload.metrics.tp : '—';
    document.querySelector('#event-unit').textContent = windows.length ? `of ${windows.length}` : '';
    document.querySelector('#last-event').textContent = windows.length ? `${payload.metrics.fp} false alert clusters · ${payload.metrics.fn} missed windows` : 'No ground truth labels loaded';
    cursor = 0; playing = true;
    renderBenchmark(); renderEvents(); renderAt(0);
    const saved = await loadObservations();
    setTrainingUi(false, `Trained ${payload.model} · ${payload.trees} trees · ${payload.training_count.toLocaleString()} clean readings (${payload.user_training_count} confirmed-normal inputs). Each flagged point appears below.`);
    document.querySelector('#submit-reading').disabled = false;
    document.querySelector('#training-button').disabled = false;
    timer = window.setTimeout(playNext, 500);
    return saved;
  } catch (error) {
    modelResult = null; setTrainingUi(false, `Training failed: ${error.message}`);
    document.querySelector('#prediction-message').textContent = 'The model must train successfully before new readings can be checked.';
  }
}

async function loadObservations() {
  const response = await fetch('/api/observations', { credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'Could not load saved readings.');
  observations = payload.observations || [];
  renderEvents();
  return observations;
}

async function reviewSubmittedReading(label) {
  const dialog = document.querySelector('#reading-result-dialog');
  const status = document.querySelector('#reading-result-status');
  const buttons = dialog.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = label === 'normal' ? 'Saving your confirmation, then retraining with this normal reading…' : 'Saving your confirmation, then refreshing the model without this reading…';
  try {
    const response = await fetch('/api/observations/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ id: Number(dialog.dataset.observationId), label })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Could not save your review.');
    await trainModel();
    if (!modelResult) throw new Error('Your review was saved, but the model could not be retrained. Use Train / refresh model to try again.');
    status.textContent = label === 'normal'
      ? 'Confirmed normal and included in the refreshed training model.'
      : 'Confirmed anomaly and kept out of the training data. The model has been refreshed.';
    await loadObservations();
    dialog.close();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function loadData(data, truthWindows, isCustom, message) {
  rows = data; windows = truthWindows; customDataset = isCustom;
  alertLimit = 40;
  currentUnit = isCustom ? 'value' : '°F';
  modelResult = null; scored = { result: [] }; cursor = 0;
  document.querySelector('#dataset-source').innerHTML = isCustom ? 'UPLOADED SERIES · LOCAL CSV <span class="tiny-pulse"></span>' : 'NAB PUBLIC TEMPERATURE SERIES · REAL DATA <span class="tiny-pulse"></span>';
  document.querySelector('#dataset-message').textContent = message;
  document.querySelector('#signal-title').textContent = isCustom ? 'Uploaded time-series monitor' : 'Office temperature anomaly monitor';
  document.querySelector('#reading-unit').textContent = currentUnit;
  document.querySelector('#chart-y-label').textContent = isCustom ? 'VALUE' : 'TEMPERATURE · °F';
  document.querySelector('#member-demo-banner').hidden = false;
  renderBenchmark(); renderEvents();
  return trainModel();
}

async function loadPublicDataset() {
  const message = document.querySelector('#dataset-message');
  try {
    const response = await fetch(NAB_CSV, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`NAB file request failed (${response.status}).`);
    const data = parseCsv(await response.text());
    const truth = nabWindows.map(([start, end]) => ({ start: parseTime(start), end: parseTime(end) }));
    await loadData(data, truth, false, `Loaded ${data.length.toLocaleString()} hourly readings from the public NAB ambient-temperature series. Labeled anomaly windows are excluded from training and used only for evaluation. This is not the organizer’s hidden-test subset.`);
    document.querySelector('#dataset-file').disabled = false;
  } catch (error) {
    message.textContent = `Could not load or train the public example: ${error.message} Use “Load challenge CSV” to choose the organizer data.`;
    document.querySelector('#dataset-source').textContent = 'NAB DATA UNAVAILABLE · CSV UPLOAD READY';
    document.querySelector('#stream-label').textContent = 'NO DATA';
  }
}

document.querySelector('#pause-button').addEventListener('click', () => {
  playing = !playing; clearTimeout(timer);
  if (playing) playNext(); else renderAt(cursor);
});
document.querySelector('#load-more-alerts').addEventListener('click', () => {
  alertLimit += 40;
  renderEvents();
});
document.querySelector('#reset-button').addEventListener('click', () => {
  clearTimeout(timer); cursor = 0; playing = true; renderAt(0); timer = window.setTimeout(playNext, 80);
});
document.querySelector('#timeline-slider').addEventListener('input', event => { clearTimeout(timer); playing = false; renderAt(Number(event.target.value)); });
document.querySelector('#training-button').addEventListener('click', trainModel);
document.querySelector('#dataset-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const data = parseCsv(await file.text()); activeDatasetName = file.name;
    const truth = data.some(row => row.label !== null) ? labelsFromRows(data) : [];
    await loadData(data, truth, true, `Loaded ${data.length.toLocaleString()} readings from ${file.name}. If this dataset uses separate NAB labels, load its windows JSON before treating scores as challenge results.`);
  } catch (error) { document.querySelector('#dataset-message').textContent = error.message; }
  event.target.value = '';
});
document.querySelector('#labels-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (!rows.length || !customDataset) throw new Error('Load the challenge CSV first, then its labels JSON.');
    const parsed = JSON.parse(await file.text());
    const matching = Array.isArray(parsed) ? parsed : Object.entries(parsed).find(([key]) => key === activeDatasetName || key.endsWith(`/${activeDatasetName}`))?.[1] || parsed.windows;
    if (!Array.isArray(matching)) throw new Error(`No label windows found for ${activeDatasetName}.`);
    const loaded = matching.map(item => Array.isArray(item) ? { start: parseTime(item[0]), end: parseTime(item[1]) } : { start: parseTime(item.start || item.startTime), end: parseTime(item.end || item.endTime) }).filter(item => item.start && item.end);
    if (!loaded.length) throw new Error('No anomaly windows found for this series in the selected JSON.');
    await loadData(rows, loaded, true, `Loaded ${loaded.length} NAB anomaly windows from ${file.name}. Those windows are kept out of model training and used for scoring only.`);
  } catch (error) { document.querySelector('#dataset-message').textContent = error.message; }
  event.target.value = '';
});

document.querySelector('#reading-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!modelResult) return;
  const timestamp = parseTime(document.querySelector('#reading-time').value);
  const value = Number(document.querySelector('#reading-value').value);
  if (!timestamp || !Number.isFinite(value)) return;
  const submit = document.querySelector('#submit-reading'); submit.disabled = true;
  const message = document.querySelector('#prediction-message'); message.textContent = 'Saving the reading and checking it with the trained Isolation Forest…';
  try {
    const response = await fetch('/api/observations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ timestamp: timestamp.toISOString(), value }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Could not score this reading.');
    message.textContent = `${payload.observation.message} Saved to your account database; review the result in the popup.`;
    await loadObservations();
    const dialog = document.querySelector('#reading-result-dialog');
    const detected = payload.observation.anomaly;
    dialog.dataset.observationId = String(payload.observation.id);
    document.querySelector('#reading-result-mark').textContent = detected ? '!' : '✓';
    document.querySelector('#reading-result-mark').classList.toggle('is-anomaly', detected);
    document.querySelector('#reading-result-title').textContent = detected ? 'Anomaly detected' : 'No anomaly detected';
    document.querySelector('#reading-result-summary').textContent = `${formatTime(payload.observation.timestamp)} · ${payload.observation.value.toFixed(2)} ${currentUnit}. Isolation Forest score ${payload.observation.score.toFixed(4)}; anomaly cutoff ${modelResult.threshold.toFixed(4)}.`;
    document.querySelector('#reading-result-status').textContent = detected
      ? 'This unusual reading is stored but excluded from training until you review it.'
      : 'This reading looks normal. Confirm it below if it should become a training example.';
    document.querySelector('#result-mark-normal').textContent = 'Confirm normal · add to training';
    document.querySelector('#result-mark-anomaly').textContent = 'Confirm anomaly · exclude';
    document.querySelector('#reading-result-dialog').showModal();
    document.querySelector('#reading-form').reset();
    document.querySelector('#reading-time').value = localInputTime();
  } catch (error) { message.textContent = error.message; }
  finally { submit.disabled = !modelResult; }
});

document.querySelector('#result-dialog-close').addEventListener('click', () => document.querySelector('#reading-result-dialog').close());
document.querySelector('#result-mark-normal').addEventListener('click', () => reviewSubmittedReading('normal'));
document.querySelector('#result-mark-anomaly').addEventListener('click', () => reviewSubmittedReading('anomaly'));

canvas.addEventListener('mousemove', event => {
  if (!scored.result.length) return;
  const rect = canvas.getBoundingClientRect();
  const start = Math.max(0, cursor - chartWindow + 1), visibleLength = cursor - start + 1;
  const index = Math.max(0, Math.min(visibleLength - 1, Math.round((event.clientX - rect.left - 42) / (rect.width - 52) * (visibleLength - 1))));
  const point = scored.result[start + index];
  const tooltip = document.querySelector('#chart-tooltip');
  const evidence = !point.truth_known ? 'GROUND TRUTH UNKNOWN' : point.anomaly ? (point.truth ? 'TRUE-POSITIVE WINDOW' : 'FALSE POSITIVE') : point.truth ? 'MISSED LABELED WINDOW' : 'NORMAL';
  tooltip.textContent = `${formatTime(point.timestamp)} · ${point.value.toFixed(2)} ${currentUnit} · IF ${point.score.toFixed(4)} · ${evidence}`;
  tooltip.style.display = 'block';
});
canvas.addEventListener('mouseleave', () => { document.querySelector('#chart-tooltip').style.display = 'none'; });
window.addEventListener('resize', renderChart);

let installPrompt;
const installButton = document.querySelector('#install-button');
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; installButton.hidden = false; });
installButton.addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; installButton.hidden = true; });
window.addEventListener('appinstalled', () => { installButton.hidden = true; });
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));

async function configureAccountView() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.user) { location.replace('/login.html'); return; }
    const isAdmin = data.user.role === 'admin';
    document.querySelector('#account-label').textContent = data.user.email;
    document.querySelector('#admin-access-panel').hidden = !isAdmin;
    document.querySelector('#member-demo-banner').hidden = false;
    if (isAdmin) {
      const status = document.querySelector('#sharing-status'), toggle = document.querySelector('#share-toggle');
      const renderSharing = shared => {
        status.textContent = shared ? 'Member access is open. Verified institute accounts can now sign in.' : 'Member access is closed. Registered users will see the coming-soon message.';
        toggle.textContent = shared ? 'Stop sharing with registered users' : 'Make this available to everyone who registered';
        toggle.dataset.enabled = String(shared);
      };
      renderSharing(data.shared);
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          const result = await fetch('/api/admin/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ enabled: toggle.dataset.enabled !== 'true' }) });
          const payload = await result.json(); if (result.ok) renderSharing(payload.shared); else status.textContent = payload.message || 'Could not update access.';
        } catch { status.textContent = 'Could not reach the server.'; } finally { toggle.disabled = false; }
      });
      const presenterForm = document.querySelector('#presenter-form'), presenterMessage = document.querySelector('#presenter-message'), presenterList = document.querySelector('#presenter-list');
      async function refreshPresenters() {
        const result = await fetch('/api/admin/presenters', { credentials: 'same-origin', cache: 'no-store' }), payload = await result.json();
        if (!result.ok) throw new Error(payload.message || 'Could not load presenters.');
        presenterList.replaceChildren();
        if (!payload.presenters.length) { const empty = document.createElement('span'); empty.className = 'presenter-empty'; empty.textContent = 'No additional presenters yet.'; presenterList.append(empty); return; }
        payload.presenters.forEach(presenter => {
          const row = document.createElement('div'); row.className = 'presenter-row'; const email = document.createElement('span'); email.textContent = presenter.email;
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'presenter-remove'; remove.textContent = 'Remove access';
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            const result = await fetch('/api/admin/presenters/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email: presenter.email }) });
            const answer = await result.json(); presenterMessage.textContent = answer.message || ''; if (result.ok) await refreshPresenters(); else remove.disabled = false;
          }); row.append(email, remove); presenterList.append(row);
        });
      }
      refreshPresenters().catch(error => { presenterMessage.textContent = error.message; });
      presenterForm.addEventListener('submit', async event => {
        event.preventDefault(); if (!presenterForm.reportValidity()) return;
        const submit = presenterForm.querySelector('button[type="submit"]'); submit.disabled = true;
        try {
          const result = await fetch('/api/admin/presenters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email: document.querySelector('#presenter-email').value.trim(), password: document.querySelector('#presenter-password').value }) });
          const payload = await result.json(); presenterMessage.textContent = payload.message || ''; presenterMessage.classList.toggle('error', !result.ok);
          if (result.ok) { presenterForm.reset(); await refreshPresenters(); }
        } catch { presenterMessage.textContent = 'Could not reach the server.'; } finally { submit.disabled = false; }
      });
    }
  } catch { location.replace('/login.html'); }
}

configureAccountView();
document.querySelector('#logout-button').addEventListener('click', async () => { try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } finally { location.replace('/login.html'); } });
document.querySelector('#copy-code')?.addEventListener('click', async event => {
  try { await navigator.clipboard.writeText(document.querySelector('#python-code').innerText); event.currentTarget.innerHTML = '✓ <span>Copied</span>'; }
  catch { event.currentTarget.innerHTML = 'Select code to copy'; }
  window.setTimeout(() => { event.currentTarget.innerHTML = '▣ <span>Copy</span>'; }, 1600);
});
document.querySelector('#reading-time').value = localInputTime();
loadPublicDataset();
