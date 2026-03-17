// api/index.js
import server from '../server.js'; // importa il tuo Express completo

// Vercel richiede default export di una funzione (req, res)
export default function handler(req, res) {
  // Express può gestire direttamente la richiesta
  server(req, res);
}