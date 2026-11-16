require('dotenv').config();

const nodemailer = require('nodemailer');

function getTransporter() {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim().replace(/\s+/g, '');

  if (!user || !pass) {
    return null;
  }

  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();

  // Si es Gmail o Google Workspace (ej. yavirac.edu.ec), usar el servicio de Gmail
  if (host.includes('gmail.com') || user.includes('gmail.com') || user.includes('yavirac.edu.ec')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  const port = Number(process.env.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Envía el código de verificación de 6 dígitos al correo del usuario registrado.
 * Remitente: metricaslogin@gmail.com (SMTP_USER / SMTP_FROM).
 * Destinatario: correo registrado del usuario (to).
 */
async function sendVerificationCodeEmail({ to, fullName, cedula, code, minutes = 15 }) {
  const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'metricaslogin@gmail.com';
  const recipient = String(to || '').trim().toLowerCase();

  console.log('\n============================================================');
  console.log(' [SEGURIDAD] CODIGO DE VERIFICACION GENERADO');
  console.log(` Remitente:    ${senderEmail}`);
  console.log(` Destinatario: ${recipient}`);
  console.log(` Cedula:       ${cedula}`);
  console.log(` Codigo:       ${code}`);
  console.log(` Validez:      ${minutes} minutos`);
  console.log('============================================================\n');

  const mailTransporter = getTransporter();
  if (!mailTransporter) {
    const errorMsg =
      'Falta configurar la contraseña de aplicación de Gmail (variable SMTP_PASS en el archivo .env).';
    console.warn(`[AVISO] ${errorMsg} Código para pruebas: ${code}`);
    return {
      sent: false,
      skipped: true,
      code,
      error: 'SMTP_NOT_CONFIGURED',
      message: errorMsg,
    };
  }

  const recipientName = fullName || 'Usuario';
  const safeName = escapeHtml(recipientName);
  const safeCedula = escapeHtml(cedula);

  const mailOptions = {
    from: `"Seguridad de Acceso" <${senderEmail}>`,
    to: recipient,
    subject: `Tu código de verificación de acceso: ${code}`,
    text: `Hola ${recipientName},

Tu periodo de penalización de 15 minutos por intentos fallidos de contraseña ha concluido (Cédula: ${cedula}).

Para poder volver a intentar iniciar sesión, ingresa el siguiente código de verificación de 6 dígitos:
${code}

Este código es válido durante ${minutes} minutos.

Si tú no solicitaste este código, te recomendamos cambiar tu contraseña una vez ingreses a tu cuenta.

Saludos,
Equipo de Seguridad`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; color: #0f172a;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; width: 48px; height: 48px; line-height: 48px; border-radius: 12px; background: #eef2ff; color: #4f46e5; font-size: 24px; font-weight: bold;">
            &#128274;
          </div>
          <h2 style="color: #0f172a; margin: 12px 0 4px; font-size: 22px;">Código de verificación de acceso</h2>
          <p style="color: #64748b; margin: 0; font-size: 14px;">Penalización de 15 minutos finalizada</p>
        </div>

        <p style="font-size: 15px; line-height: 1.5; color: #334155;">Hola <strong>${safeName}</strong>,</p>
        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
          El tiempo de penalización de 15 minutos por haber ingresado la contraseña incorrecta 3 veces en tu cuenta (cédula: <strong>${safeCedula}</strong>) ha finalizado.
        </p>

        <p style="font-size: 14px; color: #475569; margin-top: 18px;">
          Para validar tu identidad y habilitar el inicio de sesión para volver a intentar, ingresa el siguiente código:
        </p>

        <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
          <span style="font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #2563eb; font-family: 'Courier New', Courier, monospace;">${code}</span>
        </div>

        <p style="font-size: 13px; color: #64748b; text-align: center; margin-bottom: 24px;">
          Este código tiene una validez de <strong>${minutes} minutos</strong>.
        </p>

        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />

        <p style="font-size: 12px; line-height: 1.5; color: #94a3b8; margin: 0;">
          Si tú no realizaste estos intentos, te recomendamos actualizar tu contraseña tan pronto como accedas a tu cuenta.
        </p>
      </div>
    `,
  };

  try {
    const info = await mailTransporter.sendMail(mailOptions);
    console.log(`[EMAIL] Correo enviado exitosamente a ${recipient}: ${info.response || info.messageId}`);
    return { sent: true, code, recipient };
  } catch (err) {
    console.error('[EMAIL ERROR] No se pudo enviar el correo a través de Gmail SMTP:', err.message);
    return {
      sent: false,
      skipped: false,
      code,
      error: err.code || 'SEND_ERROR',
      message: err.message,
    };
  }
}

/**
 * Envía alerta de seguridad cuando se detectan intentos fallidos
 */
async function sendLoginAlertEmail({ to, fullName, cedula }) {
  const mailTransporter = getTransporter();
  const senderEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'metricaslogin@gmail.com';
  const recipient = String(to || '').trim().toLowerCase();

  if (!mailTransporter || !recipient) {
    return { skipped: true };
  }

  const recipientName = fullName || 'Usuario';
  const safeName = escapeHtml(recipientName);

  const mailOptions = {
    from: `"Seguridad de Acceso" <${senderEmail}>`,
    to: recipient,
    subject: 'Alerta de seguridad: intentos fallidos en tu cuenta',
    text: `Hola ${recipientName},

Hemos detectado varios intentos fallidos de contraseña en tu cuenta con cédula ${cedula}.
Si no fuiste tú, alguien podría estar intentando acceder. Te recomendamos cambiar tu contraseña.

Saludos,
Equipo de Seguridad`,
    html: `<p>Hola ${safeName},</p>
<p>Hemos detectado varios intentos fallidos de contraseña en tu cuenta con cédula <strong>${escapeHtml(cedula)}</strong>.</p>
<p>Si no fuiste tú, alguien podría estar intentando acceder. Te recomendamos cambiar tu contraseña.</p>
<p>Saludos,<br>Equipo de Seguridad</p>`,
  };

  try {
    const info = await mailTransporter.sendMail(mailOptions);
    console.log(`[EMAIL] Alerta de seguridad enviada a ${recipient}: ${info.response || info.messageId}`);
    return { sent: true };
  } catch (err) {
    console.error('[EMAIL ERROR] Error enviando alerta:', err.message);
    return { skipped: true, error: err.message };
  }
}

module.exports = {
  sendVerificationCodeEmail,
  sendLoginAlertEmail,
};
