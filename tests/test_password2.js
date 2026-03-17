import bcrypt from 'bcryptjs';

const passwordPura = 'PasswordCliente123'; // la password che vuoi assegnare
const salt = await bcrypt.genSalt(10);
const hash = await bcrypt.hash(passwordPura, salt);

console.log(hash); // <-- copia questo hash nel DB
