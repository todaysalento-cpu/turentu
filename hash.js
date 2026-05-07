import bcrypt from 'bcrypt';

async function genera() {
  const password = 'Admin123!';
  const hash = await bcrypt.hash(password, 10);

  console.log(hash);
}

genera();