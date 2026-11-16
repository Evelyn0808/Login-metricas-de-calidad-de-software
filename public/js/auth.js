(function () {
  'use strict';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const NAME_RE = /^[\p{L}][\p{L}\s'.-]{1,79}$/u;

  const message = document.getElementById('message');
  const messageText = document.getElementById('message-text');

  function hideAlert() {
    if (!message) return;
    message.classList.remove('is-visible', 'is-success');
    message.setAttribute('aria-hidden', 'true');
    if (messageText) messageText.textContent = '';
  }

  function showAlert(text, type) {
    if (!message || !messageText) return;
    messageText.textContent = text;
    message.classList.toggle('is-success', type === 'success');
    message.classList.add('is-visible');
    message.setAttribute('aria-hidden', 'false');
  }

  function markInvalid(input, invalid) {
    if (!input) return;
    if (invalid) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  }

  function clearFormErrors(form) {
    form.querySelectorAll('[aria-invalid="true"]').forEach((el) => markInvalid(el, false));
  }

  function setLoading(button, loading) {
    if (!button) return;
    button.disabled = loading;
    button.classList.toggle('is-loading', loading);
    button.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  async function api(url, options) {
    let res;
    try {
      res = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
    } catch (_) {
      throw new Error('No se pudo conectar con el servidor. Revisa tu conexión.');
    }

    let data = {};
    try {
      data = await res.json();
    } catch (_) {}

    if (!res.ok) {
      const error = new Error(data.error || 'Ocurrió un error inesperado.');
      error.status = res.status;
      error.fields = data.fields || null;
      error.data = data;
      throw error;
    }
    return data;
  }

  // ---------------------------------------------------------------------
  // Validaciones
  // ---------------------------------------------------------------------

  function isValidCedula(value) {
    if (!/^\d{10}$/.test(value)) return false;
    const province = Number(value.slice(0, 2));
    if (!((province >= 1 && province <= 24) || province === 30)) return false;
    if (Number(value[2]) >= 6) return false;

    const coefficients = [2, 1, 2, 1, 2, 1, 2, 1, 2];
    let total = 0;
    for (let i = 0; i < 9; i += 1) {
      let product = Number(value[i]) * coefficients[i];
      if (product > 9) product -= 9;
      total += product;
    }
    return (10 - (total % 10)) % 10 === Number(value[9]);
  }

  function passwordByteLength(value) {
    return new TextEncoder().encode(value).length;
  }

  // Restringir a dígitos SOLO en el formulario de registro (cédula ecuatoriana)
  const registerCedulaInput = document.querySelector('#register-form input[name="cedula"]');
  if (registerCedulaInput) {
    registerCedulaInput.addEventListener('input', () => {
      const clean = registerCedulaInput.value.replace(/\D/g, '').slice(0, 10);
      if (clean !== registerCedulaInput.value) registerCedulaInput.value = clean;
      markInvalid(registerCedulaInput, false);
      hideAlert();
    });
  }

  // ---------------------------------------------------------------------
  // Mostrar / ocultar contraseña
  // ---------------------------------------------------------------------

  const toggle = document.getElementById('toggle-password');
  const passwordInput = document.getElementById('password');

  if (toggle && passwordInput) {
    toggle.addEventListener('click', () => {
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      toggle.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');

      const end = passwordInput.value.length;
      passwordInput.focus({ preventScroll: true });
      try {
        passwordInput.setSelectionRange(end, end);
      } catch (_) {}
    });
  }

  // ---------------------------------------------------------------------
  // CAPTCHA aleatorio (1 de 3 opciones al azar por cada carga o intento)
  // 1. Casilla simple ("No soy un robot")
  // 2. Selección de imágenes (semáforos, bicicletas, autos)
  // 3. Desafío matemático básico (suma o resta sencilla)
  // ---------------------------------------------------------------------

  const captchaContainer = document.getElementById('captcha-container');
  let currentCaptcha = {
    type: null,
    solved: false,
    mathAnswer: null,
    targetCategory: null,
    targetTileIndices: [],
    selectedTileIndices: new Set(),
  };

  const SVG_ICONS = {
    robot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8.01" y2="16"></line><line x1="16" y1="16" x2="16.01" y2="16"></line></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    reload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path></svg>`,
    trafficLight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="3"></rect><circle cx="12" cy="6" r="1.8" fill="currentColor"></circle><circle cx="12" cy="12" r="1.8" fill="currentColor"></circle><circle cx="12" cy="18" r="1.8" fill="currentColor"></circle></svg>`,
    bicycle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5.5" cy="17.5" r="3.5"></circle><circle cx="18.5" cy="17.5" r="3.5"></circle><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5L8.5 8h3l2.5 5 3.5-3.5h3"></path></svg>`,
    car: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 3c-.1.2-.1.4-.1.6v4.5c0 .6.4 1 1 1h2"></path><circle cx="7" cy="17" r="2"></circle><circle cx="17" cy="17" r="2"></circle></svg>`,
    airplane: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3.5c-.5-.5-2.5 0-4 1.5L13.5 8.5 5.3 6.7c-.7-.2-1.4.2-1.7.8l-.5 1 5.5 3.5-3 3-2-.5-1 .5 1.5 2 2 1.5.5-1-.5-2 3-3 3.5 5.5 1-.5c.6-.3 1-1 .8-1.7z"></path></svg>`,
    boat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 20a2.4 2.4 0 0 0 2 1 2.4 2.4 0 0 0 2-1 2.4 2.4 0 0 1 2-1 2.4 2.4 0 0 1 2 1 2.4 2.4 0 0 0 2 1 2.4 2.4 0 0 0 2-1 2.4 2.4 0 0 1 2-1 2.4 2.4 0 0 1 2 1 2.4 2.4 0 0 0 2 1 2.4 2.4 0 0 0 2-1"></path><path d="M4 18L2 13h20l-2 5"></path><path d="M12 13V4l4 3-4 3"></path></svg>`,
    train: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="16" rx="2"></rect><path d="M4 11h16"></path><path d="M12 3v8"></path><path d="m8 19-2 3"></path><path d="m16 19 2 3"></path><circle cx="8" cy="15" r="1"></circle><circle cx="16" cy="15" r="1"></circle></svg>`,
  };

  function renderRandomCaptcha() {
    if (!captchaContainer) return;
    const types = ['checkbox', 'images', 'math'];
    const chosen = types[Math.floor(Math.random() * types.length)];

    currentCaptcha = {
      type: chosen,
      solved: false,
      mathAnswer: null,
      targetCategory: null,
      targetTileIndices: [],
      selectedTileIndices: new Set(),
    };
    captchaContainer.classList.remove('is-verified');

    if (chosen === 'checkbox') {
      renderCheckboxCaptcha();
    } else if (chosen === 'math') {
      renderMathCaptcha();
    } else {
      renderImagesCaptcha();
    }
  }

  // 1. Casilla de verificación simple ("No soy un robot")
  function renderCheckboxCaptcha() {
    captchaContainer.innerHTML = `
      <div class="captcha-header">
        <div class="captcha-title-wrap">${SVG_ICONS.robot} <span>Seguridad</span></div>
        <button type="button" class="btn-reload-captcha" title="Cambiar prueba de seguridad" aria-label="Cambiar prueba">${SVG_ICONS.reload}</button>
      </div>
      <div class="captcha-checkbox-row" id="captcha-checkbox-trigger" role="checkbox" aria-checked="false" tabindex="0">
        <div class="captcha-checkbox-left">
          <div class="captcha-box-square">
            <span class="captcha-spinner-mini" id="captcha-spinner"></span>
            ${SVG_ICONS.check}
          </div>
          <span class="captcha-label-text">No soy un robot</span>
        </div>
        <div class="captcha-logo-badge">
          ${SVG_ICONS.robot}
          <span>reCAPTCHA</span>
        </div>
      </div>
    `;

    const row = document.getElementById('captcha-checkbox-trigger');
    const spinner = document.getElementById('captcha-spinner');
    const btnReload = captchaContainer.querySelector('.btn-reload-captcha');

    btnReload.addEventListener('click', (e) => {
      e.stopPropagation();
      renderRandomCaptcha();
    });

    const activate = () => {
      if (currentCaptcha.solved) return;
      if (spinner) spinner.style.display = 'block';

      setTimeout(() => {
        if (spinner) spinner.style.display = 'none';
        row.classList.add('is-active');
        row.setAttribute('aria-checked', 'true');
        captchaContainer.classList.add('is-verified');
        currentCaptcha.solved = true;
        hideAlert();
      }, 350);
    };

    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        activate();
      }
    });
  }

  // 2. Desafío Matemático básico
  function renderMathCaptcha() {
    const isAddition = Math.random() > 0.4;
    let n1, n2, answer, expr;

    if (isAddition) {
      n1 = Math.floor(Math.random() * 11) + 2; // 2..12
      n2 = Math.floor(Math.random() * 9) + 1; // 1..9
      answer = n1 + n2;
      expr = `${n1} + ${n2}`;
    } else {
      n1 = Math.floor(Math.random() * 11) + 10; // 10..20
      n2 = Math.floor(Math.random() * 8) + 1; // 1..8
      answer = n1 - n2;
      expr = `${n1} - ${n2}`;
    }

    currentCaptcha.mathAnswer = answer;

    captchaContainer.innerHTML = `
      <div class="captcha-header">
        <div class="captcha-title-wrap">${SVG_ICONS.robot} <span>Desafío matemático</span></div>
        <button type="button" class="btn-reload-captcha" title="Cambiar prueba de seguridad" aria-label="Cambiar prueba">${SVG_ICONS.reload}</button>
      </div>
      <div class="captcha-math-row">
        <div class="captcha-math-question">
          ¿Cuánto es <span class="captcha-math-pill">${expr}</span> ?
        </div>
        <div class="input-wrap captcha-math-input-wrap">
          <input
            id="captcha-math-input"
            type="number"
            inputmode="numeric"
            placeholder="?"
            autocomplete="off"
            required
          />
        </div>
      </div>
    `;

    const input = document.getElementById('captcha-math-input');
    const btnReload = captchaContainer.querySelector('.btn-reload-captcha');

    btnReload.addEventListener('click', () => renderRandomCaptcha());

    input.addEventListener('input', () => {
      const val = parseInt(input.value, 10);
      if (!isNaN(val) && val === currentCaptcha.mathAnswer) {
        currentCaptcha.solved = true;
        captchaContainer.classList.add('is-verified');
        markInvalid(input, false);
        hideAlert();
      } else {
        currentCaptcha.solved = false;
        captchaContainer.classList.remove('is-verified');
      }
    });
  }

  // 3. Selección de Imágenes
  function renderImagesCaptcha() {
    const categories = [
      { key: 'semáforos', icon: 'trafficLight', label: 'Semáforos' },
      { key: 'bicicletas', icon: 'bicycle', label: 'Bicicletas' },
      { key: 'autos', icon: 'car', label: 'Autos' },
    ];
    const target = categories[Math.floor(Math.random() * categories.length)];
    const distractors = ['airplane', 'boat', 'train'].filter((k) => k !== target.icon);

    currentCaptcha.targetCategory = target.key;
    currentCaptcha.targetTileIndices = [];
    currentCaptcha.selectedTileIndices = new Set();

    // 9 casillas: 3 o 4 son del target, las demás son distractores
    const numTargets = Math.random() > 0.5 ? 3 : 4;
    const tilePool = [];

    for (let i = 0; i < numTargets; i++) {
      tilePool.push({ isTarget: true, icon: target.icon, label: target.label });
    }
    while (tilePool.length < 9) {
      const dist = distractors[Math.floor(Math.random() * distractors.length)];
      const labelMap = { airplane: 'Avión', boat: 'Barco', train: 'Tren' };
      tilePool.push({ isTarget: false, icon: dist, label: labelMap[dist] || 'Vehículo' });
    }

    // Mezclar las casillas
    tilePool.sort(() => Math.random() - 0.5);
    tilePool.forEach((t, idx) => {
      if (t.isTarget) currentCaptcha.targetTileIndices.push(idx);
    });

    let tilesHtml = '';
    tilePool.forEach((tile, idx) => {
      tilesHtml += `
        <div class="captcha-tile" data-index="${idx}" role="button" tabindex="0">
          <div class="captcha-tile-check">${SVG_ICONS.check}</div>
          ${SVG_ICONS[tile.icon]}
          <span class="tile-label">${tile.label}</span>
        </div>
      `;
    });

    captchaContainer.innerHTML = `
      <div class="captcha-header">
        <div class="captcha-title-wrap">${SVG_ICONS.robot} <span>Selección de imágenes</span></div>
        <button type="button" class="btn-reload-captcha" title="Cambiar prueba de seguridad" aria-label="Cambiar prueba">${SVG_ICONS.reload}</button>
      </div>
      <div class="captcha-images-box">
        <div class="captcha-images-instruction">
          Selecciona todas las imágenes que contengan: <strong class="captcha-target-keyword">${target.label}</strong>
        </div>
        <div class="captcha-grid" id="captcha-grid">
          ${tilesHtml}
        </div>
        <button type="button" class="btn-ghost btn-confirm-images" id="btn-confirm-images">
          Confirmar selección de imágenes
        </button>
      </div>
    `;

    const tiles = captchaContainer.querySelectorAll('.captcha-tile');
    const btnConfirm = document.getElementById('btn-confirm-images');
    const btnReload = captchaContainer.querySelector('.btn-reload-captcha');

    btnReload.addEventListener('click', () => renderRandomCaptcha());

    tiles.forEach((t) => {
      t.addEventListener('click', () => {
        const idx = parseInt(t.getAttribute('data-index'), 10);
        if (currentCaptcha.selectedTileIndices.has(idx)) {
          currentCaptcha.selectedTileIndices.delete(idx);
          t.classList.remove('is-selected');
        } else {
          currentCaptcha.selectedTileIndices.add(idx);
          t.classList.add('is-selected');
        }
      });
    });

    const verifySelection = () => {
      const selected = Array.from(currentCaptcha.selectedTileIndices).sort();
      const targets = [...currentCaptcha.targetTileIndices].sort();

      const isMatch =
        selected.length === targets.length &&
        selected.every((val, i) => val === targets[i]);

      if (isMatch) {
        currentCaptcha.solved = true;
        captchaContainer.classList.add('is-verified');
        btnConfirm.textContent = '✓ Imágenes verificadas correctamente';
        btnConfirm.disabled = true;
        btnConfirm.classList.add('is-success');
        hideAlert();
      } else {
        currentCaptcha.solved = false;
        captchaContainer.classList.remove('is-verified');
        showAlert(`Selección incorrecta. Asegúrate de marcar solo las imágenes de ${target.label}.`);
      }
    };

    btnConfirm.addEventListener('click', verifySelection);
  }

  function validateCaptcha() {
    if (!captchaContainer) return { valid: true };

    if (currentCaptcha.type === 'checkbox') {
      if (!currentCaptcha.solved) {
        return { valid: false, error: 'Por favor marca la casilla "No soy un robot" para continuar.' };
      }
      return { valid: true };
    }

    if (currentCaptcha.type === 'math') {
      const input = document.getElementById('captcha-math-input');
      const val = input ? parseInt(input.value, 10) : null;
      if (val !== currentCaptcha.mathAnswer) {
        if (input) markInvalid(input, true);
        return { valid: false, error: 'La respuesta del desafío matemático es incorrecta.' };
      }
      currentCaptcha.solved = true;
      return { valid: true };
    }

    if (currentCaptcha.type === 'images') {
      if (!currentCaptcha.solved) {
        return {
          valid: false,
          error: `Por favor selecciona y confirma las imágenes correspondientes a ${currentCaptcha.targetCategory}.`,
        };
      }
      return { valid: true };
    }

    return { valid: true };
  }

  // ---------------------------------------------------------------------
  // Login limpio
  // ---------------------------------------------------------------------

  const loginForm = document.getElementById('login-form');

  if (loginForm) {
    const identifierInput = document.getElementById('identifier');
    const submit = document.getElementById('submit');

    // Inicializar CAPTCHA aleatorio al cargar
    renderRandomCaptcha();

    // Mensaje de éxito si viene de ser desbloqueado tras el código
    const urlParams = new URLSearchParams(window.location.search);
    const storedMsg = sessionStorage.getItem('login_success_message');
    if (urlParams.get('unlocked') === '1' || storedMsg) {
      showAlert(
        storedMsg ||
          '¡Código verificado con éxito! Tu cuenta ha sido habilitada. Ya puedes ingresar tu contraseña.',
        'success'
      );
      sessionStorage.removeItem('login_success_message');
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    loginForm.addEventListener('input', (event) => {
      if (event.target.matches('input') && !event.target.id.startsWith('captcha')) {
        markInvalid(event.target, false);
        hideAlert();
      }
    });

    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();
      clearFormErrors(loginForm);

      const identifier = (identifierInput ? identifierInput.value : '').trim();
      const password = passwordInput ? passwordInput.value : '';

      if (!identifier) {
        markInvalid(identifierInput, true);
        showAlert('Ingresa tu cédula o correo electrónico.');
        if (identifierInput) identifierInput.focus();
        return;
      }
      if (!password) {
        markInvalid(passwordInput, true);
        showAlert('Ingresa tu contraseña.');
        if (passwordInput) passwordInput.focus();
        return;
      }

      // Validar CAPTCHA aleatorio antes de permitir enviar
      const captchaCheck = validateCaptcha();
      if (!captchaCheck.valid) {
        showAlert(captchaCheck.error);
        return;
      }

      setLoading(submit, true);
      try {
        await api('/api/login', {
          method: 'POST',
          body: JSON.stringify({ identifier, password }),
        });
        showAlert('Sesión iniciada. Redirigiendo...', 'success');
        window.location.assign('/dashboard.html');
      } catch (err) {
        setLoading(submit, false);

        // Si la cuenta fue bloqueada (3 intentos) o ya está en penalización
        if (err.data && (err.data.locked || err.status === 423)) {
          sessionStorage.setItem('locked_identifier', identifier);
          window.location.assign('/lockout.html');
          return;
        }

        showAlert(err.message);
        if (err.status === 401 && passwordInput) {
          markInvalid(passwordInput, true);
          passwordInput.select();
          // Por seguridad, recargar un nuevo reto aleatorio tras intento fallido
          renderRandomCaptcha();
        }
      }
    });
  }

  // ---------------------------------------------------------------------
  // Registro
  // ---------------------------------------------------------------------

  const registerForm = document.getElementById('register-form');

  if (registerForm) {
    const fullNameInput = document.getElementById('fullName');
    const cedulaInput = document.getElementById('cedula');
    const emailInput = document.getElementById('email');
    const submit = document.getElementById('submit');

    registerForm.addEventListener('input', (event) => {
      if (event.target.matches('input')) {
        markInvalid(event.target, false);
        hideAlert();
      }
    });

    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();
      clearFormErrors(registerForm);

      const fullName = (fullNameInput.value || '').trim().replace(/\s+/g, ' ');
      const cedula = (cedulaInput.value || '').trim();
      const email = (emailInput.value || '').trim().toLowerCase();
      const password = passwordInput.value;

      if (!fullName || !NAME_RE.test(fullName)) {
        markInvalid(fullNameInput, true);
        showAlert('Ingresa tu nombre completo (solo letras y espacios).');
        fullNameInput.focus();
        return;
      }
      if (!isValidCedula(cedula)) {
        markInvalid(cedulaInput, true);
        showAlert(
          cedula.length !== 10
            ? 'La cédula debe tener exactamente 10 dígitos.'
            : 'El número de cédula no es válido.'
        );
        cedulaInput.focus();
        return;
      }
      if (!EMAIL_RE.test(email) || email.length > 254) {
        markInvalid(emailInput, true);
        showAlert('Ingresa un email válido.');
        emailInput.focus();
        return;
      }
      if (password.length < 8) {
        markInvalid(passwordInput, true);
        showAlert('La contraseña debe tener al menos 8 caracteres.');
        passwordInput.focus();
        return;
      }
      if (passwordByteLength(password) > 72) {
        markInvalid(passwordInput, true);
        showAlert('La contraseña es demasiado larga.');
        passwordInput.focus();
        return;
      }

      setLoading(submit, true);
      try {
        await api('/api/register', {
          method: 'POST',
          body: JSON.stringify({ fullName, cedula, email, password }),
        });
        showAlert('Cuenta creada. Redirigiendo...', 'success');
        window.location.assign('/dashboard.html');
      } catch (err) {
        setLoading(submit, false);
        if (err.fields) {
          const fieldMap = {
            fullName: fullNameInput,
            cedula: cedulaInput,
            email: emailInput,
            password: passwordInput,
          };
          Object.keys(err.fields).forEach((key) => markInvalid(fieldMap[key], true));
          const firstKey = Object.keys(err.fields)[0];
          if (fieldMap[firstKey]) fieldMap[firstKey].focus();
        }
        showAlert(err.message);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------

  const logoutButton = document.getElementById('logout');

  if (logoutButton) {
    const avatar = document.getElementById('avatar');
    const greeting = document.getElementById('greeting');
    const nameEl = document.getElementById('p-name');
    const cedulaEl = document.getElementById('p-cedula');
    const emailEl = document.getElementById('p-email');
    const createdEl = document.getElementById('p-created');

    function initials(name) {
      return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join('');
    }

    function formatDate(value) {
      if (!value) return '—';
      const date = new Date(String(value).replace(' ', 'T') + 'Z');
      if (Number.isNaN(date.getTime())) return value;
      return new Intl.DateTimeFormat('es-EC', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(date);
    }

    api('/api/me')
      .then(({ user }) => {
        const name = user.fullName || user.cedula;
        greeting.textContent = `Hola, ${name}`;
        if (avatar) avatar.textContent = initials(name) || '--';
        if (nameEl) nameEl.textContent = name;
        if (cedulaEl) cedulaEl.textContent = user.cedula || '—';
        if (emailEl) emailEl.textContent = user.email || '—';
        if (createdEl) createdEl.textContent = formatDate(user.createdAt);
      })
      .catch((err) => {
        if (err.status === 401) {
          window.location.replace('/login.html');
          return;
        }
        showAlert(err.message);
      });

    logoutButton.addEventListener('click', async () => {
      logoutButton.disabled = true;
      hideAlert();
      try {
        await api('/api/logout', { method: 'POST' });
        window.location.assign('/login.html');
      } catch (err) {
        logoutButton.disabled = false;
        showAlert(err.message);
      }
    });
  }
})();
