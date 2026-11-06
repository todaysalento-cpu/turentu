import 'dotenv/config';

export function readJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (!secret || !secret.trim() || secret === 'segreto-di-test') {
    throw new Error('JWT_SECRET obbligatorio: configurare un segreto privato');
  }
  return secret;
}

export const JWT_SECRET = readJwtSecret();
