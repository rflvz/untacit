# untacit — Auditoría de privacidad (Fase 6)

> Estado: ejecutada el 2026-07-16 sobre el historial completo del repositorio
> (12 commits, ramas `main` y de trabajo). Entregable de la Fase 6
> (`04-plan-de-fases.md §Fase 6`): «ni un dato de Diseños NT en el historial
> de git».

## Alcance y método

Se auditó **todo el historial de git**, no solo el árbol de trabajo:

```bash
# 1. Inventario de todos los ficheros que han existido en cualquier commit
for c in $(git rev-list --all); do git ls-tree -r --name-only $c; done | sort -u

# 2. Menciones de la organización de dogfood en cualquier versión de cualquier fichero
git grep -il "diseños nt" $(git rev-list --all)

# 3. Secretos y credenciales en todos los diffs del historial
git log --all -p | grep -inE "sk-ant|api[_-]?key\s*[:=]|BEGIN (RSA|OPENSSH)|password\s*[:=]"
```

## Resultados

1. **Ningún dato real de Diseños NT** ha entrado nunca en el historial: ni
   código fuente, ni documentos internos, ni nombres de empleados, clientes,
   proveedores o productos. El inventario completo de ficheros (paso 1) solo
   contiene código del producto, documentación de diseño y el dataset
   sintético de `examples/acme-manufactura`.
2. Las únicas menciones a «Diseños NT» (paso 2) están en los cuatro
   documentos de diseño (`docs/01`–`04`) y en un comentario de test
   (`packages/core/src/validator/index.test.ts`), siempre como **referencia
   al plan de dogfood**, nunca como datos. Es intencional: el plan de fases
   nombra a la organización como banco de pruebas.
3. Los fixtures binarios de test (`packages/extractors/test-fixtures/*.pdf`,
   `*.docx`) son **sintéticos, generados a mano** con contenido de la empresa
   ficticia Acme Manufactura (verificado inspeccionando sus streams).
4. **Sin secretos**: el único match del paso 3 es la línea de código que pasa
   `apiKey` como opción al SDK de Anthropic; no hay ninguna clave literal.

## Conclusión

**No procede reescritura de historia ni repo nuevo.** El historial es apto
para publicación. Los grafos reales generados durante el dogfood viven en su
propio repo de grafo privado (diseño repo-first, `01-vision-prd.md §alcance`)
y nunca han tocado este repositorio.

## Guardarraíles para mantenerlo así

- El repo de grafo de producción es siempre un repositorio git **separado y
  privado**; `untacit init` lo crea fuera de este árbol.
- `.gitignore` excluye `*.db` y artefactos derivados.
- Cualquier ejemplo nuevo en `examples/` debe ser sintético y pasar
  `check.mjs`; la regla de revisión es: ningún nombre real de persona,
  cliente, proveedor o producto de la organización de dogfood.
