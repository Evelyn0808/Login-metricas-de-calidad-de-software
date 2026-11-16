# login-app

Aplicación de login 100% funcional con Node.js + Express, SQLite, contraseñas hasheadas (bcrypt), sesiones con cookie y rutas protegidas. La interfaz replica el diseño de Figma y está en español.

## Requisitos

- Node.js 22 o superior (probado con Node 24)
- npm

## Cómo correrla

```powershell
npm install
npm start
```

Abre http://localhost:3000

El archivo `.env` ya se creó a partir de `.env.example`. En producción cambia `SESSION_SECRET` por un valor largo y aleatorio.

> **Nota sobre `better-sqlite3`:** se usa la versión 13.x porque las versiones 11.x fallaban al cerrar el proceso con Node 24 (`Assertion failed: (env) != nullptr`).

## Uso

1. Entra a **Regístrate** y crea una cuenta con:
   - Nombre completo
   - **Número de cédula** (10 dígitos, cédula ecuatoriana válida)
   - Email
   - Contraseña de mínimo 8 caracteres
2. Al registrarte se inicia la sesión y te redirige al panel **Mi cuenta**.
3. Cierra sesión y vuelve a entrar con tu cédula y contraseña.

Cédula de ejemplo válida para pruebas: `1712345675`.

El login acepta la cédula (también el email o el nombre de usuario antiguo, para compatibilidad).

## Estructura

```
login-app/
  server.js              API, validaciones y servidor Express
  db.js                  Conexión SQLite (crea data/app.db) y migraciones
  emailService.js        Envío de alertas de seguridad por email (SMTP/Gmail)
  public/
    login.html           Formulario de inicio de sesión
    register.html        Formulario de registro
    dashboard.html       Página protegida (solo con sesión)
    css/styles.css       Estilos (diseño de Figma)
    js/auth.js           Lógica del cliente
    favicon.svg          Icono de la app
  .env / .env.example    Variables de entorno
  data/app.db            Base de datos (se genera sola)
```

## Endpoints

| Método | Ruta                | Descripción                                      |
|--------|---------------------|--------------------------------------------------|
| POST   | `/api/register`     | Crea la cuenta e inicia sesión                   |
| POST   | `/api/login`        | Inicia sesión con cédula (o email/usuario)       |
| POST   | `/api/verify-code`  | Valida código de verificación de 6 dígitos       |
| POST   | `/api/resend-code`  | Reenvía código de verificación al correo         |
| GET    | `/api/lock-status`  | Consulta estado de bloqueo temporal              |
| POST   | `/api/logout`       | Cierra la sesión                                 |
| GET    | `/api/me`           | Datos del usuario autenticado                    |

Páginas: `/login.html`, `/register.html` y `/dashboard.html` (protegida). `/` redirige a login.

### Ejemplo con curl

```powershell
curl -c cookies.txt -H "Content-Type: application/json" `
  -d '{"fullName":"Ana María López","cedula":"1712345675","email":"ana@demo.com","password":"Password123"}' `
  http://localhost:3000/api/register

curl -b cookies.txt http://localhost:3000/api/me
```

## Validaciones

- **Cédula ecuatoriana:** exactamente 10 dígitos, provincia válida (01–24 o 30), tercer dígito menor a 6 y dígito verificador con algoritmo módulo 10. Se valida en cliente y servidor.
- **Nombre completo:** solo letras, espacios, apóstrofes, puntos y guiones (máx. 80).
- **Email:** formato válido y máximo 254 caracteres.
- **Contraseña:** mínimo 8 caracteres y máximo 72 bytes (límite de bcrypt).

## Seguridad incluida

- Contraseñas con hash bcrypt (12 rondas), nunca en texto plano.
- Sesiones guardadas en SQLite con cookie `httpOnly` y `sameSite=lax`.
- Regeneración del ID de sesión al iniciar sesión (evita session fixation).
- Validación de todos los campos en el servidor (no se confía solo en el cliente).
- Rate limiting en login/registro (20 intentos por 15 min).
- Cabeceras de seguridad con Helmet y CSP que permite solo Google Fonts.
- Respuestas de `/api` con `Cache-Control: no-store`.
- Índices únicos sin distinguir mayúsculas/minúsculas para cédula/email.

## Bloqueo de seguridad y código de verificación (15 minutos)

El flujo de inicio de sesión funciona estrictamente de la siguiente manera:
1. El usuario inicia sesión ingresando su **cédula o correo electrónico** y su contraseña.
2. Si ingresa la contraseña de forma incorrecta **3 veces seguidas**, recién en ese momento se activa el **bloqueo de 15 minutos de penalización**.
3. Durante esos 15 minutos, la cuenta permanece en penalización obligatoria con un temporizador regresivo en vivo.
4. **Una vez que transcurren los 15 minutos de penalización**, el sistema le permite al usuario **solicitar un código de verificación**.
5. El código de 6 dígitos se envía desde el correo remitente (`metricaslogin@gmail.com`) hacia el **correo electrónico registrado** del usuario.
6. Al validar el código, la cuenta queda habilitada para que el usuario pueda volver a ingresar su contraseña.

### Configurar el remitente Gmail SMTP

1. Entra en tu cuenta de Google del correo remitente (`metricaslogin@gmail.com`) y activa la verificación en dos pasos (**2FA**).
2. Crea una **Contraseña de aplicación** para Gmail:
   - Ve a <https://myaccount.google.com/apppasswords>.
   - Selecciona "Correo" como aplicación y "Dispositivo" (ej. "Node.js").
   - Genera y copia la contraseña de 16 caracteres.
3. En el archivo `.env` de la app, configura:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=metricaslogin@gmail.com
   SMTP_PASS=tu.contrasena_de_aplicacion_de_gmail
   SMTP_FROM=metricaslogin@gmail.com
   MAX_FAILED_ATTEMPTS=3
   LOCKOUT_MINUTES=15
   ```

4. Reinicia el servidor.

> **Nota:** si no configuras `SMTP_PASS`, la app funciona igualmente para pruebas locales imprimiendo de forma visible el código en la consola del servidor.

## Variables de entorno

| Variable              | Por defecto               | Descripción                                                  |
|-----------------------|---------------------------|--------------------------------------------------------------|
| `PORT`                | `3000`                    | Puerto del servidor                                          |
| `NODE_ENV`            | `development`             | `development` o `production`                                 |
| `SESSION_SECRET`      | (valor de ejemplo)        | Secreto para firmar la cookie de sesión                      |
| `DB_PATH`             | `data/app.db`             | Ruta opcional de la base de datos SQLite                     |
| `MAX_FAILED_ATTEMPTS` | `3`                       | Intentos fallidos seguidos antes de la penalización de 15 min |
| `LOCKOUT_MINUTES`     | `15`                      | Duración en minutos de la penalización                       |
| `SMTP_HOST`           | `smtp.gmail.com`          | Servidor SMTP remitente                                      |
| `SMTP_PORT`           | `465`                     | Puerto SMTP                                                  |
| `SMTP_USER`           | `metricaslogin@gmail.com` | Correo remitente oficial                                     |
| `SMTP_PASS`           | —                         | Contraseña de aplicación de Gmail                           |
| `SMTP_FROM`           | `metricaslogin@gmail.com` | Dirección que firma el envío                                 |
| `SMTP_FROM`           | `metricaslogin@gmail.com` | Remitente del correo                                    |
