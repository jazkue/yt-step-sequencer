# YouTube Step Sequencer

Extensión de Chrome que reproduce un patrón de ocho números sobre un video de
YouTube, enviando al reproductor los mismos eventos de teclado que corresponden
a las teclas del 0 al 9. YouTube determina a qué punto del video salta cada tecla.

## Instalación

1. Abrí `chrome://extensions` en Chrome.
2. Activá **Modo de desarrollador**.
3. Elegí **Cargar descomprimida** y seleccioná la carpeta de este proyecto.
4. Abrí o recargá un video en `youtube.com/watch` y hacé clic en el icono de la
   extensión. Se abre una ventana independiente vinculada a esa pestaña.
   Si querés, podés fijar el icono desde el menú de extensiones.

## Uso

- Escribí un número del **0 al 9** en cada uno de los ocho pasos y un BPM entero
  entre **1 y 999**.
- Presioná el botón **Play** (triángulo): el primer paso se ejecuta inmediatamente y los siguientes
  avanzan a razón de un paso por pulso. Después del octavo, el patrón se repite.
- Play también inicia el video si está pausado. El mismo botón cambia a
  **Stop** (cuadrado) y detiene la secuencia sin pausar el video. Si Chrome
  bloquea la reproducción, iniciá el video con los controles de YouTube.
- Podés editar los pasos y el BPM mientras corre la secuencia. Los pasos se
  actualizan para su próxima ejecución; el cambio de BPM ajusta el tiempo
  restante hasta el próximo pulso sin reiniciar el patrón.
- Los botones **−** y **+** ajustan el BPM de a uno, entre 1 y 999.
- **Randomize** genera ocho pasos aleatorios sin cambiar el BPM. También se
  puede usar durante la reproducción, sin reiniciar la secuencia.
- Al presionar Enter en el campo de BPM, el cambio se aplica sin iniciar ni
  detener la secuencia.
- Seleccioná un paso y tocá un pad o una tecla numérica para escucharlo y
  asignarlo a ese paso. **Next** o Enter avanza al siguiente (del último vuelve
  al primero y comienza a reproducir la secuencia si estaba detenida); Escape
  deja de seleccionar el paso. Si ya estaba sonando, continúa sin reiniciarse.
  El paso seleccionado se marca independientemente del paso que está sonando.
- Los diez pads permiten saltar en vivo, con clic o con las teclas **1–9 y 0**
  mientras la ventana del secuenciador tiene el foco. Al editar BPM no se activan
  pads. Sin un paso seleccionado podés tocar libremente sin modificar el patrón. Podés usar
  los pads con la secuencia en marcha o detenida.
- Los cambios válidos se guardan en Chrome. Mientras un campo esté incompleto
  o sea inválido, se mantiene su último valor válido en la secuencia.
- Podés cerrar la ventana de la extensión: la secuencia sigue en esa pestaña.
  Se detiene al cambiar de video, salir de la página o recargarla. Cada pestaña
  puede tener su propia secuencia. Para controlar otra pestaña, abrí la ventana
  desde el icono de la extensión en esa pestaña.

La extensión necesita un video normal de YouTube abierto en la pestaña activa.
No funciona en páginas externas con videos insertados ni en Shorts. Como usa
eventos de teclado sintéticos, su funcionamiento depende de que YouTube siga
aceptándolos. Chrome también puede retrasar temporizadores en pestañas en segundo
plano, por lo que la precisión rítmica no está garantizada.

## Pruebas

Con [Deno](https://deno.com/) instalado, ejecutá `deno test --allow-read tests/`.
