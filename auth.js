const form = document.querySelector('#auth-form');
const message = document.querySelector('#form-message');
const modeTabs = [...document.querySelectorAll('.auth-tab')];
const submitButton = document.querySelector('#submit-button');
const modal = document.querySelector('#notice-modal');
let mode = 'login';

function setMessage(text = '', kind = '') {
  message.textContent = text;
  message.className = `form-message ${kind}`;
}

function openModal(title, copy, icon = '☹') {
  document.querySelector('#modal-title').textContent = title;
  document.querySelector('#modal-copy').textContent = copy;
  document.querySelector('#modal-icon').textContent = icon;
  modal.hidden = false;
}

function updateMode(nextMode) {
  mode = nextMode;
  document.querySelector('#form-title').textContent = mode === 'login' ? 'Sign in' : 'Create your account';
  document.querySelector('#form-subtitle').textContent = mode === 'login'
    ? 'Use your institute account to continue.'
    : 'Create an account with your institute email and password.';
  submitButton.innerHTML = mode === 'login' ? 'Sign in <span>→</span>' : 'Create account <span>→</span>';
  document.querySelector('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  modeTabs.forEach(tab => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  setMessage('');
}

modeTabs.forEach(tab => tab.addEventListener('click', () => updateMode(tab.dataset.mode)));

async function api(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  return { response, data };
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  submitButton.disabled = true;
  setMessage('');
  const email = document.querySelector('#email').value.trim().toLowerCase();
  const password = document.querySelector('#password').value;
  try {
    if (mode === 'register') {
      const { response, data } = await api('/api/register', { email, password });
      if (!response.ok) throw new Error(data.message);
      updateMode('login');
      document.querySelector('#email').value = email;
      document.querySelector('#password').value = '';
      setMessage(data.message, 'success');
    } else {
      const { response, data } = await api('/api/login', { email, password });
      if (data.code === 'coming_soon') {
        openModal('The member site is still being built', data.message);
      } else if (!response.ok) {
        throw new Error(data.message);
      } else {
        location.assign('/index.html');
      }
    }
  } catch (error) {
    setMessage(error.message || 'Could not connect to Sentinel. Is the server running?', 'error');
  } finally {
    submitButton.disabled = false;
  }
});

function closeModal() { modal.hidden = true; }
document.querySelector('#modal-close').addEventListener('click', closeModal);
modal.querySelectorAll('[data-dismiss]').forEach(node => node.addEventListener('click', closeModal));
if (new URLSearchParams(location.search).has('locked')) {
  setMessage('Member access is currently closed. The presenter has not opened it yet.', 'error');
}
