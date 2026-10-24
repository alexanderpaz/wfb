## Objetivo

<!-- Qué resuelve este PR, en una o dos frases. -->

## Fase / tarea del plan

<!-- p. ej. Fase 1 · Agente Auth (f1-auth) -->

## Cambios

-

## Cómo probar

<!-- Comandos, usuarios de prueba, pasos en la UI o el preview de Coolify. -->

## Impacto en el contrato (`packages/contracts`)

- [ ] Sin cambios
- [ ] Cambios compatibles (se agregan campos o rutas)
- [ ] Cambios incompatibles (explicar y enlazar el PR de contrato)

## Dependencias

<!-- PRs que deben mergearse antes que este. -->

## Checklist de seguridad

- [ ] Toda ruta nueva exige autenticación (`requireUser`) y verifica permisos de la share
- [ ] Las rutas de archivos pasan por la resolución segura (sin path traversal ni symlinks fuera de la share)
- [ ] Las operaciones que modifican estado exigen CSRF
- [ ] No se registran secretos ni contraseñas en logs
- [ ] Tests incluidos (casos positivos y de permisos negados)
