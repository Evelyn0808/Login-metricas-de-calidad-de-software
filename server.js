require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const BetterSqlite3Store = require('better-sqlite3-session-store')(session);

const { sendLoginAlertEmail, sendVerificationCodeEmail } = require('./emailService');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Intentos fallidos permitidos antes del bloqueo temporal (3 intentos seguidos).
const FAILED_LOGIN_THRESHOLD = 3;
// Duracion de la penalizacion en minutos (15 minutos).
const LOCKOUT_MINUTES = 15;

app.disable('x-powered-by');
if (IS_PROD) app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    strictTransportSecurity: IS_PROD ? undefined : false,
  })
);
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

app.use(
  session({
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new BetterSqlite3Store({
      client: db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// Limite por IP amplio para no interferir con las pruebas normales del usuario
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes desde esta conexión. Intenta de nuevo en unos minutos.' },
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[\p{L}][\p{L}\s'.-]{1,79}$/u;
const PASSWORD_MAX_BYTES = 72;

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
  const checkDigit = (10 - (total % 10)) % 10;
  return checkDigit === Number(value[9]);
}

function validateRegistration({ fullName, cedula, email, password }) {
  const errors = {};

  if (!fullName || !NAME_RE.test(fullName)) {
    errors.fullName = 'Ingresa tu nombre completo (solo letras y espacios).';
  }
  if (!cedula) {
    errors.cedula = 'El número de cédula es obligatorio.';
  } else if (!/^\d{10}$/.test(cedula)) {
    errors.cedula = 'La cédula debe tener exactamente 10 dígitos.';
  } else if (!isValidCedula(cedula)) {
    errors.cedula = 'El número de cédula no es válido.';
  }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    errors.email = 'Ingresa un email válido.';
  }
  if (!password || password.length < 8) {
    errors.password = 'La contraseña debe tener al menos 8 caracteres.';
  } else if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    errors.password = 'La contraseña es demasiado larga (máximo 72 bytes).';
  }

  return errors;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'No autenticado.' });
}

// -----------------------------------------------------------------------------
// Seguridad: control estricto de 3 intentos fallidos seguidos, penalización 15m
// y solicitud posterior de código de verificación.
// -----------------------------------------------------------------------------

function parseIsoDate(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  if (str.endsWith('Z')) return new Date(str).getTime();
  if (str.includes('T')) return new Date(str.endsWith('Z') ? str : str + 'Z').getTime();
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}

function getUserSecurity(userId) {
  return db.prepare('SELECT * FROM login_security WHERE user_id = ?').get(userId);
}

/**
 * Consulta el estado del bloqueo y penalización de un usuario:
 * - NORMAL: sin bloqueo
 * - PENALTY_ACTIVE: cumpliendo los 15 minutos de penalización
 * - REQUIRES_VERIFICATION: concluyeron los 15 minutos y debe solicitar/verificar código
 */
function checkUserLock(userId) {
  const sec = getUserSecurity(userId);
  if (!sec) return { status: 'NORMAL', isLocked: false };

  const now = Date.now();

  // Si tiene fecha de fin de penalización
  if (sec.locked_until) {
    const lockTime = parseIsoDate(sec.locked_until);
    const remainingMs = lockTime - now;

    if (remainingMs > 0) {
      // Sigue dentro de los 15 minutos de penalización
      return {
        status: 'PENALTY_ACTIVE',
        isLocked: true,
        penaltyActive: true,
        remainingSeconds: Math.ceil(remainingMs / 1000),
        remainingMinutes: Math.ceil(remainingMs / (60 * 1000)),
      };
    }

    // Los 15 minutos de penalización ya pasaron:
    // Debe solicitar y verificar código para volver a intentar
    if (sec.requires_verification === 1) {
      const codeExpiresMs = sec.code_expires_at
        ? parseIsoDate(sec.code_expires_at) - now
        : 0;

      return {
        status: 'REQUIRES_VERIFICATION',
        isLocked: true,
        penaltyActive: false,
        requiresVerification: true,
        hasCode: Boolean(sec.verification_code && codeExpiresMs > 0),
        codeExpiresInSeconds: Math.max(0, Math.ceil(codeExpiresMs / 1000)),
      };
    }
  }

  return { status: 'NORMAL', isLocked: false };
}

/**
 * Registra un intento fallido consecutivo:
 * - Si pasaron más de 15 minutos desde el último intento fallido sin bloquearse, el conteo se reinicia.
 * - Solo al 3er intento fallido seguido se activa el bloqueo de 15 minutos.
 */
function recordFailedAttempt(user) {
  const existing = getUserSecurity(user.id);
  const now = Date.now();

  let attempts = 0;
  if (existing && existing.failed_attempts) {
    // Si el último fallo fue hace más de 15 minutos, se reinicia el conteo de fallos consecutivos
    const lastUpdate = existing.updated_at ? new Date(existing.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
    if (now - lastUpdate < 15 * 60 * 1000) {
      attempts = Number(existing.failed_attempts);
    }
  }

  attempts += 1;

  if (attempts >= FAILED_LOGIN_THRESHOLD) {
    // Exactamente al 3er intento fallido seguido: se activa la penalización de 15 minutos
    const lockUntil = new Date(now + LOCKOUT_MINUTES * 60 * 1000).toISOString();

    if (existing) {
      db.prepare(`
        UPDATE login_security
        SET failed_attempts = ?,
            locked_until = ?,
            requires_verification = 1,
            verification_code = NULL,
            code_expires_at = NULL,
            code_attempts = 0,
            updated_at = datetime('now')
        WHERE user_id = ?
      `).run(attempts, lockUntil, user.id);
    } else {
      db.prepare(`
        INSERT INTO login_security (
          user_id, failed_attempts, locked_until, requires_verification,
          verification_code, code_expires_at, code_attempts, updated_at
        ) VALUES (?, ?, ?, 1, NULL, NULL, 0, datetime('now'))
      `).run(user.id, attempts, lockUntil);
    }

    return {
      locked: true,
      penaltyActive: true,
      attempts,
      remainingSeconds: LOCKOUT_MINUTES * 60,
      remainingMinutes: LOCKOUT_MINUTES,
    };
  }

  // Intento 1 o 2: se guarda sin bloquear
  if (existing) {
    db.prepare(`
      UPDATE login_security
      SET failed_attempts = ?,
          locked_until = NULL,
          requires_verification = 0,
          updated_at = datetime('now')
      WHERE user_id = ?
    `).run(attempts, user.id);
  } else {
    db.prepare(`
      INSERT INTO login_security (user_id, failed_attempts, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(user.id, attempts);
  }

  return {
    locked: false,
    penaltyActive: false,
    attempts,
    remainingAttempts: FAILED_LOGIN_THRESHOLD - attempts,
  };
}

function resetUserSecurity(userId) {
  db.prepare('DELETE FROM login_security WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM failed_attempts WHERE key = ?').run(`user:${userId}`);
}

function generateAndSaveVerificationCode(user) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE login_security
    SET verification_code = ?,
        code_expires_at = ?,
        code_attempts = 0,
        updated_at = datetime('now')
    WHERE user_id = ?
  `).run(code, codeExpiresAt, user.id);

  return { code, codeExpiresAt };
}

function verifySecurityCode(userId, code) {
  const sec = getUserSecurity(userId);
  if (!sec || !sec.verification_code) {
    return { valid: false, error: 'No hay un código de verificación pendiente para esta cuenta. Por favor solicita uno.' };
  }

  const expiry = parseIsoDate(sec.code_expires_at);
  if (Date.now() > expiry) {
    return {
      valid: false,
      expired: true,
      error: 'El código de verificación ha expirado. Por favor solicita un nuevo código.',
    };
  }

  if (String(code).trim() !== String(sec.verification_code).trim()) {
    db.prepare(`
      UPDATE login_security
      SET code_attempts = code_attempts + 1
      WHERE user_id = ?
    `).run(userId);
    return {
      valid: false,
      error: 'Código de verificación incorrecto. Por favor revisa el código enviado a tu correo registrado.',
    };
  }

  // Código correcto: se restablece la cuenta para que pueda ingresar su contraseña
  resetUserSecurity(userId);
  return { valid: true };
}

// -----------------------------------------------------------------------------
// Endpoints de la API
// -----------------------------------------------------------------------------

app.post('/api/register', authLimiter, async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || req.body.full_name || '').trim();
    const cedula = String(req.body.cedula || req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const errors = validateRegistration({ fullName, cedula, email, password });
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Revisa los datos ingresados.', fields: errors });
    }

    const exists = db
      .prepare(
        'SELECT id FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)'
      )
      .get(cedula, email);
    if (exists) {
      return res.status(409).json({ error: 'La cédula o el email ya están registrados.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const info = db
      .prepare(
        'INSERT INTO users (username, email, password_hash, full_name) VALUES (?, ?, ?, ?)'
      )
      .run(cedula, email, passwordHash, fullName);

    req.session.userId = info.lastInsertRowid;
    req.session.username = fullName;
    return res.status(201).json({
      message: 'Cuenta creada.',
      user: { username: cedula, fullName, email },
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
  try {
    const identifier = String(
      req.body.identifier || req.body.cedula || req.body.username || req.body.email || ''
    ).trim();
    const password = String(req.body.password || '');

    if (!identifier || !password) {
      return res
        .status(400)
        .json({ error: 'Ingresa tu cédula o correo electrónico y tu contraseña.' });
    }

    const user = db
      .prepare(
        'SELECT id, username, email, full_name, password_hash FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)'
      )
      .get(identifier, identifier);

    if (!user) {
      // Comparación falsa para mitigar timing attacks
      await bcrypt.compare(password, '$2a$12$0000000000000000000000000000000000000000000000000000');
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    // Comprobar estado de penalización o requerimiento de verificación
    const lockStatus = checkUserLock(user.id);

    if (lockStatus.status === 'PENALTY_ACTIVE') {
      return res.status(423).json({
        error: `Has superado los ${FAILED_LOGIN_THRESHOLD} intentos fallidos seguidos. Tu cuenta está en periodo de penalización de 15 minutos. Debes esperar a que termine el tiempo.`,
        locked: true,
        penaltyActive: true,
        remainingSeconds: lockStatus.remainingSeconds,
        remainingMinutes: lockStatus.remainingMinutes,
        identifier: user.username,
      });
    }

    if (lockStatus.status === 'REQUIRES_VERIFICATION') {
      return res.status(423).json({
        error: 'El tiempo de penalización de 15 minutos ha concluido. Para volver a intentar iniciar sesión, solicita un código de verificación a tu correo registrado.',
        locked: true,
        penaltyActive: false,
        requiresVerification: true,
        hasCode: lockStatus.hasCode,
        codeExpiresInSeconds: lockStatus.codeExpiresInSeconds,
        identifier: user.username,
      });
    }

    // Verificar contraseña
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const result = recordFailedAttempt(user);

      if (result.locked) {
        // Al 3er intento fallido seguido: entra en penalización de 15 minutos
        return res.status(423).json({
          error: `Has fallado la contraseña ${FAILED_LOGIN_THRESHOLD} veces seguidas. Tu cuenta ha sido bloqueada temporalmente por ${LOCKOUT_MINUTES} minutos de penalización.`,
          locked: true,
          penaltyActive: true,
          remainingSeconds: result.remainingSeconds,
          remainingMinutes: result.remainingMinutes,
          identifier: user.username,
        });
      }

      const plural = result.remainingAttempts === 1 ? 'intento' : 'intentos';
      return res.status(401).json({
        error: `Contraseña incorrecta. Intento ${result.attempts} de ${FAILED_LOGIN_THRESHOLD} (te queda ${result.remainingAttempts} ${plural} antes del bloqueo de 15 minutos).`,
        remainingAttempts: result.remainingAttempts,
        attempts: result.attempts,
      });
    }

    // Login correcto: resetear cualquier fallo previo
    resetUserSecurity(user.id);

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.json({ message: 'Sesión iniciada.', user: { username: user.username } });
      });
    });
  } catch (err) {
    next(err);
  }
});

// Endpoint para SOLICITAR el código de verificación una vez concluidos los 15 minutos
app.post('/api/request-verification', authLimiter, async (req, res, next) => {
  try {
    const identifier = String(
      req.body.identifier || req.body.cedula || req.body.username || req.body.email || ''
    ).trim();

    if (!identifier) {
      return res.status(400).json({ error: 'Ingresa tu cédula o correo electrónico.' });
    }

    const user = db
      .prepare(
        'SELECT id, username, email, full_name FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)'
      )
      .get(identifier, identifier);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const sec = getUserSecurity(user.id);
    if (!sec || sec.requires_verification !== 1) {
      return res.status(400).json({ error: 'Tu cuenta no requiere verificación por correo actualmente.' });
    }

    // Comprobar si aún está dentro de los 15 minutos de penalización
    const now = Date.now();
    if (sec.locked_until) {
      const lockTime = parseIsoDate(sec.locked_until);
      const remainingMs = lockTime - now;
      if (remainingMs > 0) {
        return res.status(400).json({
          error: `Aún no terminan los 15 minutos de penalización. Debes esperar ${Math.ceil(remainingMs / 1000)} segundos más.`,
          penaltyActive: true,
          remainingSeconds: Math.ceil(remainingMs / 1000),
        });
      }
    }

    // Generar y guardar código de 6 dígitos
    const { code } = generateAndSaveVerificationCode(user);

    // Enviar código desde metricaslogin@gmail.com hacia el correo registrado del usuario
    const mailResult = await sendVerificationCodeEmail({
      to: user.email,
      fullName: user.full_name || user.username,
      cedula: user.username,
      code,
      minutes: 15,
    });

    return res.json({
      success: true,
      emailSent: Boolean(mailResult.sent),
      email: user.email,
      smtpConfigured: mailResult.error !== 'SMTP_NOT_CONFIGURED',
      smtpMessage: mailResult.message || null,
      devCode: !IS_PROD ? code : undefined,
      message: mailResult.sent
        ? `Se ha enviado el código de verificación a tu correo registrado: ${user.email}`
        : `Código generado. (Aviso: ${mailResult.message})`,
      codeExpiresInSeconds: 900,
    });
  } catch (err) {
    next(err);
  }
});

// Endpoint para validar el código de 6 dígitos
app.post('/api/verify-code', authLimiter, (req, res, next) => {
  try {
    const identifier = String(
      req.body.identifier || req.body.cedula || req.body.username || req.body.email || ''
    ).trim();
    const code = String(req.body.code || '').trim();

    if (!identifier) {
      return res.status(400).json({ error: 'Ingresa tu cédula o correo electrónico.' });
    }
    if (!code) {
      return res.status(400).json({ error: 'Ingresa el código de verificación de 6 dígitos.' });
    }

    const user = db
      .prepare(
        'SELECT id, username, email, full_name FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)'
      )
      .get(identifier, identifier);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const verification = verifySecurityCode(user.id, code);
    if (!verification.valid) {
      return res.status(400).json({
        error: verification.error,
        expired: Boolean(verification.expired),
      });
    }

    return res.json({
      success: true,
      message: '¡Código verificado con éxito! Tu cuenta ha sido habilitada. Ya puedes iniciar sesión con tu contraseña.',
      identifier: user.username,
    });
  } catch (err) {
    next(err);
  }
});

// Endpoint para consultar estado de bloqueo / penalización
app.get('/api/lock-status', (req, res) => {
  const identifier = String(req.query.identifier || req.query.cedula || '').trim();
  if (!identifier) return res.json({ locked: false });

  const user = db
    .prepare(
      'SELECT id, username, email FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)'
    )
    .get(identifier, identifier);

  if (!user) return res.json({ locked: false });

  const status = checkUserLock(user.id);
  return res.json({
    locked: status.isLocked,
    penaltyActive: status.status === 'PENALTY_ACTIVE',
    requiresVerification: status.status === 'REQUIRES_VERIFICATION',
    remainingSeconds: status.remainingSeconds || 0,
    remainingMinutes: status.remainingMinutes || 0,
    hasCode: status.hasCode || false,
    codeExpiresInSeconds: status.codeExpiresInSeconds || 0,
    email: user.email,
    identifier: user.username,
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'No se pudo cerrar la sesión.' });
    res.clearCookie('sid', { httpOnly: true, sameSite: 'lax', secure: IS_PROD });
    return res.json({ message: 'Sesión cerrada.' });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db
    .prepare('SELECT id, username, email, full_name, created_at FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'No autenticado.' });

  res.json({
    user: {
      id: user.id,
      cedula: user.username,
      email: user.email,
      fullName: user.full_name || user.username,
      createdAt: user.created_at,
    },
  });
});

function pageGuard(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.redirect('/login.html');
}

function guestOnly(req, res, next) {
  if (req.session && req.session.userId) return res.redirect('/dashboard.html');
  return next();
}

app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/login.html', guestOnly, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);
app.get('/register.html', guestOnly, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'register.html'))
);
app.get('/lockout.html', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'lockout.html'))
);
app.get('/dashboard.html', pageGuard, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ruta no encontrada.' });
  }
  return res.status(404).send('Página no encontrada.');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
