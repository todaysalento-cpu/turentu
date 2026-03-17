import jwt from 'jsonwebtoken';

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Miwicm9sZSI6ImF1dGlzdGEiLCJlbWFpbCI6Im1hcmlvLnJvc3NpQGV4YW1wbGUuY29tIiwibm9tZSI6Ik1hcmlvIFJvc3NpIiwiaWF0IjoxNzcyODk4MzA4LCJleHAiOjE3NzM1MDMxMDh9.wfOFseAyR1H02mnIhxJtD4K69xsMLgijvqC0F31L_CQ';
const secret = 'segreto-di-test';

try {
  const decoded = jwt.verify(token, secret);
  console.log(decoded);
} catch (err) {
  console.error('Token non valido:', err.message);
}


