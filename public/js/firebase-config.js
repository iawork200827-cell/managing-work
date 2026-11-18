// 1) Pega aquí el bloque "firebaseConfig" que te da Firebase
//    (Configuración del proyecto → Tus apps → App web).
//    Estos datos son públicos: no son contraseñas.
export const firebaseConfig = {
  apiKey: "PEGAR_AQUI",
  authDomain: "PEGAR_AQUI",
  projectId: "PEGAR_AQUI",
  storageBucket: "PEGAR_AQUI",
  messagingSenderId: "PEGAR_AQUI",
  appId: "PEGAR_AQUI"
};

// 2) El correo (o correos) de las personas que pueden entrar al panel del dueño.
//    Debe ser el mismo que pusiste en firestore.rules.
export const OWNER_EMAILS = ["TU_CORREO@ejemplo.com"];
