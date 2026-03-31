import express from 'express';
import cookieParser from 'cookie-parser';
import { router as authRouter } from './routes/auth.routes.js'; // import named export "router"
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/auth', authRouter);

// Root test
app.get('/', (req, res) => {
  res.send('Server attivo ✅');
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server in ascolto su http://localhost:${PORT}`);
});