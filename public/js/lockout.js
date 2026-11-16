(function () {
  'use strict';

  const viewTimer = document.getElementById('view-timer');
  const timerDisplay = document.getElementById('timer-display');
  const viewRequest = document.getElementById('view-request');
  const btnRequestCode = document.getElementById('btn-request-code');
  const viewVerify = document.getElementById('view-verify');
  const verifyForm = document.getElementById('verify-form');
  const verificationCodeInput = document.getElementById('verification-code');
  const btnVerifyCode = document.getElementById('btn-verify-code');
  const btnResendCode = document.getElementById('btn-resend-code');
  const lockAlert = document.getElementById('lock-alert');
  const lockAlertText = document.getElementById('lock-alert-text');
  const lockTitle = document.getElementById('lock-title');
  const lockSubtitle = document.getElementById('lock-subtitle');
  const targetUserEmail = document.getElementById('target-user-email');
  const sentUserEmail = document.getElementById('sent-user-email');

  let countdownInterval = null;
  let remainingSeconds = 0;
  let registeredUserEmail = '';

  const params = new URLSearchParams(window.location.search);
  let lockedIdentifier =
    sessionStorage.getItem('locked_identifier') ||
    params.get('identifier') ||
    '';

  function hideAlert() {
    if (!lockAlert) return;
    lockAlert.classList.remove('is-visible', 'is-success');
    lockAlert.setAttribute('aria-hidden', 'true');
    if (lockAlertText) lockAlertText.textContent = '';
  }

  function showAlert(text, type) {
    if (!lockAlert || !lockAlertText) return;
    lockAlertText.textContent = text;
    lockAlert.classList.toggle('is-success', type === 'success');
    lockAlert.classList.add('is-visible');
    lockAlert.setAttribute('aria-hidden', 'false');
  }

  function markInvalid(input, invalid) {
    if (!input) return;
    if (invalid) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
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
      error.data = data;
      throw error;
    }
    return data;
  }

  function formatTime(totalSecs) {
    const mins = Math.floor(Math.max(0, totalSecs) / 60);
    const secs = Math.floor(Math.max(0, totalSecs) % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function startCountdown(seconds) {
    if (countdownInterval) clearInterval(countdownInterval);
    remainingSeconds = seconds;
    if (timerDisplay) timerDisplay.textContent = formatTime(remainingSeconds);

    countdownInterval = setInterval(() => {
      remainingSeconds -= 1;
      if (timerDisplay) timerDisplay.textContent = formatTime(remainingSeconds);

      if (remainingSeconds <= 0) {
        clearInterval(countdownInterval);
        countdownInterval = null;
        showRequestStage();
      }
    }, 1000);
  }

  function showRequestStage() {
    if (viewTimer) viewTimer.style.display = 'none';
    if (viewRequest) viewRequest.style.display = 'block';
    if (viewVerify) viewVerify.style.display = 'none';

    if (lockTitle) lockTitle.textContent = 'Penalización concluida';
    if (lockSubtitle) lockSubtitle.textContent = 'Solicita tu código de verificación';

    if (targetUserEmail && registeredUserEmail) {
      targetUserEmail.textContent = registeredUserEmail;
    }

    showAlert(
      'El tiempo de penalización de 15 minutos ha concluido. Ya puedes solicitar tu código de verificación.',
      'success'
    );
  }

  function showVerifyStage() {
    if (viewTimer) viewTimer.style.display = 'none';
    if (viewRequest) viewRequest.style.display = 'none';
    if (viewVerify) viewVerify.style.display = 'block';

    if (lockTitle) lockTitle.textContent = 'Verificar código';
    if (lockSubtitle) lockSubtitle.textContent = 'Ingresa el código enviado a tu correo';

    if (sentUserEmail && registeredUserEmail) {
      sentUserEmail.textContent = registeredUserEmail;
    }

    if (verificationCodeInput) {
      verificationCodeInput.value = '';
      markInvalid(verificationCodeInput, false);
      setTimeout(() => verificationCodeInput.focus(), 100);
    }
  }

  // Comprobar estado inicial del usuario
  async function checkInitialStatus() {
    if (!lockedIdentifier) {
      window.location.replace('/login.html');
      return;
    }

    try {
      const status = await api(
        `/api/lock-status?identifier=${encodeURIComponent(lockedIdentifier)}`
      );

      if (!status.locked) {
        window.location.replace('/login.html');
        return;
      }

      registeredUserEmail = status.email || '';
      if (targetUserEmail && registeredUserEmail) targetUserEmail.textContent = registeredUserEmail;
      if (sentUserEmail && registeredUserEmail) sentUserEmail.textContent = registeredUserEmail;

      if (status.penaltyActive) {
        if (viewTimer) viewTimer.style.display = 'block';
        if (viewRequest) viewRequest.style.display = 'none';
        if (viewVerify) viewVerify.style.display = 'none';
        startCountdown(status.remainingSeconds || 15 * 60);
      } else if (status.requiresVerification) {
        if (status.hasCode) {
          showVerifyStage();
          showAlert(`Ingresa el código de 6 dígitos enviado a tu correo: ${registeredUserEmail}`);
        } else {
          showRequestStage();
        }
      }
    } catch (err) {
      showAlert(err.message);
    }
  }

  if (verificationCodeInput) {
    verificationCodeInput.addEventListener('input', () => {
      const clean = verificationCodeInput.value.replace(/\D/g, '').slice(0, 6);
      if (clean !== verificationCodeInput.value) verificationCodeInput.value = clean;
      markInvalid(verificationCodeInput, false);
      hideAlert();
    });
  }

  // Solicitar código de verificación tras los 15 minutos
  if (btnRequestCode) {
    btnRequestCode.addEventListener('click', async () => {
      setLoading(btnRequestCode, true);
      hideAlert();
      try {
        const res = await api('/api/request-verification', {
          method: 'POST',
          body: JSON.stringify({ identifier: lockedIdentifier }),
        });
        setLoading(btnRequestCode, false);

        if (res.email) {
          registeredUserEmail = res.email;
          if (sentUserEmail) sentUserEmail.textContent = res.email;
        }

        showVerifyStage();

        if (res.emailSent) {
          showAlert(
            `¡Código enviado! Revisa la bandeja de entrada o spam de tu correo: ${registeredUserEmail}`,
            'success'
          );
        } else if (res.devCode) {
          // Si SMTP no está configurado, informar el motivo y mostrar código en desarrollo
          showAlert(
            `Aviso: Para recibir correos reales debes configurar la contraseña de aplicación de Gmail (SMTP_PASS) en el archivo .env. Código generado para pruebas: ${res.devCode}`
          );
        } else {
          showAlert(res.message || 'Código generado. Revisa tu correo.', 'success');
        }
      } catch (err) {
        setLoading(btnRequestCode, false);
        showAlert(err.message);
      }
    });
  }

  // Validar código de verificación de 6 dígitos
  if (verifyForm) {
    verifyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();

      const code = (verificationCodeInput ? verificationCodeInput.value : '').trim();
      if (!code || code.length !== 6) {
        markInvalid(verificationCodeInput, true);
        showAlert('Ingresa el código completo de 6 dígitos.');
        if (verificationCodeInput) verificationCodeInput.focus();
        return;
      }

      setLoading(btnVerifyCode, true);
      try {
        await api('/api/verify-code', {
          method: 'POST',
          body: JSON.stringify({ identifier: lockedIdentifier, code }),
        });
        setLoading(btnVerifyCode, false);

        sessionStorage.removeItem('locked_identifier');
        sessionStorage.setItem(
          'login_success_message',
          '¡Código verificado con éxito! Tu cuenta ha sido habilitada. Ya puedes ingresar tu contraseña.'
        );
        window.location.assign('/login.html?unlocked=1');
      } catch (err) {
        setLoading(btnVerifyCode, false);
        markInvalid(verificationCodeInput, true);
        showAlert(err.message);
        if (verificationCodeInput) verificationCodeInput.select();
      }
    });
  }

  // Reenviar código
  if (btnResendCode) {
    btnResendCode.addEventListener('click', async () => {
      btnResendCode.disabled = true;
      hideAlert();
      try {
        const res = await api('/api/request-verification', {
          method: 'POST',
          body: JSON.stringify({ identifier: lockedIdentifier }),
        });
        if (res.emailSent) {
          showAlert(`Nuevo código enviado a: ${registeredUserEmail}`, 'success');
        } else if (res.devCode) {
          showAlert(`Nuevo código generado para pruebas: ${res.devCode}`);
        } else {
          showAlert(res.message || 'Código reenviado.', 'success');
        }
      } catch (err) {
        showAlert(err.message);
      } finally {
        setTimeout(() => {
          btnResendCode.disabled = false;
        }, 8000);
      }
    });
  }

  checkInitialStatus();
})();
