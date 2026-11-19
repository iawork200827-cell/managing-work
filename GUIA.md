# Comanda QR: guía para ponerla en internet

App para tu negocio con cinco versiones:

- **Mesa** (QR de cada mesa, con clave secreta): cuenta abierta por mesa. Solo quien escanea el QR de la mesa puede abrir la cuenta; los demás de la mesa se unen con el **código de mesa** de 6 letras que aparece en el celular de quien la abrió. Piden por rondas y separan cada ronda en **platos** (Plato 1, Plato 2…) para servirlos como quieran. Todo va a una sola cuenta que se paga al final. Pueden **pedir la cuenta** desde el celular.
- **Para llevar** (`/llevar`, en el local): pedido con nombre; el cliente ve **cuántos pedidos tiene delante** y el **tiempo estimado**. Se paga al recoger.
- **Pedir desde casa** (`/casa`): domicilio gratis (se puede apagar) o recoger. **Se paga antes por transferencia**: el pedido no entra a cocina hasta que el dueño confirma el pago en el panel. Los datos bancarios se ponen en Panel → Ajustes.
- **Empleados** (`/empleados`, QR de empleados + PIN): toman pedidos de mesa (abren cuentas o agregan a las abiertas), para llevar o por teléfono, cobran y cierran cuentas, confirman pagos desde casa y ven la cocina. No ven las ventas. El PIN se pone en Panel → Ajustes; al cambiarlo, todos los empleados tienen que volver a entrar.
- **Encargado** (QR de empleados + PIN de encargado): entra al mismo panel que el dueño, pero no ve las ventas ni cambia los PIN.
- **Barra**: funciona como otra mesa con su propio QR; cada persona puede tener su cuenta o compartirla con el código.
- **Uber Eats / DiDi Food**: en la página de empleados se capturan con su número de pedido; entran a cocina con su etiqueta y en Ventas se ve cuánto vendió cada plataforma y lo que te queda después de la comisión (se configura en Ajustes).
- **Administrador** (`/panel`): pedidos con su tiempo (5–10 min según el tamaño) y el tiempo real que tardaron, mesas abiertas para cobrar y cerrar, productos **agotados** con un toque, botón para **cerrar pedidos por hoy** (se abre solo al día siguiente) y códigos QR para imprimir.

---

## Paso 1. Crear el proyecto en Firebase (en el navegador)

Entra a **https://console.firebase.google.com** con tu cuenta de Google.

1. **Crear proyecto** → ponle el nombre de tu negocio → desactiva Google Analytics → Crear.
   Anota el **ID del proyecto** (aparece debajo del nombre, por ejemplo `taqueria-lupita-1a2b3`).
2. En la página principal del proyecto haz clic en el ícono **`</>`** (Web) → ponle un nombre → **Registrar app**.
   Copia el bloque `firebaseConfig` que aparece. No marques "Firebase Hosting" ahí; lo hacemos después.
3. Menú izquierdo → **Compilación → Firestore Database** → **Crear base de datos** → elige la ubicación más cercana a tu país (no se puede cambiar después) → **Modo de producción**.
4. Menú izquierdo → **Compilación → Authentication** → **Comenzar** → activa **Correo electrónico/contraseña** → Guardar.
5. En **Authentication → Usuarios** → **Agregar usuario** → tu correo y una contraseña segura. Con eso entras al panel.

## Paso 2. Poner tus datos en el código

> Si me mandas el ID del proyecto, el bloque `firebaseConfig` y tu correo, **yo hago este paso por ti**. Nunca me mandes tu contraseña.

Son 3 archivos:

| Archivo | Qué cambiar |
|---|---|
| `public/js/firebase-config.js` | Pega tu `firebaseConfig` y pon tu correo en `OWNER_EMAILS` |
| `firestore.rules` | Cambia `TU_CORREO@ejemplo.com` por tu correo |
| `.firebaserc` | Cambia `ID-DE-TU-PROYECTO` por tu ID de proyecto |

## Paso 3. Instalar las herramientas (una sola vez, en tu computadora)

1. Descarga e instala **Node.js** (versión **LTS**) desde https://nodejs.org
2. Abre la **Terminal** (Mac) o **Símbolo del sistema** (Windows) y escribe:
   ```
   npm install -g firebase-tools
   ```

## Paso 4. Publicar

1. En GitHub, abre este repositorio → botón verde **Code** → **Download ZIP** → descomprímelo.
2. Abre la Terminal **dentro de esa carpeta**. En Windows, abre la carpeta, escribe `cmd` en la barra de direcciones y presiona Enter.
3. Escribe:
   ```
   firebase login
   firebase deploy
   ```
4. Al final aparece tu enlace: `Hosting URL: https://tu-proyecto.web.app`. **¡Ya está en internet!**

Cada vez que hagamos cambios, repites el paso 4 (descargar el ZIP nuevo y `firebase deploy`).

## Paso 5. Antes de abrir al público

1. Entra a `https://tu-proyecto.web.app/panel` con tu correo y contraseña.
2. **Ajustes**: nombre del negocio, minutos promedio por orden, moneda y si llevas las órdenes a la mesa.
3. **Productos**: agrega tu menú (o carga el de ejemplo para probar y luego bórralo).
4. **Códigos QR** → **Imprimir códigos**. Si activaste mesas, sale un QR por mesa y el pedido llega con el número de mesa.
5. Haz un pedido de prueba desde tu celular y avánzalo en el panel.
6. En la tablet o celular de la cocina, deja abierto el panel y toca **Activar sonido de pedidos** para que suene cada pedido nuevo.

---

## Preguntas frecuentes

**¿Cuánto cuesta?** El plan gratuito de Firebase (Spark) alcanza para un negocio pequeño o mediano. No pide tarjeta.

**¿Cómo se calcula el tiempo estimado?** (personas delante + 1) × minutos promedio por orden. Cambia los minutos en **Ajustes**.

**¿Un cliente puede ver los pedidos de otros?** No. Solo ve el suyo y cuántos hay en fila, sin nombres. Solo el dueño ve todos los pedidos y cambia productos.

**Olvidé mi contraseña.** En la pantalla de entrada del panel toca **Olvidé mi contraseña**.

**¿Puedo usar mi propio dominio (tunegocio.com)?** Sí: en Firebase → Hosting → **Agregar dominio personalizado**, y sigue las instrucciones.

## Archivos del proyecto

```
public/index.html        Menú del cliente
public/panel.html        Panel del dueño
public/js/menu.js        Lógica del menú, pedido y fila
public/js/panel.js       Lógica del panel
public/js/common.js      Conexión a Firebase y utilidades
public/js/firebase-config.js   ← TUS DATOS VAN AQUÍ
public/css/styles.css    Colores y diseño
firestore.rules          Reglas de seguridad   ← TU CORREO VA AQUÍ
firebase.json            Configuración de publicación
.firebaserc              ID del proyecto      ← TU ID VA AQUÍ
```

## Facturas

Los clientes pueden pedir factura desde su ticket o desde la cuenta de su mesa (RFC, razón social, correo, código postal, régimen fiscal y uso del CFDI). Las solicitudes aparecen en **Panel → Facturas**; cuando la hagas, toca **Marcar hecha**.

## Ventas

En **Panel → Ventas** ves el total del día (y de días anteriores), separado en efectivo, tarjeta y transferencia. Si algo se cobró por error, toca **Anular** y deja de sumar; **Restaurar** lo deshace.
