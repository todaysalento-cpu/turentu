import bcrypt from 'bcryptjs';

const password = 'prova1234';
bcrypt.hash(password, 10).then(console.log);
