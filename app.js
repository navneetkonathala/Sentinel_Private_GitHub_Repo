const canvas = document.querySelector('#signal-chart');
const context = canvas.getContext('2d');
const pointCount = 60;
const points = [];
const events = [];
const baselineValues = [];
const windowSize = 51;
const minSamples = 12;
const thresholdMultiplier = 3.5;
let sampleNumber = 0;
let paused = false;
let driftEnabled = false;
let injectedMagnitude = 0;
let activeEvent = null;
let totalEvents = 0;

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((first, second) => first - second);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function modelState() {
  const center = baselineValues.length ? median(baselineValues) : 42;
  const mad = median(baselineValues.map(value => Math.abs(value - center)));
  const spread = Math.max(1.4826 * mad, 1e-9);
  return { center, spread, upper: center + thresholdMultiplier * spread, lower: center - thresholdMultiplier * spread, samples: baselineValues.length };
}

function addSample() {
  sampleNumber += 1;
  const state = modelState();
  const drift = driftEnabled ? Math.min(sampleNumber * 0.055, 7) : 0;
  const noise = (Math.random() + Math.random() + Math.random() - 1.5) * 2.2;
  const spike = injectedMagnitude;
  injectedMagnitude = 0;
  const value = 42 + drift + Math.sin(sampleNumber / 7) * 1.3 + noise + spike;
  const warmingUp = state.samples < minSamples;
  const flagged = !warmingUp && (value > state.upper || value < state.lower);
  const score = (value - state.center) / state.spread;
  const direction = value > state.upper ? 'high' : value < state.lower ? 'low' : 'within_range';
  const deviation = value - state.center;
  const point = { value, flagged, status: warmingUp ? 'warming_up' : flagged ? 'anomaly' : 'normal', score, direction, deviation, baseline: state.center, upper: state.upper, lower: state.lower, sample: sampleNumber, time: new Date() };
  points.push(point);
  if (points.length > pointCount) points.shift();
  if (!flagged) {
    baselineValues.push(value);
    if (baselineValues.length > windowSize) baselineValues.shift();
  }
  if (flagged) {
    if (!activeEvent) {
      activeEvent = { startedAt: point.time, startSample: point.sample, lastAnomalyAt: point.time, recoveredAt: null, peak: point, count: 0 };
      events.unshift(activeEvent);
      totalEvents += 1;
      if (events.length > 8) events.pop();
    }
    activeEvent.lastAnomalyAt = point.time;
    activeEvent.count += 1;
    if (Math.abs(point.score) > Math.abs(activeEvent.peak.score)) activeEvent.peak = point;
  } else if (activeEvent) {
    activeEvent.recoveredAt = point.time;
    activeEvent = null;
  }
  renderEvents();
  renderMetrics(point, state);
  renderChart();
}

function formatDuration(event) {
  const end = event.recoveredAt || new Date(event.lastAnomalyAt.getTime() + 900);
  const seconds = Math.max(0.9, (end - event.startedAt) / 1000);
  return seconds < 60 ? `≈${seconds.toFixed(1)} sec` : `≈${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} sec`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderMetrics(point, state) {
  document.querySelector('#current-value').textContent = point.value.toFixed(1);
  document.querySelector('#baseline-value').textContent = state.center.toFixed(1);
  document.querySelector('#threshold-value').textContent = `±${(state.upper - state.center).toFixed(1)}`;
  document.querySelector('#event-count').textContent = totalEvents;
  document.querySelector('#signal-state').textContent = point.status === 'warming_up'
    ? `Learning baseline (${state.samples + 1}/${minSamples})`
    : point.flagged ? 'Significant deviation detected' : 'Within expected range';
  document.querySelector('#signal-state').style.color = point.flagged ? '#b85d3d' : '';
  document.querySelector('#last-event').textContent = events.length ? `Last began at sample ${String(events[0].startSample).padStart(3, '0')}` : 'No anomalies detected';
  document.querySelector('#sample-count').textContent = `SAMPLE ${String(sampleNumber).padStart(3, '0')}`;
  document.querySelector('#event-total').textContent = `${events.length} recent event${events.length === 1 ? '' : 's'}`;
}

function renderEvents() {
  const body = document.querySelector('#event-rows');
  if (!events.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4"><span class="empty-icon">⌁</span> Listening for significant deviations</td></tr>';
    return;
  }
  body.innerHTML = events.map(event => {
    const point = event.peak;
    const outsideBy = point.direction === 'high' ? point.value - point.upper : point.lower - point.value;
    const reason = point.direction === 'high'
      ? `Peak reading is ${outsideBy.toFixed(1)} units above the upper limit.`
      : `Peak reading is ${outsideBy.toFixed(1)} units below the lower limit.`;
    const state = event.recoveredAt ? 'RESOLVED' : 'ONGOING';
    return `<tr><td>${formatTime(event.startedAt)}</td><td>${point.value.toFixed(1)}</td><td class="severity">${point.deviation >= 0 ? '+' : ''}${point.deviation.toFixed(1)}</td><td><span class="status-chip">${state}</span></td></tr><tr class="evidence-row"><td colspan="4"><strong>${reason}</strong> Expected range: ${point.lower.toFixed(1)}–${point.upper.toFixed(1)} units; baseline: ${point.baseline.toFixed(1)}. Robust score: ${point.score.toFixed(2)}. Duration: ${formatDuration(event)} across ${event.count} flagged sample${event.count === 1 ? '' : 's'}.</td></tr>`;
  }).join('');
}

function renderChart() {
  const bounds = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const width = bounds.width;
  const height = bounds.height;
  const pad = { top: 15, right: 10, bottom: 24, left: 38 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const state = modelState();
  const visibleValues = points.flatMap(point => [point.value, point.upper, point.lower]);
  const min = Math.min(visibleValues.length ? Math.min(...visibleValues) : 30, state.lower - 2);
  const max = Math.max(visibleValues.length ? Math.max(...visibleValues) : 54, state.upper + 2);
  const y = value => pad.top + (max - value) / (max - min || 1) * plotHeight;
  const x = index => pad.left + (points.length < 2 ? 0 : index / (pointCount - 1)) * plotWidth;
  context.clearRect(0, 0, width, height);
  context.font = '9px "DM Mono", monospace';
  context.textAlign = 'right';
  for (let line = 0; line <= 4; line += 1) {
    const value = min + (max - min) * line / 4;
    const lineY = y(value);
    context.beginPath(); context.moveTo(pad.left, lineY); context.lineTo(width - pad.right, lineY);
    context.strokeStyle = '#edf0eb'; context.lineWidth = 1; context.stroke();
    context.fillStyle = '#9aa49e'; context.fillText(value.toFixed(0), pad.left - 7, lineY + 3);
  }
  const drawLine = (key, color, dash = []) => {
    context.beginPath();
    points.forEach((point, index) => index ? context.lineTo(x(index), y(point[key])) : context.moveTo(x(index), y(point[key])));
    context.strokeStyle = color; context.lineWidth = 1.2; context.setLineDash(dash); context.stroke(); context.setLineDash([]);
  };
  drawLine('upper', '#bdcec5', [4, 4]);
  drawLine('lower', '#bdcec5', [4, 4]);
  drawLine('baseline', '#304c47', [5, 4]);
  if (points.length > 1) {
    context.beginPath();
    points.forEach((point, index) => index ? context.lineTo(x(index), y(point.value)) : context.moveTo(x(index), y(point.value)));
    context.strokeStyle = '#15947d'; context.lineWidth = 2; context.lineJoin = 'round'; context.lineCap = 'round'; context.stroke();
  }
  points.forEach((point, index) => {
    if (!point.flagged) return;
    context.beginPath(); context.arc(x(index), y(point.value), 4, 0, Math.PI * 2); context.fillStyle = '#dd774a'; context.fill();
    context.beginPath(); context.arc(x(index), y(point.value), 7, 0, Math.PI * 2); context.strokeStyle = 'rgba(221,119,74,.28)'; context.lineWidth = 2; context.stroke();
  });
}

function tick() {
  if (!paused) addSample();
  window.setTimeout(tick, 900);
}

document.querySelector('#inject-button').addEventListener('click', () => {
  injectedMagnitude = (Math.random() < 0.5 ? -1 : 1) * (15 + Math.random() * 5);
  if (paused) addSample();
});
document.querySelector('#drift-button').addEventListener('click', event => {
  driftEnabled = !driftEnabled;
  document.querySelector('#drift-label').textContent = driftEnabled ? 'Stop drift' : 'Simulate drift';
  event.currentTarget.classList.toggle('button-alert', driftEnabled);
});
document.querySelector('#pause-button').addEventListener('click', event => {
  paused = !paused;
  event.currentTarget.textContent = paused ? '▶' : 'Ⅱ';
  event.currentTarget.setAttribute('aria-label', paused ? 'Resume stream' : 'Pause stream');
  document.querySelector('#stream-label').textContent = paused ? 'PAUSED' : 'STREAMING';
  document.querySelector('.stream-indicator').classList.toggle('paused', paused);
});
document.querySelector('#reset-button').addEventListener('click', () => {
  points.length = 0; baselineValues.length = 0; events.length = 0; sampleNumber = 0; totalEvents = 0; activeEvent = null; injectedMagnitude = 0; driftEnabled = false;
  document.querySelector('#drift-label').textContent = 'Simulate drift';
  document.querySelector('#drift-button').classList.remove('button-alert');
  renderEvents(); addSample();
});
document.querySelector('#copy-code').addEventListener('click', async event => {
  const code = document.querySelector('#python-code').innerText;
  try {
    await navigator.clipboard.writeText(code);
    event.currentTarget.innerHTML = '✓ <span>Copied</span>';
    window.setTimeout(() => { event.currentTarget.innerHTML = '▣ <span>Copy</span>'; }, 1600);
  } catch {
    event.currentTarget.innerHTML = 'Select code to copy';
  }
});
canvas.addEventListener('mousemove', event => {
  if (!points.length) return;
  const rect = canvas.getBoundingClientRect();
  const index = Math.max(0, Math.min(points.length - 1, Math.round((event.clientX - rect.left - 38) / (rect.width - 48) * (pointCount - 1))));
  const point = points[index];
  if (!point) return;
  const tooltip = document.querySelector('#chart-tooltip');
  tooltip.textContent = `#${String(point.sample).padStart(3, '0')}  ${point.value.toFixed(2)}  ${point.flagged ? 'ANOMALY' : 'NORMAL'}`;
  tooltip.style.display = 'block';
});
canvas.addEventListener('mouseleave', () => { document.querySelector('#chart-tooltip').style.display = 'none'; });
window.addEventListener('resize', renderChart);
addSample();
tick();

// Offer installation where the browser supports an installable web app.
let installPrompt;
const installButton = document.querySelector('#install-button');
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installButton.hidden = true;
});
window.addEventListener('appinstalled', () => { installButton.hidden = true; });

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

async function configureAccountView() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.user) { location.replace('/login.html'); return; }
    const isAdmin = data.user.role === 'admin';
    const canPresent = isAdmin || data.user.role === 'presenter';
    document.querySelector('#account-label').textContent = data.user.email;
    document.querySelector('#demo-controls').hidden = !(canPresent || data.shared);
    document.querySelector('#admin-access-panel').hidden = !isAdmin;
    document.querySelector('#member-demo-banner').hidden = data.user.role !== 'member';
    if (isAdmin) {
      const status = document.querySelector('#sharing-status');
      const toggle = document.querySelector('#share-toggle');
      const renderSharing = shared => {
        status.textContent = shared
          ? 'Member access is open. Verified institute accounts can now sign in.'
          : 'Member access is closed. Registered users will see the coming-soon message.';
        toggle.textContent = shared
          ? 'Stop sharing with registered users'
          : 'Make this available to everyone who registered';
        toggle.dataset.enabled = String(shared);
      };
      renderSharing(data.shared);
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          const result = await fetch('/api/admin/share', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin', body: JSON.stringify({ enabled: toggle.dataset.enabled !== 'true' })
          });
          const payload = await result.json();
          if (result.ok) renderSharing(payload.shared);
          else status.textContent = payload.message || 'Could not update member access.';
        } catch { status.textContent = 'Could not reach the server.'; }
        finally { toggle.disabled = false; }
      });

      const presenterForm = document.querySelector('#presenter-form');
      const presenterMessage = document.querySelector('#presenter-message');
      const presenterList = document.querySelector('#presenter-list');
      async function refreshPresenters() {
        const response = await fetch('/api/admin/presenters', { credentials: 'same-origin', cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || 'Could not load presenters.');
        presenterList.replaceChildren();
        if (!payload.presenters.length) {
          const empty = document.createElement('span');
          empty.className = 'presenter-empty';
          empty.textContent = 'No additional presenters yet.';
          presenterList.append(empty);
          return;
        }
        payload.presenters.forEach(presenter => {
          const row = document.createElement('div');
          row.className = 'presenter-row';
          const email = document.createElement('span');
          email.textContent = presenter.email;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'presenter-remove';
          remove.textContent = 'Remove access';
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            const result = await fetch('/api/admin/presenters/remove', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin', body: JSON.stringify({ email: presenter.email })
            });
            const answer = await result.json();
            presenterMessage.textContent = answer.message || '';
            if (result.ok) await refreshPresenters();
            else remove.disabled = false;
          });
          row.append(email, remove);
          presenterList.append(row);
        });
      }
      refreshPresenters().catch(error => { presenterMessage.textContent = error.message; });
      presenterForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!presenterForm.reportValidity()) return;
        const submit = presenterForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        presenterMessage.textContent = '';
        try {
          const response = await fetch('/api/admin/presenters', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              email: document.querySelector('#presenter-email').value.trim(),
              password: document.querySelector('#presenter-password').value
            })
          });
          const payload = await response.json();
          presenterMessage.textContent = payload.message || '';
          presenterMessage.classList.toggle('error', !response.ok);
          if (response.ok) {
            presenterForm.reset();
            await refreshPresenters();
          }
        } catch { presenterMessage.textContent = 'Could not reach the server.'; }
        finally { submit.disabled = false; }
      });
    }
  } catch { location.replace('/login.html'); }
}

configureAccountView();
document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } finally { location.replace('/login.html'); }
});
