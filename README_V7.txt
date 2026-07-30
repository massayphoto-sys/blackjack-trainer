BLACKJACK TRAINER v7.0 — DATA INTEGRITY FOUNDATION

OBJETIVO
Crear una base confiable para reconstruir sesiones, zapatos, manos, decisiones y errores.

IMPLEMENTADO
- Event store inmutable en el navegador.
- UUID para sesión, dispositivo y cada evento.
- Secuencia cronológica de eventos.
- Snapshots automáticos al ocultar/cerrar la aplicación.
- Recuperación de estado local.
- Auditoría de secuencia, IDs y estructura de eventos.
- Registro de errores JavaScript y cambios de conexión.
- Registro de entorno: dispositivo, resolución, orientación y versión.
- Migración defensiva de historiales anteriores.
- Exportación de datos completos en JSON.
- Exportación independiente del event store.
- Panel de integridad visible dentro de la aplicación.
- Compatible con Vercel y PWA.

LIMITACIÓN IMPORTANTE
Esta versión continúa funcionando sin servidor de base de datos.
Los datos permanecen en el navegador del dispositivo.
Supabase y las cuentas de usuario se incorporarán en una versión posterior,
cuando se configuren las credenciales del proyecto.

PRUEBA RECOMENDADA
1. Publicar en Vercel.
2. Jugar un zapato completo.
3. Ejecutar auditoría.
4. Exportar datos completos.
5. Verificar que el JSON contenga eventos, snapshot y estado del juego.

DESPLIEGUE
Sube el contenido del ZIP a un repositorio o reemplaza los archivos del proyecto
actual en Vercel. Framework Preset: Other. Sin Build Command.
