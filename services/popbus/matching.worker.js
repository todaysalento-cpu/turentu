// Sostituisce l'orchestrazione legacy: non avviare contemporaneamente i due worker.
export { processaProposteDinamicheV2 as processaProposteDinamiche } from './v2/worker.js';
