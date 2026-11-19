// 1) Pega aquí el bloque "firebaseConfig" que te da Firebase
//    (Configuración del proyecto → Tus apps → App web).
//    Estos datos son públicos: no son contraseñas.
export const firebaseConfig = {
  apiKey: "AIzaSyDX5Mxo8GCPhYcI6skV3S6Mk7OI2DiXnYU",
  authDomain: "tacos-josue.firebaseapp.com",
  projectId: "tacos-josue",
  storageBucket: "tacos-josue.firebasestorage.app",
  messagingSenderId: "261662489504",
  appId: "1:261662489504:web:574b20f8c1adef99a082c5"
};

// 2) El correo (o correos) de las personas que pueden entrar al panel del dueño.
//    Debe ser el mismo que pusiste en firestore.rules.
export const OWNER_EMAILS = ["iawork200827@gmail.com"];
