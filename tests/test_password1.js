import bcrypt from 'bcryptjs';

const hash = '$2a$10$YVh1rVYq6XhZxgQk6T0qhu0j2rZxw7X6jB/FjvXrYls5M.Z3S.U2W';
const password = 'prova123'; // quella che digiti nel login

bcrypt.compare(password, hash).then(console.log);
