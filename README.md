# Blackjack Trainer v9 — Auth Foundation

Esta versión contiene únicamente la base de autenticación con Supabase.

## Archivos

- `index.html`: interfaz de acceso.
- `css/styles.css`: estilos responsivos.
- `js/config.js`: URL y clave pública de Supabase.
- `js/supabase.js`: cliente y diagnóstico de salud.
- `js/auth.js`: Magic Link, sesión y logout.
- `js/app.js`: interfaz y estados.
- `vercel.json`: despliegue estático sin caché.

## Probar localmente

No abras `index.html` directamente con doble clic. Los módulos JavaScript necesitan un servidor local.

En VS Code, usa la extensión Live Server y abre el proyecto con **Open with Live Server**.

También puedes ejecutar:

```bash
python -m http.server 5500
```

Luego abre `http://localhost:5500`.

## Supabase

En Authentication → URL Configuration deben estar autorizadas:

- La URL principal de Vercel.
- La URL de preview que uses para probar.
- `http://localhost:5500` para pruebas locales.

## Publicar en la rama actual

1. Sustituye el contenido del repositorio por estos archivos.
2. Conserva la rama `v8-supabase-auth` durante la prueba.
3. Commit sugerido: `v9.0 - Clean Supabase auth foundation`.
4. Push a GitHub.
5. Espera el despliegue de Vercel.
6. Abre el diagnóstico técnico antes de enviar el Magic Link.

## Alcance

Esta versión no contiene blackjack, Service Worker, manifest ni almacenamiento de manos. Ese código se integrará solo después de verificar que el Magic Link, la persistencia y el logout funcionan correctamente.
